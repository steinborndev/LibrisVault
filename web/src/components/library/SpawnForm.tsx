/**
 * Spawning a Fellow from the Library's control column (docs/agents/SPEC.md section 5.1,
 * OPEN-21): name, intent, home domain from the registry, model with its cost factor, step,
 * autonomy, and whether the first full run starts now.
 *
 * `prefill.art` is the one field that is not a default but a constraint. The command centre
 * sends it when a shape was chosen, and the service holds the Fellow to it afterwards, so the
 * form fixes the art of every task rather than offering a choice that would be refused.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { PlanStatus, SpawnBody } from '../../api/types.ts'
import { weeklyProjection } from '../../lib/plan.ts'
import { suggestFellowName } from '../../lib/fellowNames.ts'
import { addTask, removeTask, setTask, tasksReady, TASK_HINT, TASK_LABEL, type TaskDraft } from '../../lib/library/tasks.ts'
import { MAX_TASKS, TASK_KINDS } from '../../api/types.ts'
import { Tip } from '../Tip.tsx'
import type { TaskKind } from '../../api/types.ts'

const MODELS: Array<{ key: string; label: string; factor: number }> = [
  { key: 'sonnet-5', label: 'Sonnet 5', factor: 1 },
  { key: 'opus-5', label: 'Opus 5', factor: 2.5 },
  { key: 'fable-5-1', label: 'Fable 5.1', factor: 5 },
]
const STEP_COST: Record<string, number> = { small: 2, standard: 6, deep: 6 }

/**
 * The research lenses while the server's list is still loading: the same closed set as
 * `server/src/pipeline/research-profiles.ts` (the spawn endpoint refuses a key it does not
 * know). Once loaded, the server's list leads, with what each lens reaches for beside it.
 */
const LENSES: Array<{ key: string; label: string; short: string }> = [
  { key: 'broad', label: 'Broad sweep', short: 'every kind of source, the standard loop' },
  { key: 'sota', label: 'State of the art', short: 'the last two years of results' },
  { key: 'patents', label: 'Recent patents', short: 'filings, assignees and claim scope' },
  { key: 'startups', label: 'Startups & funding', short: 'who builds it and who funds it' },
]

