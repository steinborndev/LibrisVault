# Security

LibrisVault runs headless AI agent sessions against documents you did not write. This page
describes what the security model does and — just as importantly — what it does not promise.
The full, binding rules live in `CLAUDE.md` and `SPEC.md` §7–§9.

## The model in one paragraph

The service binds `127.0.0.1` and refuses to start on a non-loopback bind without token auth.
State-changing requests with a foreign `Origin` are rejected (drive-by/CSRF guard). Credentials
live only in the service environment (`~/.config/vault-service/env`, chmod 600) — never in the
repo, database, logs, frontend, or API responses. Agent runs execute inside an OS-level sandbox
(bubblewrap via the Claude Agent SDK) with writes confined to `VAULT_ROOT` and no network access
during ingest; a `PreToolUse` hook adds tool-level policy on top. The sandbox is configured
`failIfUnavailable: true`: if it cannot start, runs fail loudly instead of running unconfined.
One stage earlier, every document converter runs in a jail of its own, and what a converter
produces reaches the agent inside an explicit data fence. One stage later, the optional research
agents widen who may reach the web; see the two sections below.

## Threat model: untrusted documents (prompt injection)

Every ingested file, web page, or pasted text is **untrusted input to an autonomous agent that
writes to your vault**. A malicious document can attempt to instruct the agent ("ignore your
task, do X instead"). The guarantees and their limits:

**What stands between the document and the agent, before the sandbox is reached:**

- **The converters are jailed** (added 2026-09-08). `pdftotext`, `pdfinfo`, `ocrmypdf`, `pandoc`,
  the Office extractors, `exiftool` and `defuddle` each run under bubblewrap with no network, no
  `$HOME`, a read-only system, the one input file and one writable output directory. A hostile
  document meets a parser before it meets an agent, and a memory-safety bug in a parser is a more
  likely way in than a prompt. `yt-dlp` is the documented exception, because fetching is its job.
  A missing bubblewrap fails the conversion rather than running the parser unconfined. In the
  code this is `runConverter` (`server/src/pipeline/preprocess/sandbox.ts`); a converter that
  reaches for `runTool` directly has stepped outside the boundary.
- **What a converter produces is fenced as data** (added 2026-09-13). Extracted text reaches the
  agent inside an explicit boundary that marks it as material to read and never as instructions
  to follow, and text inside it that addresses an assistant is reported to you rather than passed
  on quietly. This is a boundary and a signal, **not a proof**: it raises the cost of an
  injection and makes many attempts visible, and no fence of this kind can promise that a model
  ignores what it reads.

**What the sandbox holds even against a fully hijacked agent:**

- Writes cannot leave `VAULT_ROOT` (OS-enforced, not prompt-enforced).
- Ingest runs have no web egress - a hijacked INGEST run cannot exfiltrate vault contents. Read
  the sentence narrowly: it is true of the run that reads your document, and the research agents
  (below) are runs of a different kind that do reach the web.
- Credentials are not readable: the credential file lives outside the sandbox's write scope and
  the agent environment only carries the one variable the SDK subprocess itself needs.
- A run cannot outlive its timeout; a stuck tool is killed with its whole process group.

**What is explicitly NOT prevented:**

- A malicious document can poison **vault content**: it can make the agent write misleading
  pages, spam `[[wikilinks]]`, or rewrite existing pages within the vault. This is inherent to
  autonomous ingest. The mitigation is versioning, not prevention: every agent run is exactly
  one git commit, so any run's damage is inspectable (`git show`) and revertable (`git revert`).
  Ingest material you have reason to distrust deserves a look at its commit afterwards.
- The dashboard renders vault markdown inertly (React elements only, `http(s)` links only), so
  poisoned content cannot become script execution in your browser — but it can still be
  *misinformation* that you read and believe.

## Threat model: the research agents (`AGENTS_ENABLED`, off by default)

The optional research agents (README, "Research agents") widen the picture in one way that
deserves stating plainly, because the rest of this page was written before they existed.

**They reach the web, and a poisoned page is a path to them.** A Fellow's own research runs have
web egress - that is what they are for. They also read the vault, including pages an earlier
ingest wrote. So there is a chain this model has to name: a hostile document poisons a page, a
Fellow later reads that page, and that Fellow is a run with network access. The ingest sandbox
does not close this, because the two runs are separate; what limits it is that a Fellow reads its
own domains, that its planning run has no web access at all and chooses what runs, that every run
is one revertable commit, and that you see what it did in the morning recap. If you ingest
material you have reason to distrust, the honest advice is the same as everywhere on this page:
look at the commit - and consider whether a Fellow works that domain.

**What does not change.** A Fellow's runs are ordinary agent runs: the same sandbox, the same
write confinement to `VAULT_ROOT`, the same `PreToolUse` hook, the same timeout and process-group
kill. A deepening run is confined further, to the pages it was given and to insertions only,
enforced while it runs. And with `AGENTS_ENABLED` unset none of this exists at all - no schedule,
no routes, no extra runs.

**Outbound requests the SERVICE makes, as opposed to an agent.** Two, and neither is agent
egress. The Telegram bot, if configured. And open-access recovery, which asks `api.openalex.org`,
`api.core.ac.uk` and `www.ebi.ac.uk` whether a legal copy of a paywalled paper exists, sending the
DOI of the document being ingested. That one is **on by default** and is not behind the agents
flag; turn it off under System → Service if no third party should learn which papers you file.

## Operational hardening that the code enforces

- Upload filenames are reduced to a bare basename before staging; a `../`-carrying name cannot
  escape the vault's `.raw/` staging area.
- Incoming files are never executed; a magic-byte check refuses disguised executables; archives
  are not auto-extracted.
- URL ingestion has an SSRF guard: scheme allowlist, private/link-local/loopback address checks
  against the *resolved* addresses, socket pinning against DNS rebinding, and per-hop redirect
  re-validation.
- All shell-outs use `execFile` with argument arrays (no shell interpolation); git receives
  `--` before pathspecs.
- The wiki page API is confined to `VAULT_ROOT/wiki/*.md` and re-checked after `realpath`, so a
  symlink cannot become a read or write primitive outside the vault.
- The optional Telegram bot (SPEC.md §4.3) is outbound-only long polling - no listening port, the
  localhost bind is untouched. Authorization is a numeric user-id allowlist enforced before any
  other handling and fail-closed at startup (a token without an allowlist refuses to start);
  non-allowlisted senders receive no reply, since every accepted message can start a paid agent
  run. The bot token is handled like the Anthropic credential (env file only, redacted in config
  output, never in a logged URL or error). Files received via Telegram enter the same pipeline as
  uploads (basename reduction, magic-byte check, no execution); completion messages carry page
  titles only, never vault content.
- The optional retrieval index (SPEC.md §12.6) is built by running the vault's own scripts as
  child processes, **fully on-machine**: the service never passes the `--allow-egress` flag and
  additionally strips the Anthropic credential from the child environment, so chunk prefixes are
  synthetic (title + lead) and no page content leaves the box. The index is derived data written
  only under `.vault-meta/` and excluded from vault git.
- **Retrieval runs in the service, never inside an agent sandbox** - a deliberate boundary
  decision. The optional rerank stage needs to reach a local ollama and to write an embedding
  cache, neither of which the read-only query profile permits. Instead of granting that profile a
  network hole and a write exception, the service performs retrieval and passes the agent only a
  list of pages to read; the sandbox keeps zero network and zero write access. This matters more
  than it looks: ollama's local API is unauthenticated and can pull models from the internet, so
  exposing it to a potentially prompt-injected run would have created an indirect egress channel.
  LLM-generated chunk prefixes - the one step that *would* send page bodies to the Anthropic API -
  remain a planned, explicitly opt-in, default-off setting.

## Verifying the guarantees yourself

Three of the guarantees rest on behaviour that unit tests cannot observe - a unit test can read a
policy, only a probe shows it is applied - so the repo ships live probes. Run them after any SDK
upgrade or change to the permission, spawn or converter wiring:

```bash
VAULT_ROOT=~/vault npm run permprobe --workspace server   # expects: canary outside vault: blocked
VAULT_ROOT=/tmp/throwaway-vault npm run killprobe --workspace server
npm run preprocprobe                                      # expects: 14 ok, "PASS - the jail holds"
```

`preprocprobe` is read-only and safe against the real vault: it runs the actual converters and
checks that each is refused the credential file, the vault, its own home, the service API and the
internet, and that a write aimed outside its output directory never reaches the host.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's security advisories
("Report a vulnerability" on the repository's Security tab) rather than a public issue.
