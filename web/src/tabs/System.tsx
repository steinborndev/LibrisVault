/**
 * System (restructure proposal 2026-09-24). The screen used to be five sections, one of which
 * ("Status & checks") hid seven tools behind an in-content view switch that no URL, no back
 * button and no column entry knew about. Every tool now has an entry of its own, and the
 * column is grouped by what the visitor came to do:
 *
 *   Overview      what needs you, what ran lately, how the instance stands - the landing
 *   Maintenance   one entry per tool, each with its severity dot from the status model
 *   Insight       usage & cost, vault stats, the persistent run log
 *   Settings      intake, runs & budget, research budget (Fellows only), connections, and
 *                 the read-only facts of this instance
 *
 * Every entry is a route (`/system?section=<id>`), so a "What's due" item, a setup banner or
 * another screen can link to exactly the place it means. The retired section ids (`checks`,
 * `service`, `integrations`) resolve to their new homes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { AgentRunRecord, AuthMode, PlanStatus, Stats } from '../api/types.ts'
import { Maintenance } from './Maintenance.tsx'
import { SettingsEditor, SETTINGS_GROUP_OF, type SettingsGroup } from '../components/SettingsEditor.tsx'
import { CredentialSetup } from '../components/CredentialSetup.tsx'
import { TelegramSetup } from '../components/TelegramSetup.tsx'
import { GrowthChart } from '../components/GrowthChart.tsx'
import { Cost, CostFootnote, isEstimate } from '../components/Cost.tsx'
import { Fact, Facts } from '../components/Fact.tsx'
import { FootKeys } from '../components/FootKeys.tsx'
import { queryState, merge } from '../components/QueryState.tsx'
import { Tip } from '../components/Tip.tsx'
import { useMaintenanceStatus } from '../hooks/useMaintenanceStatus.ts'
import { isUnfiled, knowledgePages, vaultShape } from '../lib/vaultShape.ts'
import { timeAgo, tokens, usd } from '../lib/format.ts'
import { navigate } from '../lib/router.ts'
import { runTitle, isMaintenanceRun } from '../lib/runLabels.ts'
import { contentPages } from '../lib/activity.ts'
import { spendByChannel, spendItems, topSpend, totalSpend, withinDays } from '../lib/usage.ts'
import { shareLine } from '../lib/plan.ts'
import type { MaintAreaId, MaintSeverity, MaintStatusItem } from '../lib/maintenanceStatus.ts'
import type { EffectiveSettings } from '../api/types.ts'

type GroupId = 'top' | 'maintenance' | 'insight' | 'settings'

interface SectionDef {
  id: string
  label: string
  /** One line under the title: what this place is for, in the visitor's words. */
  sub: string
  group: GroupId
  /** Maintenance tools: the card this section renders and the status areas it answers for. */
  anchor?: string
  areas?: readonly MaintAreaId[]
  /** Run kinds whose history belongs under this tool. */
  kinds?: readonly string[]
  settings?: SettingsGroup
  /** Only on an instance with the research agents (hard rule 8). */
  fellowsOnly?: boolean
}

const SECTIONS: readonly SectionDef[] = [
  { id: 'overview', label: 'Overview', sub: 'what needs you, what ran lately, how the instance stands', group: 'top' },

  { id: 'lint', label: 'Lint & links', sub: 'wiki health report, safe fixes, broken wikilinks', group: 'maintenance', anchor: 'card-lint', areas: ['lint'], kinds: ['lint', 'lint-fix'] },
  { id: 'defects', label: 'Standing defects', sub: 'what the validator keeps finding, and the repair for each', group: 'maintenance', anchor: 'card-defects', areas: ['defects'], kinds: ['defect-fix'] },
  { id: 'domains', label: 'Domains', sub: 'the registry, filing pages, new and oversized domains', group: 'maintenance', anchor: 'card-domains', areas: ['domains', 'backfill', 'split'], kinds: ['domain-backfill', 'domain-review', 'split-naming'] },
  { id: 'tags', label: 'Tags', sub: 'spelling variants, echoes of a domain, bounded repairs', group: 'maintenance', anchor: 'card-tags', areas: ['tags'], kinds: ['tag-fix'] },
  { id: 'hot-cache', label: 'Hot cache', sub: 'the compact context every agent run reads first', group: 'maintenance', anchor: 'card-hot-cache', areas: ['hot-cache'], kinds: ['hot-cache'] },
  { id: 'index', label: 'Retrieval index', sub: 'chunk and BM25 index behind Research answers', group: 'maintenance', anchor: 'card-index', areas: ['index'], kinds: ['retrieve-index'] },
  { id: 'git', label: 'Git history', sub: 'what is committed, and what is not yet', group: 'maintenance', anchor: 'card-unversioned', areas: ['unversioned'] },

  { id: 'usage', label: 'Usage & cost', sub: 'tokens, spend, the plan and the daily budget', group: 'insight' },
  { id: 'vault', label: 'Vault stats', sub: 'size, growth and shape of the wiki', group: 'insight' },
  { id: 'history', label: 'Run log', sub: 'every agent run the service recorded, newest first', group: 'insight' },

  { id: 'intake', label: 'Intake', sub: 'watch folder, file limit, dedupe, open-access rescue', group: 'settings', settings: 'intake' },
  { id: 'runs', label: 'Runs & budget', sub: 'concurrency, commits, the daily budget', group: 'settings', settings: 'runs' },
  { id: 'research', label: 'Research budget', sub: 'what the Fellows may spend of the plan', group: 'settings', settings: 'research', fellowsOnly: true },
  { id: 'connections', label: 'Connections', sub: 'Anthropic credential, Telegram bot, Obsidian', group: 'settings' },
  { id: 'instance', label: 'This instance', sub: 'read-only facts fixed at start', group: 'settings', settings: 'instance' },
]

const GROUP_LABEL: Record<Exclude<GroupId, 'top'>, string> = {
  maintenance: 'Maintenance',
  insight: 'Insight',
  settings: 'Settings',
}

