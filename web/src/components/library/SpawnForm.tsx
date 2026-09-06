/**
 * Spawning a Fellow from the Library's control column (docs/agents/SPEC.md section 5.1,
 * OPEN-21): name, intent, home domain from the registry, model with its cost factor, step,
 * autonomy, and whether the first full run starts now.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import type { SpawnBody } from '../../api/types.ts'

const MODELS: Array<{ key: string; label: string; factor: number }> = [
  { key: 'sonnet-5', label: 'Sonnet 5', factor: 1 },
  { key: 'opus-5', label: 'Opus 5', factor: 2.5 },
  { key: 'fable-5-1', label: 'Fable 5.1', factor: 5 },
]
const STEP_COST: Record<string, number> = { small: 2, standard: 6, deep: 6 }

export function SpawnForm({ prefill, onDone, onCancel }: { prefill?: Partial<SpawnBody>; onDone: (agentId: string) => void; onCancel: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const [form, setForm] = useState<SpawnBody>({ name: '', intent: '', homeDomain: '', model: 'sonnet-5', step: 'standard', autonomy: 'veto', quotaRunsPerDay: 1, runFirstStep: true, ...prefill })
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
  const monthly = Math.round(STEP_COST[form.step ?? 'standard']! * model.factor * 30 * (form.quotaRunsPerDay ?? 1) * 10) / 10
  return (
    <form
      className="lib-spawn"
      onSubmit={(e) => {
        e.preventDefault()
        if (form.name.trim() === '' || form.intent.trim() === '' || form.homeDomain === '') return
        spawn.mutate({ ...form, name: form.name.trim(), intent: form.intent.trim() })
      }}
    >
      <div className="gp-head">
        <span className="gp-eyebrow">Spawn a Fellow</span>
      </div>
      <label>
        Name
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ada" maxLength={40} required />
      </label>
      <label>
        Intent
        <textarea className="input" rows={3} value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} placeholder="The research question this Fellow keeps pursuing" required />
      </label>
      <label>
        Home domain
        <select className="select" value={form.homeDomain} onChange={(e) => setForm({ ...form, homeDomain: e.target.value })} required>
          <option value="">choose…</option>
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <div className="lib-spawn-row">
        <label>
          Model
          <select className="select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} · x{m.factor}
              </option>
            ))}
          </select>
        </label>
        <label>
          Largest step
          <select className="select" value={form.step} onChange={(e) => setForm({ ...form, step: e.target.value })}>
            <option value="small">small</option>
            <option value="standard">standard</option>
            <option value="deep">deep</option>
          </select>
        </label>
        <label>
          Autonomy
          <select className="select" value={form.autonomy} onChange={(e) => setForm({ ...form, autonomy: e.target.value })}>
            <option value="manual">manual</option>
            <option value="veto">veto</option>
            <option value="auto">auto</option>
          </select>
        </label>
        <label>
          Steps a day
          <input className="input" type="number" min={0} max={24} value={form.quotaRunsPerDay} onChange={(e) => setForm({ ...form, quotaRunsPerDay: Number(e.target.value) })} />
        </label>
      </div>
      <label className="lib-spawn-check">
        <input type="checkbox" checked={form.runFirstStep !== false} onChange={(e) => setForm({ ...form, runFirstStep: e.target.checked })} /> Start the first full run on the intent now
      </label>
      <p className="mono-meta">About {monthly.toFixed(0)} USD a month at this pace (list price, estimate).</p>
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
