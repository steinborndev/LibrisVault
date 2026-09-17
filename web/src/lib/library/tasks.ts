/**
 * A Fellow's standing work in the UI (docs/agents/ideas.md, decision 2026-09-07).
 *
 * The words for the three arts of task, and the small edits the spawn form and the card both
 * make to a list: add, remove, change one. Pure, so the awkward parts - the last task cannot
 * be removed, the cap holds, an empty list is not a Fellow - are under test rather than
 * discovered by clicking.
 */

import type { AgentTask, TaskKind } from '../../api/types.ts'
import { MAX_TASKS } from '../../api/types.ts'

export interface TaskDraft {
  readonly text: string
  readonly kind: TaskKind
}

/** What each art is for, in the words the form uses. */
export const TASK_LABEL: Record<TaskKind, string> = { watch: 'Watch', explore: 'Explore', deepen: 'Deepen' }

export const TASK_HINT: Record<TaskKind, string> = {
  watch: 'Looks for what is new in the field, on the web. Never finished - it comes round again as long as there is something to find.',
  explore: 'Pursues one open question until the library can take it no further. The only art that can be answered and put to rest.',
  deepen: 'Names a theme and builds out the pages the vault already has on it. The pages are chosen fresh each time, so what has been built out falls behind on its own.',
}

/** One line for the card: what this task is, and where it stands. */
export function taskState(task: AgentTask, cursor: number, index: number, tasks: readonly AgentTask[]): 'up next' | 'waiting' | 'resting' {
  if (task.state === 'resting') return 'resting'
  // Whoever the cursor lands on after stepping over the resting ones is up next.
  const n = tasks.length
  for (let step = 0; step < n; step++) {
    const i = ((cursor % n) + n + step) % n
    if (tasks[i]!.state === 'active') return i === index ? 'up next' : 'waiting'
  }
  return 'waiting'
}

/**
 * Adds an empty task, up to the cap. `kind` is the art the new one takes: a Fellow of a fixed
 * art may only hold its own, and offering it an explore row it cannot keep would be a form
 * that invites a refusal.
 */
export function addTask(tasks: readonly TaskDraft[], kind: TaskKind = 'explore'): TaskDraft[] {
  return tasks.length >= MAX_TASKS ? [...tasks] : [...tasks, { text: '', kind }]
}

/** Removes one; the last one stays, because a Fellow without a task has nothing to do. */
export function removeTask(tasks: readonly TaskDraft[], index: number): TaskDraft[] {
  return tasks.length <= 1 ? [...tasks] : tasks.filter((_, i) => i !== index)
}

/** Replaces one in place. */
export function setTask(tasks: readonly TaskDraft[], index: number, patch: Partial<TaskDraft>): TaskDraft[] {
  return tasks.map((t, i) => (i === index ? { ...t, ...patch } : t))
}

/** True when the list can be spawned: at least one task, and every one of them written. */
export function tasksReady(tasks: readonly TaskDraft[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.text.trim().length >= 3)
}
