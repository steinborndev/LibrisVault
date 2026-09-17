/**
 * The agent's own box while a run is in flight (components/RunActivity.tsx), checked against
 * the source like the Research screen's other guards.
 *
 * Three rules, each the kind that erodes quietly: the box shows FOUR log lines, its stages
 * carry no ordinal, and it offers no control it cannot honour - there is no cancel for a
 * maintenance run, so a Stop button here would be a button that lies.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIVITY_LINES } from '../src/components/RunActivity.tsx'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'components', 'RunActivity.tsx'), 'utf8')

describe('the run activity box', () => {
  it('keeps four lines of log', () => {
    expect(ACTIVITY_LINES).toBe(4)
    expect(src).toContain('slice(-ACTIVITY_LINES)')
  })

  it('drops tool results, which are the half of the log that says nothing', () => {
    expect(src).toContain('tool')
    expect(src).toMatch(/const isEvent = .*tool/)
  })

  it('labels each stage under its own segment, without an ordinal', () => {
    expect(src).toContain('className="stage-lbl"')
    // No "1 Plan": the label is the step's short name and nothing else.
    expect(src).not.toMatch(/\{i \+ 1\}/)
    expect(src).toContain("plan: 'Plan'")
  })

  it('offers no Stop, because there is nothing that could honour it', () => {
    expect(src).not.toMatch(/>\s*Stop\s*</)
    expect(src).not.toContain('cancel(')
  })

  it('is on the screen idle as well, at the same shape, so a run starting moves nothing', () => {
    expect(src).toContain("live ? 'Running' : 'Idle'")
    // Idle lights nothing: no stage is done or current, the strip only shows the shape.
    expect(src).toContain("!live ? 'todo'")
  })

  it('shows one dot, before the title, and no stage headline', () => {
    expect(src).toContain("'dot live'")
    expect(src.indexOf("'dot live'")).toBeLessThan(src.indexOf("'Running'"))
    expect(src).not.toContain('Stage ')
  })
})