const byId = (id: string): SectionDef | undefined => SECTIONS.find((s) => s.id === id)

/**
 * A `?section=` value to a section id, retired ids included. `service` was the whole settings
 * form: with a `?setting=` it lands on that key's group, without one on the first group.
 */
function resolveSection(section: string, setting: string): string | null {
  if (section === '') return null
  if (byId(section) !== undefined) return section
  if (section === 'checks') return 'overview'
  if (section === 'integrations') return 'connections'
  if (section === 'service') {
    const group = SETTINGS_GROUP_OF[setting as keyof EffectiveSettings] as SettingsGroup | undefined
    return group ?? 'intake'
  }
  return 'overview'
}

/** Which section a status item's anchor belongs to. */
const sectionForAnchor = (anchor: string): string => SECTIONS.find((s) => s.anchor === anchor)?.id ?? 'overview'

const SEV_RANK: Record<MaintSeverity, number> = { due: 2, recommended: 1, healthy: 0 }

function worst(items: readonly MaintStatusItem[]): MaintSeverity | null {
  if (items.length === 0) return null
  return items.reduce<MaintSeverity>((w, i) => (SEV_RANK[i.severity] > SEV_RANK[w] ? i.severity : w), 'healthy')
}

const SEV_WORD: Record<MaintSeverity, string> = { due: 'due', recommended: 'soon', healthy: 'ok' }
const SEV_CLASS: Record<MaintSeverity, string> = { due: 'due', recommended: 'rec', healthy: 'ok' }

const DIR_LABELS: Record<string, string> = {
  concepts: 'Concepts',
  entities: 'Entities',
  sources: 'Sources',
  references: 'References',
  comparisons: 'Comparisons',
  questions: 'Questions',
  folds: 'Folds',
  meta: 'Meta',
  // Pages that sit directly in `wiki/` - the index, the hot cache, the journal. They have no
  // folder to be named after, and used to be counted by nobody.
  root: 'Wiki root',
}

