/**
 * Home's recap feed (docs/agents/SPEC.md section 9.3): the newest recap open and readable,
 * with the earlier ones a wheel away under it. It replaces the one-line inbox entry that
 * only said a recap existed.
 *
 * Two ways to drive it (2026-09-11). On its own - the Library's recap board - it keeps its
 * rail: the Fellows as pills and one calendar week of days, and a bar per day. Under Home's
 * headline it is CONTROLLED: the week, the day and the Fellow come in as props, the days
 * stand in the column's week list and the Fellows under it, there is no day bar, and the feed
 * reports which day is at the top so the headline's date can follow the scroll. One feed,
 * one filter, two frames.
 *
 * The fact strip belongs to the day in view, so switching to Activity swaps five figures
 * for five figures and the panel never changes height.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { RecapAnswer, RecapAnswerResult } from '../api/types.ts'
import { RecapBody, RecapFacts } from '../tabs/Recap.tsx'
import { FootKeys } from './FootKeys.tsx'
import { queryState } from './QueryState.tsx'
import { navigate } from '../lib/router.ts'
import { domainColor } from '../lib/domains.ts'
import { nightLine, undecidedCount } from '../lib/recap.ts'
import {
  absenceOf,
  recapMatches,
  feedRows,
  fmtDay,
  fmtWeek,
  localDate,
  openingWeek,
  runsInWeek,
  weekStartOf,
  workedOn,
} from '../lib/recapFeed.ts'

/** How many Fellows the rail makes room for (docs/agents/SPEC.md section 5.1). */
export const FELLOW_SLOTS = 5

export const titleDomain = (domain: string): string =>
  domain
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

/** The filter, when the screen around the feed owns it. */
export interface FeedControl {
  /** Monday of the week on show. */
  readonly week: string
  readonly day: string | null
  /** The Fellows on show, by name; empty is all of them. */
  readonly fellows: readonly string[]
  /** The day at the top of the feed, as it scrolls. */
  readonly onVisible: (date: string | null) => void
  /** The search box's text; the feed keeps the days and sections that say it. */
  readonly query?: string
}

