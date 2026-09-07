/**
 * A Fellow's task list in the UI (web/src/lib/library/tasks.ts). Small edits with awkward
 * edges: the last task cannot be removed, the cap holds, and "up next" has to survive a
 * resting task sitting where the cursor points.
 */

import { describe, it, expect } from 'vitest'
import { addTask, removeTask, setTask, tasksReady, taskState, type TaskDraft } from '../src/lib/library/tasks.ts'
import type { AgentTask } from '../src/api/types.ts'

const draft = (text: string): TaskDraft => ({ text, kind: 'explore' })
const task = (id: string, state: AgentTask['state'] = 'active'): AgentTask => ({ id, text: id, kind: 'explore', state })

describe('editing the list', () => {
  it('adds up to three and no further', () => {
    let list: TaskDraft[] = [draft('a')]
    list = addTask(list)
    list = addTask(list)
    expect(list).toHaveLength(3)
    expect(addTask(list)).toHaveLength(3)
  })

  it('keeps the last task, because a Fellow without one has nothing to do', () => {
    expect(removeTask([draft('a')], 0)).toHaveLength(1)
    expect(removeTask([draft('a'), draft('b')], 0).map((t) => t.text)).toEqual(['b'])
  })

  it('changes one in place, text or art', () => {
    const list = [draft('a'), draft('b')]
    expect(setTask(list, 1, { kind: 'watch' })[1]).toEqual({ text: 'b', kind: 'watch' })
    expect(setTask(list, 0, { text: 'c' })[0]!.text).toBe('c')
  })

  it('is ready only when every task is actually written', () => {
    expect(tasksReady([draft('a long enough sentence')])).toBe(true)
    expect(tasksReady([draft('a long enough sentence'), draft('  ')])).toBe(false)
    expect(tasksReady([])).toBe(false)
  })
})

describe('what the card says about each task', () => {
  it('marks the one the cursor points at', () => {
    const tasks = [task('t1'), task('t2'), task('t3')]
    expect(tasks.map((t, i) => taskState(t, 1, i, tasks))).toEqual(['waiting', 'up next', 'waiting'])
  })

  it('steps over a resting task, the way the planner does', () => {
    const tasks = [task('t1'), task('t2', 'resting'), task('t3')]
    expect(tasks.map((t, i) => taskState(t, 1, i, tasks))).toEqual(['waiting', 'resting', 'up next'])
  })

  it('wraps, so a cursor at the end points back at the first', () => {
    const tasks = [task('t1'), task('t2')]
    expect(tasks.map((t, i) => taskState(t, 2, i, tasks))).toEqual(['up next', 'waiting'])
  })

  it('says nothing is up next when every task rests', () => {
    const tasks = [task('t1', 'resting'), task('t2', 'resting')]
    expect(tasks.map((t, i) => taskState(t, 0, i, tasks))).toEqual(['resting', 'resting'])
  })
})