export function SpawnForm({ prefill, plan, onDone, onCancel }: { prefill?: Partial<SpawnBody>; plan?: PlanStatus | undefined; onDone: (agentId: string) => void; onCancel: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents })
  const profiles = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles, staleTime: 300_000 })
  const lenses = profiles.data?.profiles.map((p) => ({ key: p.key, label: p.label, short: p.short })) ?? LENSES
  /*
   * Spawned for a shelf (the night shift window, a department's own button), the domain is
   * that shelf and not a choice: a Fellow meant for one department landing in another was a
   * misconfiguration one click away.
   */
  const fixedDomain = prefill?.homeDomain !== undefined && prefill.homeDomain !== ''
  const [form, setForm] = useState<SpawnBody>({ name: '', intent: '', homeDomain: '', model: 'sonnet-5', step: 'standard', autonomy: 'veto', runFirstStep: true, ...prefill })
  /*
   * The quota follows the task count until the user sets one, the way the name follows the
   * domain until they type one. A Fellow works every standing task each night and the run
   * behind each is what this limits, so one a day against three tasks would plan three and
   * carry out one - the number has to move with the list, or the form quietly caps it.
   */
  const [typedQuota, setTypedQuota] = useState(prefill?.quotaRunsPerDay !== undefined)
  /*
   * The name field starts filled, on the domain's own letter (Ada works astronomy). Retired
   * Fellows count as taken: the spawn endpoint refuses a duplicate slug whatever their state.
   * A name the USER typed is never overwritten - only a suggestion is replaced by the next
   * one when the domain changes.
   */
  const takenNames = (agents.data?.fellows ?? []).map((f) => f.agent.name)
  const suggested = suggestFellowName(form.homeDomain, takenNames)
  const [typedName, setTypedName] = useState(prefill?.name !== undefined && prefill.name !== '')
  /*
   * The standing work, one to three. It replaces the single intent (decision 2026-09-07): one
   * sentence made a broad subject both likely and unmeasurable, because the drift score is
   * measured against it. `intent` is still sent - it is the first task's sentence.
   */
  const [tasks, setTasks] = useState<TaskDraft[]>(() =>
    prefill?.tasks && prefill.tasks.length > 0 ? prefill.tasks.map((t) => ({ text: t.text, kind: t.kind })) : [{ text: prefill?.intent ?? '', kind: 'explore' }],
  )
  const name = typedName ? form.name : suggested
  const quota = typedQuota ? (form.quotaRunsPerDay ?? 1) : tasks.length
  /** Set when a shape was chosen: every task takes this art and the picker stands down. */
  const fixedArt: TaskKind | null = form.art !== undefined && form.art !== 'custom' ? form.art : null
  const spawn = useMutation({
    mutationFn: (body: SpawnBody) => api.spawnAgent(body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      void qc.invalidateQueries({ queryKey: ['library-scene'] })
      onDone(res.agent.id)
    },
  })
  const keys = (domains.data?.domains ?? []).map((d) => d.key).filter((k) => k !== 'meta')
  const model = MODELS.find((m) => m.key === form.model) ?? MODELS[0]!
  const monthly = Math.round(STEP_COST[form.step ?? 'standard']! * model.factor * 30 * quota * 10) / 10
  // The week in the plan's own unit once the model is calibrated (section 5.1, A5).
  const weekly = weeklyProjection(plan, { stepUsd: STEP_COST[form.step ?? 'standard']! * model.factor, stepsPerDay: quota, model: form.model ?? 'sonnet-5' })
  return (
    <form
      className="lib-spawn"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() === '' || !tasksReady(tasks) || form.homeDomain === '') return
        const clean = tasks.map((t) => ({ text: t.text.trim(), kind: t.kind }))
        spawn.mutate({ ...form, name: name.trim(), intent: clean[0]!.text, tasks: clean, quotaRunsPerDay: quota })
      }}
    >
      <div className="gp-head">
        <span className="gp-eyebrow">Spawn a Fellow</span>
      </div>
      <label>
        <span className="sp-lbl">
          Name
          <Tip text="Only a handle: what the recap, the notebook page and the figure in the room call this Fellow. The suggestion shares its first letter with the home domain, so a roster reads at a glance - change it to anything you like. Two Fellows cannot share a name." />
        </span>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setTypedName(true)
            setForm({ ...form, name: e.target.value })
          }}
          placeholder={suggested === '' ? 'Ada' : suggested}
          maxLength={40}
          required
        />
      </label>
      <div className="sp-tasks">
        <span className="sp-lbl">
          Standing work
          <Tip text="What this Fellow keeps doing, one to three of them. Each is planned and carried out on its own, and the planner is shown only the one task it is planning - which is what makes the drift score mean something. Each task is one sentence and an art: narrow beats broad, because a wide sentence both invites the Fellow to wander and stops the measurement of that wandering from working. A fourth subject wants a second Fellow, not a longer list: three tasks is already most of a night." />
        </span>
        {tasks.map((t, i) => (
          <div className="sp-task" key={i}>
            <div className="sp-task-head">
              {fixedArt === null ? (
                <select className="select" value={t.kind} onChange={(e) => setTasks(setTask(tasks, i, { kind: e.target.value as TaskDraft['kind'] }))} aria-label={`Art of task ${i + 1}`}>
                  {TASK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {TASK_LABEL[k]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="sp-fixed">{TASK_LABEL[fixedArt]}</span>
              )}
              <Tip text={TASK_HINT[t.kind]} />
              <span className="spacer" />
              {tasks.length > 1 && (
                <button type="button" className="sp-x" onClick={() => setTasks(removeTask(tasks, i))} aria-label={`Remove task ${i + 1}`} title="Remove this task">
                  ×
                </button>
              )}
            </div>
            <textarea
              className="input"
              rows={2}
              value={t.text}
              onChange={(e) => setTasks(setTask(tasks, i, { text: e.target.value }))}
              placeholder={
                t.kind === 'watch'
                  ? 'What to keep an eye on, e.g. newly approved biologics'
                  : t.kind === 'deepen'
                    ? 'The theme whose pages should be built out, e.g. endosomal escape and LNP formulation'
                    : 'The question this Fellow pursues'
              }
              required
            />
          </div>
        ))}
        {tasks.length < MAX_TASKS && (
          <button type="button" className="btn ghost sm" onClick={() => setTasks(addTask(tasks, fixedArt ?? 'explore'))}>
            Add a task
          </button>
        )}
      </div>
      <label>
        <span className="sp-lbl">
          Scope <span className="sp-opt">optional</span>
          <Tip text="Standing notes that qualify every task: what to leave out, which sources to prefer, a period to stay inside. The planner is shown them with each task, and they count towards the drift score alongside the task's own wording - so a scope narrows what the Fellow may propose rather than adding a fourth subject. You can edit it later on the Fellow's notebook page, which is where it lives." />
        </span>
        <textarea
          className="input"
          rows={2}
          value={form.scope ?? ''}
          onChange={(e) => setForm({ ...form, scope: e.target.value })}
          placeholder="e.g. clinical evidence only, nothing preclinical; prefer primary sources"
          maxLength={2000}
        />
      </label>
      <label>
        <span className="sp-lbl">
          Home domain
          <Tip
            text={
              fixedDomain
                ? 'The shelf this Fellow is spawned for. Fixed here, because a Fellow meant for one department must not land in another; spawn from the Library column to choose freely. It bounds its work: candidates come from here, and a deepen task may only build out pages that stand here.'
                : "The department this Fellow belongs to. It bounds its work: candidates come from here, a question about another domain is handed to that domain's Fellow instead of pursued, and a deepen task may only build out pages that stand here. Add more under extra domains after spawning if it should reach further."
            }
          />
        </span>
        {fixedDomain ? (
          <span className="sp-fixed" title="Spawned for this shelf">
            {form.homeDomain}
          </span>
        ) : (
          <select className="select" value={form.homeDomain} onChange={(e) => setForm({ ...form, homeDomain: e.target.value })} required>
            <option value="">choose…</option>
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
      </label>
      <div className="lib-spawn-row">
        <label>
          <span className="sp-lbl">
            Model
            <Tip text="Which model runs the work. The factor is what it costs against the plan compared to Sonnet, so Opus at x2.5 spends a Fellow's daily quota two and a half times as fast. Sonnet is the default for standing work; save Opus for a Fellow whose subject actually rewards it." />
          </span>
          <select className="select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} · x{m.factor}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sp-lbl">
            Largest step
            <Tip text="How big an explore run may get: small keeps every run to a single question, standard and deep let the planner propose a full sweep when a theme is broad enough. It sizes explore work only - a watch task may still sweep and a deepen task still deepens, whatever this says." />
          </span>
          <select className="select" value={form.step} onChange={(e) => setForm({ ...form, step: e.target.value })}>
            <option value="small">small</option>
            <option value="standard">standard</option>
            <option value="deep">deep</option>
          </select>
        </label>
        <label>
          <span className="sp-lbl">
            Lens
            <Tip text="Which kind of source a run reaches for first, said beside each lens in the list. `Broad sweep` is the default and adds nothing to the prompt; the other three weight the search. It shapes where a run looks, never what it is allowed to write." />
          </span>
          {/* One line per lens, "lens - what it reaches for": the words come from the server,
              the same list every run is told. */}
          <select className="select" value={form.lens ?? 'broad'} onChange={(e) => setForm({ ...form, lens: e.target.value })}>
            {lenses.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label} - {l.short}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sp-lbl">
            Autonomy
            <Tip text="Who decides what the Fellow runs. `veto` is the default: the planner proposes at night, you have the morning to say no, and what you leave alone runs. `manual` runs nothing until you approve it, `auto` runs without asking - and a proposal that drifts from its task is never run unapproved, whatever this says." />
          </span>
          <select className="select" value={form.autonomy} onChange={(e) => setForm({ ...form, autonomy: e.target.value })}>
            <option value="manual">manual</option>
            <option value="veto">veto</option>
            <option value="auto">auto</option>
          </select>
        </label>
        <label>
          <span className="sp-lbl">
            Runs a day
            <Tip text="How many runs a day the night shift may spend on this Fellow. It is the ceiling over its standing work: three tasks worked in one night are three runs, so a quota of one leaves two of them for the following nights. It follows the number of tasks until you set it yourself. You can always start a run by hand past this limit - the quota holds back the autopilot, not you." />
          </span>
          <input
            className="input"
            type="number"
            min={0}
            max={24}
            value={quota}
            onChange={(e) => {
              setTypedQuota(true)
              setForm({ ...form, quotaRunsPerDay: Number(e.target.value) })
            }}
          />
        </label>
      </div>
      <label className="lib-spawn-check">
        <input type="checkbox" checked={form.runFirstStep !== false} onChange={(e) => setForm({ ...form, runFirstStep: e.target.checked })} /> Start the first run now
        <Tip text="Runs the first task straight away instead of waiting for tonight's shift. Off means the Fellow is created and stands ready; the planner picks it up in the next night shift." />
      </label>
      <p className="mono-meta">
        About {monthly.toFixed(0)} USD a month at this pace (list price, estimate)
        {weekly.weekPct !== null && plan ? `; about ${weekly.weekPct.toFixed(1)} of the week's ${plan.shares.week} research points` : ''}.
      </p>
      {spawn.error != null && <div className="toast err">{(spawn.error as Error).message}</div>}
      <div className="gx-actions">
        <button className="btn primary sm" type="submit" disabled={spawn.isPending}>
          Spawn
        </button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