export function RecapFeed({
  vaultName,
  control,
  compact = false,
  day: pinnedDay,
}: {
  vaultName: string
  control?: FeedControl
  /** Without the day bars and the per-Fellow settings row: Home's headline and the dossier hold those. */
  compact?: boolean
  /**
   * One night, chosen by the screen around the feed. The Library's board steps through the
   * nights from its headline, the way Home does, so the feed no longer carries a week of days
   * in its rail - what is left there is the Fellow filter, which is about WHO and not WHEN.
   */
  day?: string | null
}): React.ReactElement {
  const qc = useQueryClient()
  const recaps = useQuery({ queryKey: ['recaps'], queryFn: api.recaps, staleTime: 30_000, refetchInterval: 60_000 })
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 30_000 })
  const rows = useMemo(() => recaps.data?.recaps ?? [], [recaps.data])
  const today = localDate(new Date())

  const [weekState] = useState<string | null>(null)
  const [dayState] = useState<string | null>(null)
  /** Picked in the rail, ORed: two names show the nights either of them worked. */
  const [fellowState, setFellows] = useState<readonly string[]>([])
  const [toasts, setToasts] = useState<RecapAnswerResult[]>([])
  const [visible, setVisible] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  // The week only matters when nobody outside names a day: Home controls both, the Library
  // pins one night, and a feed left entirely to itself opens on the week that has something.
  const shownWeek = control !== undefined ? control.week : pinnedDay !== undefined && pinnedDay !== null ? weekStartOf(pinnedDay) : (weekState ?? openingWeek(rows, today))
  const day = control !== undefined ? control.day : (pinnedDay ?? dayState)
  const picked = control !== undefined ? control.fellows : fellowState
  const query = control?.query ?? ''
  const shown = useMemo(() => feedRows(rows, { week: shownWeek, day, fellows: picked }).filter((r) => recapMatches(r, query)), [rows, shownWeek, day, picked, query])

  const answer = useMutation({
    mutationFn: (input: { date: string; answers: RecapAnswer[] }) => api.answerRecap(input.date, { answers: input.answers }),
    onSuccess: (res) => {
      setToasts(res.results)
      void qc.invalidateQueries({ queryKey: ['recaps'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const build = useMutation({
    mutationFn: (force: boolean) => api.buildRecap({ force }),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['recaps'] }), 4_000),
  })

  // Which day the fact strip describes: the one at the top of the feed.
  const onVisible = control?.onVisible
  useEffect(() => {
    const root = feedRef.current
    const report = (date: string | null): void => {
      setVisible(date)
      onVisible?.(date)
    }
    if (root === null || shown.length === 0) {
      report(shown[0]?.cycleDate ?? null)
      return
    }
    report(shown[0]!.cycleDate)
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const date = (first?.target as HTMLElement | undefined)?.dataset['date']
        if (date !== undefined) report(date)
      },
      { root, rootMargin: '-8% 0px -72% 0px', threshold: 0 },
    )
    for (const el of root.querySelectorAll('[data-date]')) observer.observe(el)
    return () => observer.disconnect()
  }, [shown, onVisible])

  const state = queryState(recaps, 'the recaps')
  const status = recaps.data?.status
  /** Only the newest recap takes answers; every older one is the record of its day. */
  const newest = rows.reduce<string | null>((n, r) => (n === null || r.cycleDate > n ? r.cycleDate : n), null)
  const current = shown.find((r) => r.cycleDate === visible) ?? shown[0]
  const fellows = (agents.data?.fellows ?? []).filter((f) => f.agent.state !== 'retired')
  /** Every Fellow the service knows, retired ones too: a name in an old recap still opens its dossier. */
  const agentIdOf = (name: string): string | undefined => agents.data?.fellows.find((f) => f.agent.name === name)?.agent.id

  const pick = (a: RecapAnswer, date: string): void => answer.mutate({ date, answers: [a] })
  const followed = (page: string, agentId: string): void => api.valueEvent({ kind: 'recap_link', page, agentId })

  return (
    <>
      {current !== undefined ? (
        <RecapFacts row={current} />
      ) : (
        <div className="facts lead recap-facts-empty">
          <div className="fact lead">
            <span className="k">Recaps</span>
            <span className="v">{rows.length}</span>
            <span className="s">stored</span>
          </div>
          <div className="fact lead">
            <span className="k">Next</span>
            <span className="v">{status?.recapTime ?? '07:00'}</span>
            <span className="s">{status?.building === true ? 'building now…' : 'covers tonight'}</span>
          </div>
        </div>
      )}

      <div className={`rfeed-split${control !== undefined ? ' solo' : ''}`}>
        <div className="rfeed" ref={feedRef} tabIndex={0} aria-label="Night shift, newest first">
          {/* A Fellow's answers come back under that Fellow; only a spawn has no section. */}
          {toasts.some((t) => t.answer.action === 'spawn') && (
            <div className={`toast ${toasts.every((t) => t.ok) ? 'ok' : 'warn'}`} role="status">
              {toasts
                .filter((t) => t.answer.action === 'spawn')
                .map((t, i) => (
                  <div key={i}>
                    {t.ok ? '✓' : '✗'} {t.message}
                  </div>
                ))}
            </div>
          )}
          {answer.error != null && <div className="toast err">Answer failed: {(answer.error as Error).message}</div>}

          {shown.length === 0 ? (
            <div className="empty">
              {state ?? (
                <>
                  <h2>{rows.length === 0 ? 'No recap yet' : day !== null ? 'No recap for this day' : 'Nothing in this week'}</h2>
                  <p className="qs-line">
                    {rows.length === 0
                      ? `The first one is built at ${status?.recapTime ?? '07:00'} and covers the night's Fellow runs and their proposals.`
                      : query.trim() !== ''
                        ? 'No recap in this week says that. Esc clears the search.'
                        : day !== null
                          ? `The next one is built at ${status?.recapTime ?? '07:00'}. Press ↓ for the last one, or Esc for the week.`
                          : picked.length > 0
                        ? `${picked.join(' and ')} did not work in this week. Clear the filter to see who did.`
                        : 'No recap was stored for these days. Step back a night.'}
                  </p>
                </>
              )}
            </div>
          ) : (
            shown.map((row) => (
              <section className="rfeed-day" key={row.cycleDate} data-date={row.cycleDate} aria-label={`Recap ${row.cycleDate}`}>
                {/* Home's feed carries no day bar: the headline's date follows the scroll and the
                    column's list marks the day. The Library's board keeps its own. */}
                {!compact && (
                <div className="rfeed-head">
                  <span className="rfeed-date">{fmtDay(row.cycleDate)}</span>
                  <span className="box-sub">{nightLine(row.model)}</span>
                  <span className="spacer" />
                  {row.quiet && <span className="chip">quiet night</span>}
                  {undecidedCount(row.model) > 0 ? (
                    <span className="chip warn">{undecidedCount(row.model)} undecided</span>
                  ) : (
                    row.answeredAt !== null && <span className="chip ok">answered</span>
                  )}
                </div>
                )}
                {picked
                  .filter((name) => !workedOn(row, name))
                  .map((name) => (
                    <p className="recap-absent" key={name}>
                      <b>{name} did not work this night:</b> {absenceOf(row, name)}
                    </p>
                  ))}
                <RecapBody
                  row={row}
                  vaultName={vaultName}
                  onAnswer={(a) => pick(a, row.cycleDate)}
                  onFollow={followed}
                  busy={answer.isPending}
                  facts={false}
                  settings={!compact}
                  query={query}
                  decidable={row.cycleDate === newest}
                  results={toasts}
                  agentIdOf={agentIdOf}
                  {...(picked.length > 0 ? { only: picked } : {})}
                />
              </section>
            ))
          )}
        </div>

        {control === undefined && (
          <aside className="rrail" aria-label="Recap filters">
            <div className="rrail-sec">
              {/* What the section does, on hover rather than under it: the line was one of two
                  sentences that swapped as you picked, and the pills already show what is
                  picked. The foot says it in words when it matters. */}
              <div
                className="rrail-k"
                title="Pick one or more to see only their work; none picked is all of them. An empty slot spawns a new Fellow, each one for a domain of its own."
              >
                Fellows
              </div>
              <div className="rrail-pills">
                {fellows.slice(0, FELLOW_SLOTS).map((f) => {
                  const runs = runsInWeek(rows, shownWeek, f.agent.name)
                  const on = picked.includes(f.agent.name)
                  return (
                    <button
                      key={f.agent.id}
                      className="fpill"
                      aria-pressed={on}
                      title={on ? `Stop showing ${f.agent.name} only` : `${f.agent.name} · ${f.agent.homeDomain}`}
                      /* Several at a time: each pill is its own switch, and none picked means
                         every Fellow, which is where you start. */
                      onClick={() => setFellows((cur) => (cur.includes(f.agent.name) ? cur.filter((n) => n !== f.agent.name) : [...cur, f.agent.name]))}
                    >
                      <span className="dot" style={{ background: domainColor(f.agent.homeDomain) }} aria-hidden />
                      <span className="who">
                        <span className="nm">
                          {f.agent.name} - {titleDomain(f.agent.homeDomain)}
                        </span>
                        <span className="dm">{runs === 0 ? 'no run this week' : `${runs} run(s) this week`}</span>
                      </span>
                    </button>
                  )
                })}
                {Array.from({ length: Math.max(0, FELLOW_SLOTS - fellows.length) }, (_, i) => (
                  <button key={`slot-${i}`} className="fpill empty" onClick={() => navigate('/library?cc=1')} title="Opens the night shift in the Library">
                    <span className="dot" aria-hidden />
                    <span className="who">Spawn a Fellow</span>
                  </button>
                ))}
              </div>
            </div>

          </aside>
        )}
      </div>

      <div className={`box-foot${compact ? ' keys' : ''}`}>
        <span className="fl">
          <span>
            {shown.length} of {rows.length} recap(s)
            {day !== null ? ` · ${fmtDay(day)}` : ` · week of ${fmtWeek(shownWeek)}`}
            {picked.length > 0 ? ` · ${picked.join(' and ')} only` : ''}
          </span>
        </span>
        {/* Home's foot says how to move, in the same slot as the stream's; the Library's
            board says when the next build is. The button's tooltip says it in both. */}
        {compact ? (
          <FootKeys items={['← → step the day', 'PgUp PgDn a week', 'Esc steps back']} />
        ) : (
          <>
            <span className="spacer" />
            <span className="dim">{status !== undefined ? `Next at ${status.recapTime}` : ''}</span>
          </>
        )}
        {/* In the corner, where the stream keeps its own history action; ringed in the
            accent because it is the one action here, and the one that costs a run. */}
        <span className="fr">
          <button
            className={`btn ghost sm outline${compact ? ' wide' : ''}`}
            disabled={build.isPending || status?.building === true}
            title={`Build today's recap now, rebuilding it when today's exists. Costs a short agent run for the summary lines and rewrites the recap page in the vault; the proposals and Fellow states are current without it.${status !== undefined ? ` The next build is at ${status.recapTime}.` : ''}`}
            onClick={() => build.mutate(rows.some((r) => r.cycleDate === today))}
          >
            {status?.building === true ? 'Building…' : 'Build now'}
          </button>
        </span>
      </div>
    </>
  )
}
