/**
 * Settings editor (SPEC.md §6.4 "Einstellungen"): watch folder, concurrency, file limit,
 * git commit behaviour - plus the read-only API-key STATUS. The key itself is never shown:
 * the server only ever sends its source/mode (hard rule 3).
 *
 * Precedence mirrors the server's single model: env/env-file is the start-time baseline, these
 * are runtime overrides, effective = override ?? baseline. Fields bound at startup (watch folder,
 * upload limit) are flagged "Restart required" rather than pretending they took effect live.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import { queryState } from './QueryState.tsx'
import { Tip } from './Tip.tsx'
import { CredentialSetup } from './CredentialSetup.tsx'
import { TelegramSetup } from './TelegramSetup.tsx'
import type { EffectiveSettings, SettingsPatch, SettingsResponse } from '../api/types.ts'

/**
 * What to say when the concurrency field leaves single-writer territory, or null at 1.
 *
 * It quotes the VAULT'S own rule rather than inventing a policy of ours, and names the
 * measurement, because the reader is being asked to decide rather than just to feel warned.
 * Exported so the wording and the threshold can be tested without rendering the whole editor.
 */
export function concurrencyWarning(value: number): string | null {
  // A cleared number field arrives as 0, and a non-numeric one as NaN; neither is a reason to
  // warn, and `NaN <= 1` is false, so the finite check has to come first.
  if (!Number.isFinite(value) || value <= 1) return null
  return (
    'The vault\'s ingest skill is single-writer by design: "Do not run parallel ingests from ' +
    'multiple Claude sessions or sub-agents that assign addresses." Measured at 2: 13 of 31 ' +
    'finished jobs overlapped another one, and the per-file lock does not serialise them.'
  )
}

const MB = 1024 * 1024

/** Labels for the read-only status block. Anything unmapped is hidden. */
const READ_ONLY_LABELS: Record<string, string> = {
  vaultRoot: 'Vault',
  bind: 'Address',
  httpAuthMode: 'HTTP auth',
  authMode: 'Anthropic mode',
  credentialSource: 'Credential source',
  telegram: 'Telegram bot',
}

/**
 * Which half of the settings to render. The System screen shows them as two sections -
 * `service` is the configuration form plus the read-only environment facts, `integrations`
 * is the credential and the bot. `all` keeps the original single-column form.
 */
export type SettingsSection = 'all' | 'service' | 'integrations'

/**
 * The service settings in the groups the System screen lists them under. One editor instance
 * serves every group and stays mounted while you move between them, so an edit in one group
 * survives a look at another, and the save bar counts all of them.
 */
export type SettingsGroup = 'intake' | 'runs' | 'research'

export const SETTINGS_GROUP_OF: Record<keyof EffectiveSettings, SettingsGroup> = {
  watchFolder: 'intake',
  maxUploadBytes: 'intake',
  doiDedupe: 'intake',
  urlDedupe: 'intake',
  oaRecovery: 'intake',
  concurrency: 'runs',
  gitAutoCommit: 'runs',
  dailyBudget: 'runs',
  researchShareWeekPct: 'research',
  researchShare5hPct: 'research',
  reserveWeekPct: 'research',
  reserve5hPct: 'research',
  planName: 'research',
  fiveHourOverrideEnabled: 'research',
  dedupeJudgeEnabled: 'research',
} as Record<keyof EffectiveSettings, SettingsGroup>

const GROUP_LABEL: Record<SettingsGroup, string> = {
  intake: 'Intake',
  runs: 'Runs & budget',
  research: 'Research budget',
}

/** A hint's first sentence stays on the row; the whole text moves behind the ⓘ. */
function splitHint(hint: string): { lead: string; more: boolean } {
  const m = /^(.+?[.!?])\s(.+)$/s.exec(hint)
  return m === null ? { lead: hint, more: false } : { lead: m[1]!, more: true }
}