export function System({ section = '', setting = '' }: { section?: string; setting?: string }): React.ReactElement {
  const [active, setActive] = useState<string>(() => resolveSection(section, setting) ?? 'overview')

  // `?section=` from elsewhere (the setup banner, the night shift's budget line) - the screen
  // stays mounted, so this must react to navigation, not just the first mount. An empty value
  // is the tab itself being clicked: it keeps the section you were in.
  useEffect(() => {
    const next = resolveSection(section, setting)
    if (next !== null) setActive(next)
  }, [section, setting])

  const go = useCallback((id: string): void => navigate(`/system?section=${id}`), [])

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const maint = useMaintenanceStatus()
  const fellowsOn = health.data?.fellows === true

  const visible = useMemo(() => SECTIONS.filter((s) => !s.fellowsOnly || fellowsOn), [fellowsOn])
  const current = visible.find((s) => s.id === active) ?? SECTIONS[0]!

  const itemsFor = useCallback(
    (s: SectionDef): MaintStatusItem[] =>
      s.areas === undefined ? [] : (maint.data?.status.items ?? []).filter((i) => s.areas!.includes(i.id)),
    [maint.data],
  )
  const due = maint.data?.status.due ?? 0
  const recommended = maint.data?.status.recommended ?? 0
  const credentialMissing = settings.data !== undefined && settings.data.readOnly['credentialConfigured'] === 'no'

  // `[` and `]` step through the column, Escape goes back to the overview - only while this
  // screen is the one showing and nothing is being typed into.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const screen = document.querySelector<HTMLElement>('section[aria-label="System"]')
      if (screen === null || screen.hidden) return
      const t = e.target as HTMLElement | null
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const i = visible.findIndex((s) => s.id === current.id)
      if (e.key === ']' && i < visible.length - 1) go(visible[i + 1]!.id)
      else if (e.key === '[' && i > 0) go(visible[i - 1]!.id)
      else if (e.key === 'Escape' && current.id !== 'overview') go('overview')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, current.id, go])

  const rowMeta = (s: SectionDef): { dot: string; n: React.ReactNode } => {
    if (s.id === 'overview') {
      if (maint.data === null) return { dot: 'ring', n: null }
      if (due > 0) return { dot: 'due', n: <span className="n due">{due} due</span> }
      if (recommended > 0) return { dot: 'rec', n: <span className="n rec">{recommended} soon</span> }
      return { dot: 'ok', n: <span className="n">all ok</span> }
    }
    if (s.group === 'maintenance') {
      const sev = worst(itemsFor(s))
      if (sev === null) return { dot: 'ring', n: null }
      return { dot: SEV_CLASS[sev], n: sev === 'healthy' ? null : <span className={`n ${SEV_CLASS[sev]}`}>{SEV_WORD[sev]}</span> }
    }
    if (s.id === 'usage' && stats.data !== undefined) return { dot: 'ring', n: <span className="n">{usd(stats.data.usage.today.costUsd)} today</span> }
    if (s.id === 'vault' && stats.data !== undefined) return { dot: 'ring', n: <span className="n">{stats.data.pages.total}</span> }
    if (s.id === 'connections' && credentialMissing) return { dot: 'due', n: <span className="n due">set up</span> }
    return { dot: 'ring', n: null }
  }

  const groups: GroupId[] = ['top', 'maintenance', 'insight', 'settings']
  const currentItems = itemsFor(current)
  const currentSev = worst(currentItems)
  const openTools = visible.filter((s) => s.group === 'maintenance' && (worst(itemsFor(s)) ?? 'healthy') !== 'healthy').length
  const toolCount = visible.filter((s) => s.group === 'maintenance').length

  return (
    <div className="workspace">
      <aside className="gpanel sys-nav" aria-label="System sections">
        {groups.map((g) => (
          <div key={g} className="gp-sec">
            {g !== 'top' && (
              <div className="gp-head">
                <span className="gp-eyebrow">{GROUP_LABEL[g]}</span>
                <span className="spacer" />
                {g === 'maintenance' && maint.data !== null && (
                  <span className="gp-count">{openTools === 0 ? 'all healthy' : `${openTools} of ${toolCount} open`}</span>
                )}
              </div>
            )}
            <div className="domlist static">
              {visible
                .filter((s) => s.group === g)
                .map((s) => {
                  const meta = rowMeta(s)
                  return (
                    <button
                      key={s.id}
                      className={`domrow${current.id === s.id ? ' active' : ''}${s.id === 'overview' ? ' lead' : ''}`}
                      aria-current={current.id === s.id ? 'true' : undefined}
                      onClick={() => go(s.id)}
                    >
                      <span className={`dot sd-${meta.dot}`} aria-hidden />
                      <span className="nm">{s.label}</span>
                      {meta.n}
                    </button>
                  )
                })}
            </div>
          </div>
        ))}
        <div className="gp-sec sys-nav-legend">
          <span><i className="dot sd-due" /> due</span>
          <span><i className="dot sd-rec" /> soon</span>
          <span><i className="dot sd-ok" /> healthy</span>
        </div>
      </aside>

      <div className="box">
        <div className="box-head">
          {current.group !== 'top' && (
            <button className="sys-crumb" onClick={() => go('overview')} title="Back to the overview (Esc)">
              {GROUP_LABEL[current.group as Exclude<GroupId, 'top'>]}
              <span aria-hidden> / </span>
            </button>
          )}
          <h2 className="box-title">{current.label}</h2>
          <span className="box-sub">{current.sub}</span>
          <span className="spacer" />
          {current.group === 'maintenance' && currentSev !== null && (
            <span className={`sev ${SEV_CLASS[currentSev]}`}>{currentSev === 'healthy' ? 'healthy' : SEV_WORD[currentSev]}</span>
          )}
          {current.id === 'overview' && maint.data !== null && (
            <>
              {due > 0 && <span className="badge deferred">{due} due</span>}
              {recommended > 0 && <span className="badge preprocessing">{recommended} soon</span>}
              <span className="badge ok">{maint.data.status.healthy} healthy</span>
            </>
          )}
        </div>
        <div className="box-body">
          {current.id === 'overview' && <OverviewSection onGo={go} />}

          {current.group === 'maintenance' && current.anchor !== undefined && (
            <div className="sys-pane" key={current.id}>
              <WhyNow items={currentItems} />
              <Maintenance card={current.anchor} />
              {current.id === 'domains' && <DomainCounts />}
              {current.id === 'git' && <RecentCommits />}
              {current.kinds !== undefined && <ToolRuns kinds={current.kinds} label={current.label} />}
            </div>
          )}

          {current.id === 'usage' && <UsageSection onGo={go} />}
          {current.id === 'vault' && <VaultStatsSection onGo={go} />}
          {current.id === 'history' && <RunLogSection />}
          {current.id === 'connections' && <ConnectionsSection onGo={go} />}

          {/* One editor for every settings group, mounted once and kept: an edit in Intake
              survives a look at Runs & budget, and the save bar counts both. */}
          {settings.data !== undefined && (
            <div className="sys-pane" hidden={current.settings === undefined}>
              {current.settings !== undefined && current.settings !== 'instance' && <SettingsIntro group={current.settings} />}
              <SettingsEditor group={current.settings ?? 'intake'} focus={setting} />
            </div>
          )}
        </div>
        <div className="box-foot keys">
          <span className="fl">
            {current.group === 'maintenance'
              ? maint.data === null
                ? 'Checking the vault…'
                : `${openTools} of ${toolCount} tools need you`
              : current.id === 'overview'
                ? maint.data === null
                  ? 'Checking the vault…'
                  : `${due} due · ${recommended} soon · ${maint.data.status.healthy} healthy`
                : GROUP_LABEL[current.group as Exclude<GroupId, 'top'>] ?? ''}
          </span>
          <FootKeys items={['[ ] step the sections', 'Esc back to overview', 'Ctrl K jump anywhere']} />
          <span className="fr" />
        </div>
      </div>
    </div>
  )
}

/**
 * The top of every tool: the status model's verdict on its areas, in the model's own three
 * fields - what, why now, what it costs. A tool with nothing to say shows its healthy line,
 * because "healthy" is a state and not an empty screen.
 */
