/**
 * Whether a defect finding may be repaired by a bound run at all (TASKS-DEFECT-PATHS 4.5).
 *
 * Two conditions, and they are about different things. The FELLOW one is about a race: a
 * notebook page is written by its Fellow's own settle handling, and a repair landing in the
 * middle of that is a lost update the vault's per-file lock cannot prevent, because the two
 * writes are minutes apart rather than microseconds. The SECTION one is about durability:
 * `renderNotebook` regenerates the page from the run records on every write and preserves
 * exactly four sections verbatim - Intent, Scope, Open Questions and Notes. Plan and Log are
 * rendered fresh. So a repair that lands outside those four is silently undone by the Fellow's
 * next notebook write, whatever the locking did.
 *
 * WITH `AGENTS_ENABLED` OFF THE NOTEBOOKS DO NOT DISAPPEAR. They are vault files - six of them
 * on the live vault - and the validator keeps reporting findings on them. What is gone is the
 * Fellow service, and with it any way to ask the first question. So with the flag off a
 * notebook finding renders as a decision with the reason named, never as a button, and no
 * request goes to a Fellow-only route (hard rule 8).
 */

/** Where a Fellow's notebooks live. A finding outside this is not a notebook finding. */
export const NOTEBOOK_PREFIX = 'wiki/meta/agents/'

/**
 * The rules whose repair lands in a section `renderNotebook` preserves.
 *
 * `open-question-form` repairs the `Open Questions` section, which is carried over verbatim.
 * `quote` and `page-schema` do not: a quotation on a notebook stands in the Log or in a run's
 * own record, and a missing heading is a heading the renderer owns. Those stay decisions on a
 * notebook page and are perfectly repairable anywhere else.
 */
const DURABLE_ON_NOTEBOOK: ReadonlySet<string> = new Set(['open-question-form'])

export type FixBlock = { readonly fixable: true } | { readonly fixable: false; readonly why: string }

export interface NotebookContext {
  /**
   * Which Fellow owns a notebook path, and whether it is RETIRED.
   *
   * Retirement is final in this module - `pause()` and `resume()` both return a retired agent
   * untouched, saying so in as many words - so a retired Fellow has no next notebook write and
   * its page is static. Blocking a repair there would be strictly safe and strictly wrong:
   * measured on the live vault, 3 of the 4 notebook findings stand on retired Fellows' pages,
   * so the guard would have taken the path away from three quarters of the class to protect
   * against a write that can never happen.
   *
   * Undefined when nothing owns the path at all, which is a different thing and stays blocked:
   * a notebook with no owner may belong to a Fellow this process has not loaded.
   */
  readonly ownerOf: (path: string) => { id: string; name: string; retired: boolean } | undefined
  /** Whether that Fellow has a run in flight. Absent = the Fellows are unwired. */
  readonly hasRunInFlight?: (agentId: string) => boolean
  /** True when the Fellows are wired at all. With the flag off this is false. */
  readonly fellowsWired: boolean
}

/**
 * Whether one finding may be handed to a bound run right now.
 *
 * Pages outside `wiki/meta/agents/` are unconditionally fixable as far as this is concerned;
 * whether the RULE has a run is a separate question the route asks first.
 */
export function defectFixBlock(
  finding: { readonly rule: string; readonly path: string },
  ctx: NotebookContext,
): FixBlock {
  if (!finding.path.startsWith(NOTEBOOK_PREFIX)) return { fixable: true }

  // Part two first, because it holds whatever the flag says and needs nothing from the Fellows.
  if (!DURABLE_ON_NOTEBOOK.has(finding.rule)) {
    return {
      fixable: false,
      why:
        `A ${finding.rule} repair on a Fellow's notebook would not last: the notebook is regenerated from the ` +
        'run records on every write, and only Intent, Scope, Open Questions and Notes are carried over. This one ' +
        'is a decision.',
    }
  }
  if (!ctx.fellowsWired || ctx.hasRunInFlight === undefined) {
    return {
      fixable: false,
      why:
        'This page is a Fellow’s notebook, and a repair may only run while that Fellow is idle. The research ' +
        'agents are not enabled here, so there is no way to ask - this is a decision.',
    }
  }
  const owner = ctx.ownerOf(finding.path)
  if (owner === undefined) {
    return {
      fixable: false,
      why: 'This page sits under the Fellows’ notebooks and no active Fellow owns it, so nothing can say whether it is being written.',
    }
  }
  // A retired Fellow writes nothing again, so its notebook is an ordinary page.
  if (owner.retired) return { fixable: true }
  if (ctx.hasRunInFlight(owner.id)) {
    return { fixable: false, why: `${owner.name} has a run in flight; a repair to their notebook waits until it settles.` }
  }
  return { fixable: true }
}