export function SettingsEditor({
  section = 'all',
  focus = '',
  group,
}: { section?: SettingsSection; focus?: string; group?: SettingsGroup } = {}): React.ReactElement {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [draft, setDraft] = useState<EffectiveSettings | null>(null)
  const [pendingRestart, setPendingRestart] = useState<string[]>([])

  // Seed the draft once the settings arrive; later server responses re-seed it explicitly.
  useEffect(() => {
    if (q.data) setDraft((current) => current ?? q.data.effective)
  }, [q.data])

  /*
   * `?setting=<key>` from elsewhere - the night shift's research budget points at its share.
   * An effect and not an anchor: the screen stays mounted, so arriving a second time would
   * otherwise do nothing, and the form is not in the DOM until the settings have loaded.
   */
  useEffect(() => {
    if (focus === '' || draft === null) return
    const el = document.getElementById(`setting-${focus}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus, draft])

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: (res: SettingsResponse) => {
      qc.setQueryData(['settings'], res)
      setDraft(res.effective)
      setPendingRestart(res.pendingRestart ?? [])
      // A changed watch folder / concurrency shows up in the Overview's queue + watcher stats.
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const state = queryState(q, 'the settings')
  if (state !== null) return state
  if (!q.data || !draft) return <div className="empty">Loading the settings…</div>

  const data = q.data
  // The budget's unit follows the Anthropic auth mode: ingests/day on a subscription (where
  // there is no per-run charge), USD/day with an API key (SPEC.md §7.1).
  const budgetUnit = data.readOnly.authMode === 'oauth' ? 'jobs' : 'usd'
  const keys = Object.keys(draft) as Array<keyof EffectiveSettings>
  const dirty = keys.filter((k) => draft[k] !== data.effective[k])
  const isOverridden = (k: keyof EffectiveSettings): boolean => data.overrides[k] !== undefined
  const needsRestart = (k: keyof EffectiveSettings): boolean => data.restartRequiredKeys.includes(k)

  const submit = (): void => {
    const patch: SettingsPatch = {}
    for (const k of dirty) Object.assign(patch, { [k]: draft[k] })
    save.mutate(patch)
  }

  const row = (
    k: keyof EffectiveSettings,
    label: string,
    hint: string,
    control: React.ReactNode,
  ): React.ReactElement | null => {
    if (group !== undefined && SETTINGS_GROUP_OF[k] !== group) return null
    const { lead, more } = group !== undefined ? splitHint(hint) : { lead: hint, more: false }
    return (
    <div className={`setting${focus === k ? ' focused' : ''}${draft[k] !== data.effective[k] ? ' dirty' : ''}`} key={k} id={`setting-${k}`}>
      <div>
        <div className="setting-label">
          {label}
          {more && <Tip text={hint} />}
          {needsRestart(k) && <span className="setting-tag warn">Restart required</span>}
          {isOverridden(k) && <span className="setting-tag">overridden</span>}
          {draft[k] !== data.effective[k] && <span className="setting-tag dirty">unsaved</span>}
        </div>
        <div className="setting-hint">{lead}</div>
      </div>
      <div className="setting-control">
        {control}
        {isOverridden(k) && (
          <button
            className="btn ghost"
            title="Reset to the value from the environment"
            disabled={save.isPending}
            onClick={() => save.mutate({ [k]: null } as SettingsPatch)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
    )
  }

  if (section === 'integrations') {
    return (
      <div>
        <CredentialSetup configured={data.readOnly['credentialConfigured'] !== 'no'} />
        <TelegramSetup status={data.readOnly['telegram'] ?? 'off'} />
        <div className="settings-ro">
          <div className="settings-ro-row">
            <span className="settings-ro-label">Obsidian</span>
            <code>page links open through the obsidian:// handler</code>
          </div>
        </div>
      </div>
    )
  }

  const dirtyGroups = [...new Set(dirty.map((k) => SETTINGS_GROUP_OF[k]))].filter((g) => g !== undefined)
  const saveBar = (
    <div className={`sys-savebar${dirty.length > 0 ? ' dirty' : ''}`}>
      <span>
        {dirty.length === 0
          ? 'All changes saved'
          : `${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}${
              dirtyGroups.length > 0 ? ` in ${dirtyGroups.map((g) => GROUP_LABEL[g]).join(', ')}` : ''
            }`}
      </span>
      <span className="spacer" />
      {dirty.length > 0 && (
        <button className="btn ghost" disabled={save.isPending} onClick={() => setDraft(data.effective)}>
          Discard
        </button>
      )}
      <button className="btn primary" disabled={dirty.length === 0 || save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : dirty.length > 0 ? `Save (${dirty.length})` : 'Saved'}
      </button>
    </div>
  )

  if (group !== undefined) {
    return (
      <div className="settings-grouped">
        <div className="settings-grid">
          {renderRows()}
        </div>
        {save.isError && <div className="toast err">{(save.error as Error).message}</div>}
        {pendingRestart.length > 0 && (
          <div className="toast warn">
            Saved. {pendingRestart.join(', ')} require{pendingRestart.length === 1 ? 's' : ''} a restart:{' '}
            <code>systemctl --user restart vault-service</code>
          </div>
        )}
        {saveBar}
      </div>
    )
  }

  // The baseline/override explanation lives in the section head's ⓘ tooltip.
  return (
    <div>
      <div className="settings-grid">
        {renderRows()}
      </div>
      <div className="setting-actions">
        <button className="btn primary" disabled={dirty.length === 0 || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : dirty.length > 0 ? `Save (${dirty.length})` : 'Saved'}
        </button>
        {dirty.length > 0 && (
          <button className="btn ghost" disabled={save.isPending} onClick={() => setDraft(data.effective)}>
            Discard
          </button>
        )}
      </div>
      {save.isError && <div className="toast err">{(save.error as Error).message}</div>}
      {pendingRestart.length > 0 && (
        <div className="toast warn">
          Saved. {pendingRestart.join(', ')} require{pendingRestart.length === 1 ? 's' : ''} a restart:{' '}
          <code>systemctl --user restart vault-service</code>
        </div>
      )}
      <h4 className="settings-ro-title">Status (read-only)</h4>
      <div className="settings-ro">
        {Object.entries(READ_ONLY_LABELS).map(([key, label]) =>
          data.readOnly[key] ? (
            <div className="settings-ro-row" key={key}>
              <span className="settings-ro-label">{label}</span>
              <code>{data.readOnly[key]}</code>
            </div>
          ) : null,
        )}
      </div>
      <p className="setting-hint">
        The API key itself is never shown or stored - only its source. The bind address is
        deliberately not changeable through the UI.
      </p>
      {section === 'all' && (
        <>
          <CredentialSetup configured={data.readOnly['credentialConfigured'] !== 'no'} />
          <TelegramSetup status={data.readOnly['telegram'] ?? 'off'} />
        </>
      )}
    </div>
  )

  function renderRows(): React.ReactNode {
    if (draft === null) return null
    return (
      <>
        {row(
          'watchFolder',
          'Watch folder',
          'Folder watched for new files.',
          <input
            type="text"
            value={draft.watchFolder}
            onChange={(e) => setDraft({ ...draft, watchFolder: e.target.value })}
          />,
        )}

        {row(
          'concurrency',
          'Concurrency',
          'Simultaneous ingest runs (1-8). Takes effect immediately.',
          <>
            <input
              type="number"
              min={1}
              max={8}
              value={draft.concurrency}
              onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })}
            />
            {/*
              * Above 1 this leaves what the vault was built for. The warning quotes the vault's
              * own rule rather than inventing a policy of ours, and names what the measurement
              * was, so the reader can decide rather than just feel warned.
              */}
            {concurrencyWarning(draft.concurrency) !== null && (
              <p className="setting-warn" role="status">
                {concurrencyWarning(draft.concurrency)}
              </p>
            )}
          </>,
        )}

        {row(
          'maxUploadBytes',
          'File limit',
          'Maximum upload size per file (MB).',
          <input
            type="number"
            min={1}
            value={Math.round(draft.maxUploadBytes / MB)}
            onChange={(e) => setDraft({ ...draft, maxUploadBytes: Math.max(1, Number(e.target.value)) * MB })}
          />,
        )}

        {/*
          * The research budget (2026-09-14). It was settable only through the API: the night
          * shift's own line now names the share and points here, and a limit you can read but
          * not change is half a control. The four belong together - two shares the Fellows may
          * spend, two reserves where everything stops whatever the share says.
          */}
        {row(
          'researchShareWeekPct',
          'Research share, week',
          'How much of the plan\'s seven-day window the Fellows may spend, in percent. The night shift adds up what every Fellow claims at its own model, depth and quota and measures it against this. 10 % is the default; more buys more nights, and the reserve below still stops everything.',
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.researchShareWeekPct}
            onChange={(e) => setDraft({ ...draft, researchShareWeekPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />,
        )}

        {row(
          'researchShare5hPct',
          'Research share, 5 hours',
          'The same limit over one 5-hour window, so a single night cannot spend the week. 15 % by default.',
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.researchShare5hPct}
            onChange={(e) => setDraft({ ...draft, researchShare5hPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />,
        )}

        {row(
          'reserveWeekPct',
          'Reserve, week',
          'Where the Fellows stop whatever their share says: above this utilization of the seven-day window nothing research-related runs, so your own work keeps the rest. 80 % by default.',
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.reserveWeekPct}
            onChange={(e) => setDraft({ ...draft, reserveWeekPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />,
        )}

        {row(
          'reserve5hPct',
          'Reserve, 5 hours',
          'The same floor over one 5-hour window. 60 % by default: the window you are most likely to want for yourself.',
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={draft.reserve5hPct}
            onChange={(e) => setDraft({ ...draft, reserve5hPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
          />,
        )}

        {row(
          'planName',
          'Plan name',
          'What your subscription is called ("5x max"), shown in the Library\'s corner beside what is left of each window. Not part of the credential: the SDK reports it on some accounts and not on others. Empty = show whatever was measured.',
          <input type="text" maxLength={40} placeholder="measured" value={draft.planName} onChange={(e) => setDraft({ ...draft, planName: e.target.value })} />,
        )}

        {row(
          'fiveHourOverrideEnabled',
          '5-hour release',
          'Lets you hand the rest of a 5-hour window to the Fellows from the Library corner - up to 90 % of it, until that window resets. Off by default and off means gone: no button, and the endpoint refuses whoever asks. The week\'s reserve is never touched, a release ends with its window and renews nothing, and it is refused while a run is in flight.',
          <input type="checkbox" checked={draft.fiveHourOverrideEnabled} onChange={(e) => setDraft({ ...draft, fiveHourOverrideEnabled: e.target.checked })} />,
        )}

        {row(
          'dedupeJudgeEnabled',
          'Duplicate judge',
          'Lets the night shift spend one read-only run asking a model which Fellows\' topics are the same question. Off by default. The word-overlap check keeps working without it and only sees a duplicate that reuses the words; this catches the same question asked differently. It never overturns a topic you approved, and it only merges what it is sure of - a hedge is noted in the recap and the run happens.',
          <input type="checkbox" checked={draft.dedupeJudgeEnabled} onChange={(e) => setDraft({ ...draft, dedupeJudgeEnabled: e.target.checked })} />,
        )}

        {row(
          'gitAutoCommit',
          'Git auto-commit',
          'Commit automatically after every ingest. Off: pages land on disk without a commit.',
          <input
            type="checkbox"
            checked={draft.gitAutoCommit}
            onChange={(e) => setDraft({ ...draft, gitAutoCommit: e.target.checked })}
          />,
        )}

        {row(
          'oaRecovery',
          'Open-access rescue',
          'When a URL is refused (401/403), reads as a login or bot wall, or holds only an abstract, and it names a DOI: look for a legal open-access copy of the same work and ingest that instead. On by default. Every candidate address goes through the same checks as an address you type, and the page says which copy it came from. Off: the job fails or stays thin as before.',
          <input type="checkbox" checked={draft.oaRecovery} onChange={(e) => setDraft({ ...draft, oaRecovery: e.target.checked })} />,
        )}

        {row(
          'doiDedupe',
          'DOI dedupe',
          'Skip a paper whose DOI a source page already declares, before any agent run. Off: ingest it anyway (switch off and drop the file again if a match was wrong).',
          <input
            type="checkbox"
            checked={draft.doiDedupe}
            onChange={(e) => setDraft({ ...draft, doiDedupe: e.target.checked })}
          />,
        )}

        {row(
          'urlDedupe',
          'URL dedupe',
          'Skip a link whose address a source page already declares, before fetching it; share-link tracking parameters are ignored. Off: fetch and ingest it anyway (switch off to re-ingest a page that changed).',
          <input
            type="checkbox"
            checked={draft.urlDedupe}
            onChange={(e) => setDraft({ ...draft, urlDedupe: e.target.checked })}
          />,
        )}

        {row(
          'dailyBudget',
          'Daily budget',
          budgetUnit === 'jobs'
            ? 'Ingests per day; beyond that the queue pauses until midnight. Empty = no limit.'
            : 'USD per day; beyond that the queue pauses until midnight. Empty = no limit.',
          <div className="setting-control">
            <input
              type="number"
              min={budgetUnit === 'usd' ? 0.01 : 1}
              step={budgetUnit === 'usd' ? 0.5 : 1}
              placeholder="no limit"
              value={draft.dailyBudget ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, dailyBudget: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
            <span className="setting-hint" style={{ marginTop: 0 }}>
              {budgetUnit === 'jobs' ? 'ingests/day' : 'USD/day'}
            </span>
          </div>,
        )}
      </>
    )
  }
}