function WhyNow({ items }: { items: readonly MaintStatusItem[] }): React.ReactElement | null {
  if (items.length === 0) return null
  const sorted = [...items].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
  return (
    <section className="subcard sc-pad sys-why">
      <div className="sc-head">
        <h3 className="sc-title">
          Status
          <Tip text="The same deterministic check the Overview runs, narrowed to this tool. 'Due' blocks other maintenance or degrades quality; 'soon' is worth doing soon; 'healthy' means nothing to do here." />
        </h3>
      </div>
      <div className="ms-items">
        {sorted.map((item) => (
          <div key={`${item.id}-${item.title}`} className="ms-item static">
            <span className={`sev ${SEV_CLASS[item.severity]}`}>{item.severity === 'recommended' ? 'soon' : item.severity}</span>
            <span className="ms-main">
              <span className="ms-title">{item.title}</span>
              <span className="ms-why">{item.why}</span>
            </span>
            <span className="ms-cost">{item.cost}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The landing: what needs you first, then the two things you check on most. */
function OverviewSection({ onGo }: { onGo: (id: string) => void }): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const runs = useQuery({ queryKey: ['maintenance-history', 'all'], queryFn: () => api.maintenanceHistory({ limit: 200 }) })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const telegram = useQuery({ queryKey: ['telegram-status'], queryFn: api.telegramStatus, staleTime: 300_000 })
  const s = stats.data
  // Consecutive runs of one kind collapse into one row: an index rebuilt after every ingest
  // is one fact ("rebuilt 4 times"), not four rows that push everything else out.
  const recent = useMemo(() => {
    const out: Array<{ run: AgentRunRecord; times: number }> = []
    for (const r of runs.data?.runs ?? []) {
      const last = out[out.length - 1]
      if (last !== undefined && last.run.kind === r.kind && last.run.ok === r.ok && last.run.label === r.label) last.times++
      else out.push({ run: r, times: 1 })
      if (out.length > 6) break
    }
    return out.slice(0, 6)
  }, [runs.data])
  const failed7d = (runs.data?.runs ?? []).filter((r) => !r.ok && Date.now() - Date.parse(r.finishedAt) < 7 * 864e5).length
  const ro = settings.data?.readOnly ?? {}

  return (
    <>
      <Facts size="lead">
        <Fact size="lead" k="Spend today" v={s ? <Cost value={s.usage.today.costUsd} authMode={s.authMode} /> : '…'} onOpen={() => onGo('usage')} />
        <Fact size="lead" k="Spend 7 days" v={s ? <Cost value={s.usage.last7d.costUsd} authMode={s.authMode} /> : '…'} sub={s ? `${s.usage.last7d.ingests} runs` : undefined} onOpen={() => onGo('usage')} />
        <Fact size="lead" k="Pages" v={s ? String(s.pages.total) : '…'} sub={s ? `${s.kpis7d.ingests} ingests in 7 d` : undefined} onOpen={() => onGo('vault')} />
        <Fact size="lead" k="Failed runs · 7d" v={runs.data ? String(failed7d) : '…'} tone={failed7d > 0 ? 'err' : undefined} onOpen={() => onGo('history')} />
        <Fact
          size="lead"
          k="Daily budget"
          v={s ? (s.budget.limit === null ? 'no limit' : s.budget.unit === 'usd' ? usd(s.budget.limit) : `${s.budget.limit} / day`) : '…'}
          sub={s && s.budget.limit !== null ? `${s.budget.unit === 'usd' ? usd(s.budget.spent) : s.budget.spent} spent` : 'set under Runs & budget'}
          onOpen={() => navigate('/system?section=runs&setting=dailyBudget')}
        />
      </Facts>
      <div className="sys-pane">
        <Maintenance compact showRunHistory={false} onJump={(anchor) => onGo(sectionForAnchor(anchor))} />

        <div className="sys-grid">
          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Recent runs</h3>
              <span className="spacer" />
              <button className="linkish" onClick={() => onGo('history')}>
                Full run log
              </button>
            </div>
            <div className="sc-body flush">
              {recent.length === 0 ? (
                <div className="empty">No agent run recorded yet.</div>
              ) : (
                <table className="dtable sys-runs">
                  <tbody>
                    {recent.map(({ run: r, times }) => (
                      <tr key={r.id}>
                        <td className="sr-dot">
                          <span className={`hrow-dot ${r.ok ? 'done' : 'failed'}`} aria-hidden />
                        </td>
                        <td className="rt-name" title={r.label ?? runTitle(r.kind, r.ok)}>
                          {r.label ?? runTitle(r.kind, r.ok)}
                          {times > 1 && <span className="rl-times">×{times}</span>}
                        </td>
                        <td className="num">{r.pages.length > 0 ? `${r.pages.length} p` : ''}</td>
                        <td className="faintc">{timeAgo(r.finishedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Instance</h3>
              <span className="spacer" />
              <button className="linkish" onClick={() => onGo('connections')}>
                Connections
              </button>
            </div>
            <div className="sc-body">
              <div className="kvlist">
                <div className="kv">
                  <span className="k">Anthropic</span>
                  <span className={`v${ro['credentialConfigured'] === 'no' ? ' bad' : ''}`}>
                    {ro['credentialConfigured'] === 'no' ? 'no credential' : (ro['authMode'] ?? '…')}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Watch folder</span>
                  <span className="v">{s === undefined ? '…' : s.watcher.active ? 'watching' : 'not watching'}</span>
                </div>
                <div className="kv">
                  <span className="k">Telegram</span>
                  <span className="v">{telegram.data === undefined ? '…' : telegram.data.configured ? 'connected' : 'off'}</span>
                </div>
                <div className="kv">
                  <span className="k">Queue</span>
                  <span className="v">
                    {s === undefined ? '…' : `${s.queue.active} running · ${s.queue.queued} queued · concurrency ${s.queue.concurrency}`}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Commits</span>
                  {health.data === undefined ? (
                    <span className="v">…</span>
                  ) : health.data.autoCommitDisabled === false ? (
                    <span className="v bad">vault commits too</span>
                  ) : (
                    <span className="v">service only</span>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

/** The runs a tool has made, so its receipts sit next to its button. */
function ToolRuns({ kinds, label }: { kinds: readonly string[]; label: string }): React.ReactElement {
  const runs = useQuery({ queryKey: ['maintenance-history', 'all'], queryFn: () => api.maintenanceHistory({ limit: 200 }) })
  const mine = (runs.data?.runs ?? []).filter((r) => kinds.includes(r.kind)).slice(0, 8)
  return (
    <section className="subcard">
      <div className="sc-head">
        <h3 className="sc-title">Recent runs · {label}</h3>
        <span className="spacer" />
        <span className="badge">{mine.length === 0 ? 'none yet' : `${mine.length} shown`}</span>
      </div>
      <div className="sc-body flush">
        {mine.length === 0 ? <div className="empty">This tool has not run yet.</div> : <RunTable runs={mine} />}
      </div>
    </section>
  )
}

function RunTable({ runs }: { runs: readonly AgentRunRecord[] }): React.ReactElement {
  return (
    <table className="dtable runlog">
      <thead>
        <tr>
          <th />
          <th>Run</th>
          <th className="num">Pages</th>
          <th className="num">Cost</th>
          <th>When</th>
          <th>Commit</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td className="sr-dot">
              <span className={`hrow-dot ${r.ok ? 'done' : 'failed'}`} aria-hidden />
            </td>
            <td className="rt-name" title={r.error ?? r.label ?? runTitle(r.kind, r.ok)}>
              {r.label !== null ? (
                <>
                  <span className="rl-kind">{runTitle(r.kind, r.ok)}</span> {r.label}
                </>
              ) : (
                runTitle(r.kind, r.ok)
              )}
              {r.error !== null && <span className="rl-err"> · {r.error}</span>}
            </td>
            <td className="num">{r.pages.length > 0 ? r.pages.length : '-'}</td>
            <td className="num">{r.costUsd !== null ? usd(r.costUsd) : '-'}</td>
            <td className="faintc" title={new Date(r.finishedAt).toLocaleString('en-US')}>
              {timeAgo(r.finishedAt)}
            </td>
            <td>
              <span className="mono-meta">{r.commitHash !== null ? r.commitHash.slice(0, 7) : ''}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The persistent run log, one table, filterable by what kind of work and whether it held. */
function RunLogSection(): React.ReactElement {
  const runs = useQuery({ queryKey: ['maintenance-history', 'all'], queryFn: () => api.maintenanceHistory({ limit: 200 }) })
  const [kind, setKind] = useState<'all' | 'maintenance' | 'research'>('all')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const state = queryState(runs, 'the run log')
  if (state !== null) return <div className="sys-pane">{state}</div>
  const all = runs.data?.runs ?? []
  const shown = all.filter(
    (r) => (kind === 'all' || (kind === 'maintenance') === isMaintenanceRun(r.kind)) && (!onlyFailed || !r.ok),
  )
  const failed = all.filter((r) => !r.ok).length
  return (
    <div className="sys-pane">
      <div className="sys-toolbar">
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(['all', 'maintenance', 'research'] as const).map((k) => (
            <button key={k} className={kind === k ? 'active' : ''} aria-checked={kind === k} role="radio" onClick={() => setKind(k)}>
              {k === 'all' ? 'All runs' : k === 'maintenance' ? 'Maintenance' : 'Research'}
            </button>
          ))}
        </div>
        <button className={`chip${onlyFailed ? ' active' : ''}`} onClick={() => setOnlyFailed((v) => !v)}>
          Failed only <span className="n">{failed}</span>
        </button>
        <span className="spacer" />
        <span className="gp-count">
          {shown.length} of {all.length} stored runs
        </span>
      </div>
      <section className="subcard">
        <div className="sc-body flush">
          {shown.length === 0 ? <div className="empty">No run matches this filter.</div> : <RunTable runs={shown} />}
        </div>
      </section>
    </div>
  )
}

/** A line of orientation above a settings group: what it governs, and what it does not. */
function SettingsIntro({ group }: { group: SettingsGroup }): React.ReactElement {
  const text: Record<Exclude<SettingsGroup, 'instance'>, string> = {
    intake: 'How material gets in: where the service looks for files, what it refuses, and what it skips as already known.',
    runs: 'How agent runs are paced and recorded. The daily budget pauses the queue when it is spent and resumes it at midnight.',
    research: 'What the Fellows may spend of the plan. The shares size their nights; the reserves stop everything, whatever the shares say.',
  }
  return <p className="sys-intro">{text[group as Exclude<SettingsGroup, 'instance'>]}</p>
}

/** Credential, bot and Obsidian as cards with their state in the head, not as bare buttons. */
function ConnectionsSection({ onGo }: { onGo: (id: string) => void }): React.ReactElement {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const ro = settings.data?.readOnly
  const state = queryState(settings, 'the connections')
  if (state !== null || ro === undefined) return <div className="sys-pane">{state ?? <div className="empty">Loading…</div>}</div>
  const credentialOk = ro['credentialConfigured'] !== 'no'
  const telegramOn = (ro['telegram'] ?? 'off') !== 'off'
  return (
    <div className="sys-pane">
      <p className="sys-intro">
        The three ways the service reaches outside this machine. Credentials are written to the service env file and never
        shown again; changing one restarts the service.
      </p>
      <section className="subcard sc-pad">
        <div className="sc-head">
          <h3 className="sc-title">Anthropic credential</h3>
          <span className="spacer" />
          <span className={`badge ${credentialOk ? 'ok' : 'deferred'}`}>{credentialOk ? `configured · ${ro['authMode'] ?? ''}` : 'missing'}</span>
        </div>
        <div className="kvlist conn-facts">
          <div className="kv">
            <span className="k">Mode</span>
            <span className="v">{ro['authMode'] ?? '-'}</span>
          </div>
          <div className="kv">
            <span className="k">Source</span>
            <span className="v">{ro['credentialSource'] ?? '-'}</span>
          </div>
        </div>
        <CredentialSetup configured={credentialOk} />
      </section>

      <section className="subcard sc-pad">
        <div className="sc-head">
          <h3 className="sc-title">Telegram bot</h3>
          <span className="spacer" />
          <span className={`badge ${telegramOn ? 'ok' : ''}`}>{telegramOn ? 'connected' : 'off'}</span>
        </div>
        <p className="tab-hint">Anything you send the bot - a link, a file, a note - is queued for ingest like a drop.</p>
        <TelegramSetup status={ro['telegram'] ?? 'off'} />
      </section>

      <div className="sys-grid">
        <section className="subcard sc-pad">
          <div className="sc-head">
            <h3 className="sc-title">Watch folder</h3>
            <span className="spacer" />
            <span className={`badge ${stats.data?.watcher.active ? 'ok' : 'deferred'}`}>{stats.data?.watcher.active ? 'watching' : 'inactive'}</span>
          </div>
          <div className="tool-meta">
            <code>{stats.data?.watcher.folder ?? '…'}</code>
          </div>
          <p className="tab-hint">
            <button className="linkish" onClick={() => navigate('/system?section=intake&setting=watchFolder')}>
              Change it under Intake
            </button>
          </p>
        </section>
        <section className="subcard sc-pad">
          <div className="sc-head">
            <h3 className="sc-title">Obsidian</h3>
            <span className="spacer" />
            <span className="badge">link handler</span>
          </div>
          <p className="tab-hint">
            Page links open through the <code>obsidian://</code> handler; nothing to configure here.{' '}
            <button className="linkish" onClick={() => onGo('instance')}>
              Instance facts
            </button>
          </p>
        </section>
      </div>
    </div>
  )
}

/** Pages per domain, beside the registry that defines them. */
function DomainCounts(): React.ReactElement | null {
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  if (graph.data === undefined) return null
  const knowledge = knowledgePages(graph.data.nodes)
  const undomained = vaultShape(graph.data)?.undomained ?? 0
  const counts = new Map<string, number>()
  for (const n of knowledge) if (!isUnfiled(n)) counts.set(n.domain as string, (counts.get(n.domain as string) ?? 0) + 1)
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const max = entries[0]?.[1] ?? 1
  return (
    <section className="subcard">
      <div className="sc-head">
        <h3 className="sc-title">Pages per domain</h3>
        <span className="spacer" />
        <span className="badge">{domains.data?.domains.length ?? 0} registered</span>
      </div>
      <div className="sc-body">
        {entries.length === 0 ? (
          <div className="empty">No page carries a domain yet.</div>
        ) : (
          <div className="tbars">
            {entries.map(([key, n]) => (
              <div key={key} className="tbar">
                <span className="tl">{key}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${Math.max(2, Math.round((n / max) * 100))}%` }} />
                </span>
                <span className="tv">{n}</span>
              </div>
            ))}
            {undomained > 0 && (
              <div className="tbar">
                <span className="tl warnish">no domain yet</span>
                <span className="track" />
                <span className="tv">{undomained}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function RecentCommits(): React.ReactElement | null {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const s = stats.data
  if (s === undefined) return null
  return (
    <section className="subcard">
      <div className="sc-head">
        <h3 className="sc-title">
          Recent commits
          <Tip text="Every write to this vault is one commit - agent runs, maintenance and your own page edits alike. Page counts exclude the index hubs (index, hot, log, overview and the _index pages) that almost every commit touches." />
        </h3>
        <span className="spacer" />
        <span className="badge">{s.commits.length} newest</span>
      </div>
      <div className="sc-body flush">
        {s.commits.length === 0 ? (
          <div className="empty">Nothing is committed in this vault yet.</div>
        ) : (
          <table className="dtable committable">
            <thead>
              <tr>
                <th>Commit</th>
                <th className="num">Pages</th>
                <th>When</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {s.commits.map((c) => {
                const pages = contentPages(c.pages)
                return (
                  <tr key={c.hash}>
                    <td className="ct-subject" title={c.subject}>
                      {c.subject}
                    </td>
                    <td className="num dimc" title={pages.join('\n')}>
                      {pages.length > 0 ? `+${pages.length}` : '-'}
                    </td>
                    <td className="faintc">{timeAgo(c.date)}</td>
                    <td>
                      <span className="mono-meta">{c.hash.slice(0, 7)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

/** The last `days` days of the sparse per-day series as a dense array (UTC dates). */
function dense(daily: Stats['kpisDaily'], key: 'done' | 'failed', days: number): number[] {
  const map = new Map(daily.map((d) => [d.date, d[key]]))
  const out: number[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    out.push(map.get(date) ?? 0)
  }
  return out
}

/**
 * The plan (docs/agents/SPEC.md section 8): utilization of the 5-hour and 7-day windows, the
 * research share against the configured share, and whether the gate would let a step start.
 * The calibration arithmetic folds away: it is the evidence, not the reading.
 */
function PlanPanel({ plan, onGo }: { plan: PlanStatus; onGo: (id: string) => void }): React.ReactElement {
  const five = plan.windows.find((w) => w.window === 'five_hour')
  const week = plan.windows.find((w) => w.window === 'seven_day')
  const buckets = plan.windows.filter((w) => w.window !== 'five_hour' && w.window !== 'seven_day' && w.window !== 'seven_day_oauth_apps')
  const sharePct = plan.shares.week > 0 ? Math.min(100, Math.round((plan.shares.weekUsed / plan.shares.week) * 100)) : 0
  const models = Object.entries(plan.calibration.perModel).filter(([, c]) => c.sevenDay !== null && c.n >= 3)
  return (
    <section className="subcard">
      <div className="sc-head">
        <h3 className="sc-title">
          Plan
          <Tip text="What the subscription's rate-limit windows show, sampled through the SDK inside Fellow runs and from the usage endpoint between them." />
        </h3>
        <span className="spacer" />
        <button className="linkish" onClick={() => onGo('research')}>
          Research budget
        </button>
        <span className={`badge ${plan.gate ? 'deferred' : 'ok'}`}>{plan.gate ? 'steps blocked' : plan.available ? `${plan.subscription ?? 'plan'} · measured` : 'USD-equivalent'}</span>
      </div>
      <div className="sc-body">
        {plan.available ? (
          <div className="sc-meta">
            <span>5-hour window {five ? `${five.utilization}%` : '-'}</span>
            <span>week {week ? `${week.utilization}%` : '-'}</span>
            {buckets.map((b) => (
              <span key={b.window}>
                {b.window.replace('seven_day_', '').replace('model:', '')} {b.utilization}%
              </span>
            ))}
            <span className="spacer" />
            <span>sampled {plan.sampledAt ? timeAgo(plan.sampledAt) : 'never'}</span>
          </div>
        ) : (
          <p className="tab-hint">No plan windows: {plan.reason ?? 'no sample yet'}.</p>
        )}
        <div className="meter">
          <i className={plan.gate ? 'over' : ''} style={{ width: `${sharePct}%` }} />
        </div>
        <div className="sc-meta">
          <span>Research share: {shareLine(plan)}</span>
          <span className="spacer" />
          <span>{plan.shares.stepsLeftWeek !== null ? `about ${plan.shares.stepsLeftWeek} standard step(s) left` : 'no estimate yet'}</span>
        </div>
        {plan.gate && <p className="tab-hint">Steps wait: {plan.gate.reason}.</p>}
        <details className="sys-details">
          <summary>How the share is priced</summary>
          <p className="mono-meta">
            {models.length > 0
              ? `Calibrated: ${models
                  .map(([m, c]) => `${m} ${c.sevenDay!.toFixed(4)} points/USD from ${c.n} run(s)`)
                  .join(', ')}. Over every measured run, the plan's own rate is ${plan.calibration.overall.sevenDay?.toFixed(4) ?? '-'} points/USD from ${plan.calibration.overall.n} run(s) that moved the week by ${plan.calibration.overall.points.sevenDay} point(s) in all - which prices a week at roughly ${plan.planUsd.week.toFixed(0)} USD${plan.planUsd.measured ? '' : ' (the configured size; nothing measured yet)'}. A rough figure by nature: the plan states its limits in weighted tokens and never in dollars, the counter behind this moves in whole percent, and every other surface on the same account moves it too. The reserve is what protects the subscription; this only sizes the share.`
              : `Not calibrated yet: the points per USD come from the first 3 measured runs per model. Runs measured so far: ${Object.values(plan.calibration.perModel).reduce((a, c) => a + c.n, 0)}.`}
          </p>
        </details>
      </div>
    </section>
  )
}

/**
 * Usage & cost. Every figure here comes from data the service already stored - the point of
 * the section is that it was never added up anywhere.
 */
function UsageSection({ onGo }: { onGo: (id: string) => void }): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const jobs = useQuery({ queryKey: ['jobs', 300], queryFn: () => api.jobs({ limit: 300 }) })
  const runs = useQuery({
    queryKey: ['maintenance-history', 'all'],
    queryFn: () => api.maintenanceHistory({ limit: 200 }),
  })
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const plan = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, enabled: health.data?.fellows === true, refetchInterval: 60_000, retry: false })

  const items = useMemo(() => spendItems(jobs.data?.jobs ?? [], runs.data?.runs ?? []), [jobs.data, runs.data])
  const last7d = useMemo(() => withinDays(items, 7, new Date()), [items])
  const byChannel = useMemo(() => spendByChannel(last7d), [last7d])
  const byCost = useMemo(() => topSpend(items, items.length), [items])

  const state = queryState(merge(stats, jobs, runs), 'the usage figures')
  if (stats.data === undefined) {
    return <div className="sys-pane">{state ?? <div className="empty">No usage recorded yet.</div>}</div>
  }

  const s = stats.data
  const authMode: AuthMode = s.authMode
  const budget = s.budget
  const budgetPct = budget.limit !== null && budget.limit > 0 ? Math.min(100, Math.round((budget.spent / budget.limit) * 100)) : null
  const channelMax = byChannel[0]?.costUsd ?? 0
  const knownSpend = totalSpend(last7d)

  return (
    <>
      <Facts size="lead">
        <Fact size="lead" k="Spend today" v={<Cost value={s.usage.today.costUsd} authMode={authMode} />} />
        <Fact size="lead" k="Spend 7 days" v={<Cost value={s.usage.last7d.costUsd} authMode={authMode} />} />
        <Fact size="lead" k="Tokens in · 7d" v={tokens(s.usage.last7d.tokensIn)} />
        <Fact size="lead" k="Tokens out · 7d" v={tokens(s.usage.last7d.tokensOut)} />
        <Fact size="lead" k="Runs · 7d" v={String(s.usage.last7d.ingests)} />
      </Facts>
      <div className="sys-pane">
        <div className="sys-grid">
          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Daily budget</h3>
              <span className="spacer" />
              <button className="linkish" onClick={() => navigate('/system?section=runs&setting=dailyBudget')}>
                {budget.limit === null ? 'Set one' : 'Change'}
              </button>
              {budget.limit === null ? (
                <span className="badge">no limit</span>
              ) : (
                <span className={`badge ${budget.exceeded ? 'deferred' : 'ok'}`}>
                  {budget.unit === 'usd' ? `${usd(budget.limit)} / day` : `${budget.limit} ingests / day`}
                </span>
              )}
            </div>
            <div className="sc-body">
              {budget.limit === null ? (
                <p className="tab-hint">No daily budget: runs are only bounded by the Anthropic usage limit. With one, the queue pauses itself when it is spent and resumes at midnight.</p>
              ) : (
                <>
                  <div className="meter">
                    <i className={budget.exceeded ? 'over' : ''} style={{ width: `${budgetPct ?? 0}%` }} />
                  </div>
                  <div className="sc-meta">
                    <span>{budget.unit === 'usd' ? usd(budget.spent) : `${budget.spent} ingests`} spent</span>
                    <span className="spacer" />
                    <span>resets {timeAgo(budget.resetsAt)}</span>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Ingests per day · 14 d</h3>
              <span className="spacer" />
              <span className="badge">{s.kpis7d.ingests} in 7 d</span>
            </div>
            <div className="sc-body">
              <DayBars values={dense(s.kpisDaily, 'done', 14)} />
              <div className="sc-meta">
                <span>{s.kpis7d.failures} failed</span>
                <span>{s.kpis7d.duplicates} duplicates</span>
                <span>{s.kpis7d.deferred} deferred</span>
              </div>
            </div>
          </section>
        </div>

        {plan.data && <PlanPanel plan={plan.data} onGo={onGo} />}

        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">
              Where it went · last 7 days
              <Tip text="Summed over the stored job window and the maintenance runs the service still tracks." />
            </h3>
            <span className="spacer" />
            <span className="badge">{usd(knownSpend)} attributed</span>
          </div>
          <div className="sc-body">
            {byChannel.length === 0 ? (
              <div className="empty">Nothing cost anything in this window.</div>
            ) : (
              <div className="tbars">
                {byChannel.map((c) => (
                  <div key={c.channel} className="tbar">
                    <span className="tl">{c.channel}</span>
                    <span className="track">
                      <span className="fill" style={{ width: `${Math.max(2, Math.round((c.costUsd / (channelMax || 1)) * 100))}%` }} />
                    </span>
                    <span className="tv">
                      <Cost value={c.costUsd} authMode={authMode} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="subcard">
          <div className="sc-head">
            <h3 className="sc-title">
              Runs by cost
              <Tip text="Every ingest and maintenance run the service still has a price for, dearest first." />
            </h3>
            <span className="spacer" />
            <span className="badge">{byCost.length} priced</span>
            <span className="badge">{usd(totalSpend(byCost))} total</span>
          </div>
          <div className="sc-body flush">
            {byCost.length === 0 ? (
              <div className="empty">No priced runs recorded yet.</div>
            ) : (
              <div className="cardscroll" style={{ maxHeight: 340 }}>
                <table className="dtable runtable">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Channel</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCost.map((i) => (
                      <tr key={i.id}>
                        <td className="rt-name" title={i.label}>
                          {i.label}
                        </td>
                        <td className="dimc">{i.channel}</td>
                        <td className="num">{tokens(i.tokensIn + i.tokensOut)}</td>
                        <td className="num">
                          <Cost value={i.costUsd} authMode={authMode} />
                        </td>
                        <td className="faintc">{timeAgo(i.whenIso)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {isEstimate(authMode) && (
          <p className="tab-hint">
            <CostFootnote authMode={authMode} /> - in subscription mode these amounts are the API-price equivalent, not money charged.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Vault statistics: the shape of the wiki. What you would ACT on moved to its tool - the
 * retrieval index, the pages outside git, the commit list and the domain counts - so this
 * section only reads.
 */
function VaultStatsSection({ onGo }: { onGo: (id: string) => void }): React.ReactElement {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const graph = useQuery({ queryKey: ['graph'], queryFn: api.graph })

  const state = queryState(merge(stats, graph), 'the vault statistics')
  if (stats.data === undefined) {
    return <div className="sys-pane">{state ?? <div className="empty">No vault statistics yet.</div>}</div>
  }
  const s = stats.data
  const shape = vaultShape(graph.data)
  const orphans = shape?.orphans ?? 0
  const stubs = shape?.stubs ?? 0
  const gaps = shape?.gaps ?? null
  const undomained = shape?.undomained ?? 0
  const growth = s.growth
  const weekAgo = growth[growth.length - 8]?.total ?? growth[0]?.total ?? s.pages.total
  const grew = s.pages.total - weekAgo

  return (
    <>
      <Facts size="lead">
        <Fact size="lead" k="Pages" v={String(s.pages.total)} sub={`${grew >= 0 ? '+' : ''}${grew} in 7 d`} />
        <Fact size="lead" k="Links" v={graph.data !== undefined ? String(graph.data.edges.length) : '…'} />
        <Fact size="lead" k="Orphans" v={graph.data !== undefined ? String(orphans) : '…'} tone={orphans > 0 ? 'warn' : undefined} sub="in the Catalog" onOpen={() => navigate('/catalog')} />
        <Fact size="lead" k="Stubs" v={graph.data !== undefined ? String(stubs) : '…'} tone={stubs > 0 ? 'warn' : undefined} sub="in the Catalog" onOpen={() => navigate('/catalog')} />
        <Fact size="lead" k="Gaps" v={gaps === null ? '…' : String(gaps)} sub="on the Graph" onOpen={() => navigate('/graph?gaps=1')} />
        <Fact size="lead" k="Unfiled" v={graph.data !== undefined ? String(undomained) : '…'} tone={undomained > 0 ? 'warn' : undefined} sub="file them under Domains" onOpen={() => onGo('domains')} />
      </Facts>
      <div className="sys-pane">
        <div className="sys-grid">
          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Growth · 30 days</h3>
            </div>
            <div className="sc-body">
              <GrowthChart points={s.growth} />
            </div>
          </section>
          <section className="subcard">
            <div className="sc-head">
              <h3 className="sc-title">Pages by type</h3>
            </div>
            <div className="sc-body">
              <TypeBars byDir={s.pages.byDir} />
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

/**
 * A count per day as bars - discrete counts, not a continuous series, so the day boundaries
 * have to survive the drawing.
 */
function DayBars({ values }: { values: number[] }): React.ReactElement {
  const max = Math.max(1, ...values)
  const today = new Date()
  const label = (i: number): string => {
    const d = new Date(today.getTime() - (values.length - 1 - i) * 24 * 60 * 60 * 1000)
    return d.toISOString().slice(5, 10)
  }
  return (
    <div className="daybars">
      <div className="db-plot" role="img" aria-label={`Ingests per day over the last ${values.length} days`}>
        {values.map((v, i) => (
          <span key={i} className="db-col" title={`${label(i)}: ${v}`}>
            <span
              className={`db-bar${v === 0 ? ' zero' : ''}${i === values.length - 1 ? ' last' : ''}`}
              style={{ height: `${Math.max(v === 0 ? 2 : 6, Math.round((v / max) * 100))}%` }}
            />
          </span>
        ))}
      </div>
      <div className="db-axis">
        <span>{label(0)}</span>
        <span className="db-max">peak {max}</span>
        <span>{label(values.length - 1)}</span>
      </div>
    </div>
  )
}

/** Page counts as horizontal bars - proportions read at a glance, direct labels right. */
function TypeBars({ byDir }: { byDir: Record<string, number> }): React.ReactElement {
  const entries = Object.entries(byDir)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const maxN = entries[0]?.[1] ?? 1
  if (entries.length === 0) return <div className="empty">No pages yet.</div>
  return (
    <div className="tbars">
      {entries.map(([dir, n]) => (
        <div key={dir} className="tbar">
          <span className="tl">{DIR_LABELS[dir] ?? dir}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(2, Math.round((n / maxN) * 100))}%` }} />
          </span>
          <span className="tv">{n}</span>
        </div>
      ))}
    </div>
  )
}
