/**
 * Research (SPEC.md §6.3/§6.4, redesign 2026-08-26 third pass) - the screen where you go and
 * find something out. Two ways to do that, named the same way in both places they appear:
 *
 *   WEB RESEARCH    a run that reads the web and files pages. Costs fetches, commits once.
 *   VAULT RESEARCH  a question the vault answers from what it already holds. Cites pages,
 *                   writes nothing.
 *
 * They are the same object from the user's side - something you asked, and the record of what
 * came back - so they are two ledgers of the same shape in the main box, splitting the height
 * and scrolling on their own. The columns then say how they differ.
 *
 *   LEFT   what SHAPES a run and what the runs add up to: the lens as a standing control
 *          (four profiles, a closed set), a filter over the web ledger, the running totals,
 *          and the queue as a status foot - a run takes a queue slot, the same as a drop.
 *   RIGHT  the composer, then the two ledgers, then the vault's own backlog as a band of
 *          offers. Opening a run or a conversation replaces the ledgers with that one thing
 *          and a way back.
 *
 * Every object is listed ONCE. The runs used to appear twice - a short list in the rail and a
 * full ledger in the box - which existed only because opening a run replaced the ledger and
 * left no way back; the detail view has a Back button instead.
 *
 * `/query` is still request/response - the ANSWER of record arrives with the HTTP reply - but
 * the text streams live meanwhile (chatStream). First questions stream too: the client sends
 * a request id and the server echoes it on the deltas, because the session id only exists
 * once the reply lands.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, parseCitations } from '../api/client.ts'
import type {
  GraphNode,
  AuthMode,
  ChatMessage,
  MaintenanceResult,
  ResearchProfile,
  Session,
} from '../api/types.ts'
import { Markdown } from '../components/Markdown.tsx'
import { PageLink, PageLinks } from '../components/PageLink.tsx'
import { CitationChip } from '../components/CitationChip.tsx'
import { JobLog } from '../components/JobLog.tsx'
import { useMaintenanceRun } from '../hooks/useMaintenanceRun.ts'
import { Fact, Facts } from '../components/Fact.tsx'
import { Icon, type IconName } from '../components/Icon.tsx'
import { planCorner } from '../lib/library/planCorner.ts'
import { PlanCard } from '../components/PlanCard.tsx'
import { RunActivity, AskActivity } from '../components/RunActivity.tsx'
import { useAskTrail } from '../hooks/useAskTrail.ts'
import { useJobLog } from '../hooks/useJobLog.ts'
import { deriveResearchProgress, EMPTY_PROGRESS } from '../lib/researchProgress.ts'
import { groupPages, countLine } from '../lib/wrotePages.ts'
import { queryState, merge } from '../components/QueryState.tsx'
import { navigate, pageRoute } from '../lib/router.ts'
import { openableRow } from '../lib/tableRow.ts'
import { chatStream } from '../lib/chatStream.ts'
import { timeAgo, tokens } from '../lib/format.ts'
import { Cost, ESTIMATE_LABEL, isEstimate } from '../components/Cost.tsx'
import { RowDelete } from '../components/ActivityRows.tsx'
import { buildResearchRuns, listedRuns, synthesisPage, targetTitle, type ResearchRunEntry, RESEARCH_PREFIX } from '../lib/researchRuns.ts'
import { frontmatter } from '../lib/frontmatter.ts'

type ComposerMode = 'research' | 'ask'

/**
 * A run in flight does not get a screen of its own: the step strip under the composer is
 * already showing it, in the same place it sits while idle, so starting a run changes state
 * rather than layout. `run` is a settled run picked out of the list.
 */
/**
 * `gaps` is the backlog, and it is a VIEW rather than a band under the ledgers now. It used to
 * stand there permanently, read about once a week, taking a third of the screen from the two
 * things that are read daily. It is behind the count that names it: the rail's "gaps worth a
 * run" opens it in the ledger's place, picking one fills the composer and hands the ledger
 * back, and Escape leaves it like every other opened thing.
 */
type View = { kind: 'start' } | { kind: 'run'; id: string } | { kind: 'thread'; id: string | null } | { kind: 'gaps' }

/**
 * A research topic is often a paragraph - a whole brief typed into the box. The delete
 * button names the row it removes, and a tooltip carrying 400 characters names nothing.
 */
function shortTopic(topic: string): string {
  return topic.length <= 60 ? topic : `${topic.slice(0, 57).trimEnd()}...`
}

/**
 * `m:ss` for the Took column. The run in flight counts from its start to now; a settled run
 * from its start to its end; a run whose start was never recorded (pre-v12 history) shows a
 * dash rather than a made-up zero.
 */
function took(e: ResearchRunEntry, now: number): string {
  if (e.startedAt === null) return '-'
  const end = e.status === 'running' ? now : e.finishedAt !== null ? Date.parse(e.finishedAt) : null
  if (end === null) return '-'
  const total = Math.max(0, Math.floor((end - Date.parse(e.startedAt)) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The current time, re-read once a second while `active` - so a live duration can tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** How many gaps the research backlog offers at once. */
const BACKLOG_SIZE = 40

/**
 * The mark for a lens. Keyed by the profile key the service ships (`broad`, `sota`, `patents`,
 * `startups`); a key this does not know falls back to the sweep rather than to nothing, because
 * a row with no mark would look like a different kind of row.
 */
const LENS_ICON: Record<string, IconName> = {
  broad: 'lens-broad',
  sota: 'lens-sota',
  patents: 'lens-patents',
  startups: 'lens-startups',
}
export const lensIcon = (key: string | null | undefined): IconName => LENS_ICON[key ?? 'broad'] ?? 'lens-broad'

export function Chat({ researchPrefill = '' }: { researchPrefill?: string }): React.ReactElement {
  const qc = useQueryClient()
  const [mode, setMode] = useState<ComposerMode>('research')
  const [draft, setDraft] = useState('')
  const [profileKey, setProfileKey] = useState('broad')
  const [view, setView] = useState<View>({ kind: 'start' })
  /**
   * Whether the finished-run line has been closed. Per RESULT, not forever: starting the next
   * run clears it, so dismissing one outcome never hides the next.
   */
  const [resultDismissed, setResultDismissed] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const vaultName = stats.data?.vaultName ?? 'vault'
  const authMode: AuthMode = stats.data?.authMode ?? 'oauth'

  /*
   * The plan windows, the same card the Library's corner carries (section 8.3). The question
   * it answers - can I afford this run - is asked HERE, in front of the composer, so the
   * answer belongs here too. Same query key as the Library's, so the two share one cached
   * reading rather than sampling a rate-limited endpoint twice.
   */
  const planQ = useQuery({ queryKey: ['usage-plan'], queryFn: api.usagePlan, refetchInterval: 60_000, retry: false })
  const corner = planCorner(planQ.data, Date.now())

  const sessionsQ = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })
  const sessions = sessionsQ.data?.sessions ?? []

  const threadQ = useQuery({
    queryKey: ['session', activeId],
    queryFn: () => api.session(activeId!),
    enabled: activeId !== null,
  })
  const messages = threadQ.data?.messages ?? []
  // The citation count of the newest answer - the ask strip's last step reports it.
  const lastCitations = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role === 'assistant') return parseCitations(m.citations).length
    }
    return 0
  })()

  // Live answer text (SPEC.md §6.3), a preview only. First questions have no session id
  // yet, so they stream under a client-generated request id the server echoes.
  const requestIdRef = useRef('')
  const streamKey = activeId ?? requestIdRef.current
  const streamed = useSyncExternalStore(
    (cb) => chatStream.subscribe(streamKey, cb),
    () => chatStream.snapshot(streamKey),
  )

  // What retrieval did for the answer in flight - the server says so once, before the text.
  const retrieval = useSyncExternalStore(
    (cb) => chatStream.subscribe(streamKey, cb),
    () => chatStream.retrieval(streamKey),
  )

  const ask = useMutation({
    mutationFn: (question: string) => api.query(question, activeId ?? undefined, requestIdRef.current || undefined),
    onSuccess: (res) => {
      // The real message replaces the preview - clear every key it may have streamed under.
      chatStream.clear(res.sessionId)
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      setActiveId(res.sessionId)
      setView({ kind: 'thread', id: res.sessionId })
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      void qc.invalidateQueries({ queryKey: ['session', res.sessionId] })
    },
    onError: (_e, question) => {
      chatStream.clear(streamKey)
      if (requestIdRef.current !== '') chatStream.clear(requestIdRef.current)
      // Give the typed question back instead of forcing a retype - but never clobber
      // something the user already started writing while the query was in flight.
      setDraft((current) => (current.trim() === '' ? question : current))
      void qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  /*
   * The activity box's lines for the question: the moments this tab observed, each with its
   * time. `ask.data` resets when the next question goes out, which is what starts the trail
   * over; the question itself outlives the answer in `ask.variables`, so the box can still
   * name it.
   */
  const askQuestion = typeof ask.variables === 'string' ? ask.variables : ''
  const askTrail = useAskTrail({
    pending: ask.isPending,
    retrieval,
    writing: streamed !== '',
    landed: ask.isSuccess ? ask.data.citations.length : null,
    error: ask.isError ? (ask.error as Error).message : null,
  })

  // Research lenses ("Achse A"): the closed profile list the control column offers.
  const profilesQ = useQuery({ queryKey: ['research-profiles'], queryFn: api.researchProfiles })
  const profiles = useMemo(() => profilesQ.data?.profiles ?? [], [profilesQ.data])
  const selectedProfile = profiles.find((p) => p.key === profileKey)

  // The run list: tracked runs + the synthesis pages that outlive them + failed settles.
  const historyQ = useQuery({
    queryKey: ['maintenance-history', 'research'],
    queryFn: () => api.maintenanceHistory({ kind: 'research', limit: 100 }),
  })
  const runsQ = useQuery({ queryKey: ['maintenance-runs'], queryFn: api.maintenanceRuns })
  const stateQ = useQuery({ queryKey: ['maintenance-state'], queryFn: api.maintenanceState })
  const graphQ = useQuery({ queryKey: ['graph'], queryFn: api.graph })
  const entries = useMemo(
    () =>
      listedRuns(
        buildResearchRuns({
          history: historyQ.data?.runs ?? [],
          runs: runsQ.data?.runs ?? [],
          lastRuns: stateQ.data?.areas ?? [],
          nodes: graphQ.data?.nodes ?? [],
          profiles,
        }),
      ),
    [historyQ.data, runsQ.data, stateQ.data, graphQ.data, profiles],
  )
  const liveEntry = entries.find((e) => e.status === 'running')

  // Autoresearch: topic + lens live in refs because useMaintenanceRun's starter is read at
  // click time.
  const topicRef = useRef('')
  const profileKeyRef = useRef('broad')
  const [lastTopic, setLastTopic] = useState('')
  const research = useMaintenanceRun(() => api.research(topicRef.current, profileKeyRef.current))
  const liveRunning = research.running || liveEntry !== undefined
  /*
   * The run's own log, read once here and handed to both the activity box and the list. The
   * list's Wrote cell counts the pages the run has written so far off the same lines, so the
   * two can never disagree about what the run has done.
   */
  const researchLines = useJobLog('maintenance:research', { seed: false })
  const progress = liveRunning && researchLines.length > 0 ? deriveResearchProgress(researchLines) : EMPTY_PROGRESS

  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** The thread is its own scroll container, so following it means scrolling THIS. */
  const threadRef = useRef<HTMLDivElement>(null)

  // Follow a thread as it grows, and while an answer streams - but never yank the view back
  // down when the reader scrolled up to re-read something.
  useEffect(() => {
    if (view.kind !== 'thread') return
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages.length, ask.isPending, view.kind])
  useEffect(() => {
    const el = threadRef.current
    if (el === null || streamed === '') return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [streamed])

  // The composer grows with its content (capped).
  useEffect(() => {
    const ta = composerRef.current
    if (!ta) return
    // Every screen stays MOUNTED and is hidden with `[hidden]` (App.tsx), so this runs once
    // while the Research screen has no layout at all - and an element with no layout reports
    // `scrollHeight: 0`. Writing that back pinned the field to `height: 0px`, where it stayed
    // until the first keystroke, because `draft` never changed in between. Reloading straight
    // onto /research measured a laid-out element and looked fine, which is why it read as "too
    // small until you reload". With no inline height the `rows={2}` height stands, which is
    // exactly the height this would have computed anyway.
    if (ta.offsetParent === null) return
    ta.style.height = 'auto'
    // `scrollHeight` counts content and padding but not the border, and the stylesheet is
    // border-box - so assigning it straight back made the field two pixels shorter than its
    // own content every time, which is why one line of placeholder sat clipped at the bottom.
    const border = ta.offsetHeight - ta.clientHeight
    ta.style.height = `${Math.min(160, ta.scrollHeight + border)}px`
  }, [draft])

  // A gap's "Research" landed us here with a topic: arm Research mode, drop it into the
  // composer for review (not auto-sent - the user confirms), then strip the query param so
  // this fires exactly once.
  useEffect(() => {
    if (researchPrefill === '') return
    setDraft(researchPrefill)
    setMode('research')
    setView({ kind: 'start' })
    composerRef.current?.focus()
    navigate('/research', { replace: true })
  }, [researchPrefill])

  const send = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (mode === 'ask') {
      if (ask.isPending) return
      requestIdRef.current = activeId === null ? crypto.randomUUID() : ''
      setView({ kind: 'thread', id: activeId })
      setDraft('')
      ask.mutate(text)
      return
    }
    if (research.running) return
    topicRef.current = text
    profileKeyRef.current = profileKey
    setLastTopic(text)
    setDraft('')
    setView({ kind: 'start' })
    // Per result: closing one outcome must never hide the next one.
    setResultDismissed(false)
    research.start()
  }

  /**
   * The keys, the same ones the Library gives its rooms (SPEC section 10.7), because they
   * mean the same things here.
   *
   * Left and right switch the two modes: they are two sides of one screen, and reaching for
   * the toggle to compare them costs more than the comparison. Escape walks back out of
   * whatever is open, innermost first, so a detail is never a one-way trip. Never while the
   * caret sits in a field, where the arrows move the text and Escape may be closing something
   * of the browser's.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setMode((m) => (m === 'research' ? 'ask' : 'research'))
        // The open thing belongs to the mode you are leaving, so it closes with it.
        setView({ kind: 'start' })
      } else if (e.key === 'Escape') {
        setView((v) => (v.kind === 'start' ? v : { kind: 'start' }))
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        /*
         * Up and down walk the rows of whichever list is open. The rows are already the
         * focusable, Enter-openable things (lib/tableRow.ts), so this only moves focus between
         * them - no cursor state of its own, and Enter keeps meaning what it already meant. It
         * wraps at both ends, like the Library's shelves.
         */
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.rmain .rtable tr[tabindex="0"]'))
        if (rows.length === 0) return
        e.preventDefault()
        const at = rows.indexOf(document.activeElement as HTMLElement)
        const next = at === -1 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
        rows[next]!.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // "Save to vault" (SPEC.md §6.3): a write-enabled agent run that resumes this chat's SDK
  // session and triggers the vault's /save flow. Async like the maintenance runs.
  const save = useMaintenanceRun(() => api.saveSession(activeId as string))
  const canSave = activeId !== null && messages.some((m) => m.role === 'assistant')

  /**
   * Leaving a conversation ends it as the ACTIVE one. Without this the composer would keep
   * appending to a thread the reader has walked away from - and since the ledger's "+ New"
   * button is gone (a new question is asked in the composer above, like every other run),
   * that would leave no way to start a second conversation at all.
   */
  const leaveThread = (): void => {
    setActiveId(null)
    setView({ kind: 'start' })
  }

  const openThread = (id: string | null): void => {
    setActiveId(id)
    setMode('ask')
    setView({ kind: 'thread', id })
    ask.reset()
    save.reset()
    composerRef.current?.focus()
  }

  const openEntry = (entry: ResearchRunEntry): void => {
    // A running entry has no detail to open - the strip under the composer is its view.
    setMode('research')
    setView(entry.status === 'running' ? { kind: 'start' } : { kind: 'run', id: entry.id })
  }

  const startAbout = (topic: string): void => {
    setMode('research')
    setDraft(topic)
    composerRef.current?.focus()
  }

  // What the two ledgers add up to. Runs whose cost was never recorded (they predate the run
  // log) are left out of the total rather than counted as free - the tile says how many.
  const settled = entries.filter((e) => e.status !== 'running')
  const failedRuns = entries.filter((e) => e.status === 'failed').length
  const pagesFiled = entries.reduce((sum, e) => sum + e.pages.length, 0)
  const costed = settled.filter((e) => e.costUsd !== null)
  const spend = costed.reduce((sum, e) => sum + (e.costUsd ?? 0), 0)

  // What the thread bar calls this conversation. A session that was never saved has no
  // title yet, and the sessions list already names that state "New conversation".
  const sessionTitle = activeId === null ? null : (sessions.find((s) => s.id === activeId)?.title ?? null)
  const threadTitle = sessionTitle ?? 'New conversation'

  const lensDisabled = mode === 'ask'
  const busy = mode === 'ask' ? ask.isPending : research.running
  const sendLabel = mode === 'ask' ? (ask.isPending ? 'Asking…' : 'Ask') : research.running ? 'Running…' : 'Start run'
  const gaps = graphQ.data?.gaps ?? []

  return (
    <div className="workspace research">
      <aside className="gpanel" aria-label="Research controls">
        {!lensDisabled && (
        <div className="gp-sec">
          <div className="gp-head">
            <span className="gp-eyebrow">Lens</span>
          </div>
          <div className="lenslist" role="radiogroup" aria-label="Research lens">
            {profiles.map((p) => (
              <button
                key={p.key}
                className="lensopt"
                role="radio"
                aria-checked={p.key === profileKey}
                disabled={lensDisabled}
                tabIndex={lensDisabled ? -1 : 0}
                onClick={() => setProfileKey(p.key)}
              >
                <span className="radio" aria-hidden />
                {/* The name only. What the lens DOES is stated in the console, beside the
                    composer it shapes, where it sits with the target page and the budget. */}
                <span className="lname" title={p.blurb}>
                  {p.label}
                </span>
                {/* The lens's own mark, where the run count used to stand. How often a lens
                    was used is a fact nobody acts on; the mark is, because the same one leads
                    every row of the run list - so this picker is also that list's legend. */}
                <span className="lensmark" aria-hidden>
                  <Icon name={lensIcon(p.key)} />
                </span>
              </button>
            ))}
            {profiles.length === 0 && <div className="gp-none">Loading lenses…</div>}
          </div>
        </div>
        )}

        {/* The plan, as the Library states it: which windows are how full, what an unmeasured
            run has probably added on top, and how old the reading is. */}
        {corner !== null && (
          <div className="gp-sec">
            <div className="gp-head">
              <span className="gp-eyebrow">Plan usage</span>
            </div>
            <PlanCard corner={corner} />
          </div>
        )}

        {/* What the two ledgers add up to, in the same metric-list shape Home uses. */}
        <div className="gp-sec grow">
          <div className="gp-head">
            <span className="gp-eyebrow">Research so far</span>
          </div>
          <div className="railfacts">
            <button className="vzf" onClick={() => setView({ kind: 'start' })}>
              <b>{entries.length}</b>
              <span>{failedRuns > 0 ? `runs, ${failedRuns} failed` : 'web research runs'}</span>
            </button>
            <button className="vzf" onClick={() => navigate('/catalog')}>
              <b>{pagesFiled}</b>
              <span>pages filed</span>
            </button>
            <button className="vzf" onClick={() => setView({ kind: 'start' })}>
              <b>{sessions.length}</b>
              <span>vault conversations</span>
            </button>
            <div className="vzf static">
              <b>
                <Cost value={spend} authMode={authMode} />
              </b>
              <span>
                recorded across {costed.length} run{costed.length === 1 ? '' : 's'}
              </span>
            </div>
            {mode === 'research' && (
            <button
              className="vzf"
              aria-pressed={view.kind === 'gaps'}
              onClick={() => setView(view.kind === 'gaps' ? { kind: 'start' } : { kind: 'gaps' })}
            >
              <b>{gaps.length}</b>
              <span>gaps worth a run</span>
            </button>
            )}
          </div>
        </div>

      </aside>

      {/* The screen's own column: the console, a region that swaps, and the backlog pinned
          under it - three stacked cards, the way Home stacks its zones. They used to be one
          box with hairlines between them, which gave the eye nothing to hold on to. */}
      <div className="rmain">
        {/* The console (2026-08-26): mode, topic, what the run will cost and the phases it
            goes through, in ONE raised card. These were four strips of equal value stacked
            on the same ground as the run table below them, and the tab had no visible place
            to start. The card is inset, lifted a step, and carries a rail in the mode's own
            colour - so which mode is armed is legible from the shape, not just the label. */}
        {/* The headline (2026-09-08): the mode toggle on the left, what the mode may do on the
            right - the three zones the Library keeps. The toggle used to sit in the console and
            switch only the console; it switches the whole tab now, so it stands above it. */}
        <div className="box rhead-box">
        <div className="rhead">
          <div className="seg" role="radiogroup" aria-label="Mode">
              <button
                role="radio"
                aria-checked={mode === 'research'}
                onClick={() => setMode('research')}
                title="Research a topic on the web and create new vault pages"
              >
                Web Research
              </button>
              <button
                role="radio"
                aria-checked={mode === 'ask'}
                onClick={() => setMode('ask')}
                title="Ask the vault (read-only)"
              >
                Vault Research
              </button>
            </div>
            <span className="rhead-mid">
              {mode === 'research' ? 'Reads the web, writes pages, one commit.' : 'Reads the vault only, cites every page, writes nothing.'}
            </span>
            {/* What the armed mode is ALLOWED to do. The two modes differ in exactly these
                two capabilities, and a run that can reach the web and write pages should not
                announce itself in the same faint grey as a read-only query. */}
            <span className="rhead-cap">{mode === 'research' ? 'Web access' : 'Read-only'}</span>
        </div>
        </div>
        <div className={`console${mode === 'ask' ? ' ask' : ''}`}>
          <div className="console-main">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={
                mode === 'research'
                  ? 'Name a topic - the run reads the web and files one synthesis page…'
                  : 'Ask the vault… (Enter to send, Shift+Enter for a new line)'
              }
              rows={2}
            />
            <button className="btn-run" disabled={draft.trim() === '' || busy} onClick={send}>
              {sendLabel}
            </button>
          </div>
          {/* Two rows in both modes: what the armed mode IS, then what it will do. Same
              two rows, same two heights - otherwise switching modes moved everything below
              by the difference. The lens description lives HERE rather than in the control
              rail, beside the target page and the budget it belongs with. */}
          {mode === 'research' ? (
            selectedProfile !== undefined && (
              <div className="planline">
                <div className="pl-row">
                  <span className="pl-fact">
                    <span className="pl-key">Lens</span>
                    <span className="pl-val pl-hi">{selectedProfile.label}</span>
                  </span>
                  <span className="pl-blurb" title={`Sources: ${selectedProfile.sources.join(', ')}`}>
                    {selectedProfile.blurb}
                  </span>
                </div>
                <div className="pl-row">
                  <span className="pl-fact">
                    <span className="pl-key">Files as</span>
                    <span
                      className="pl-val pl-page"
                      title={targetTitle(draft.trim() || 'your topic', selectedProfile)}
                    >
                      {targetTitle(draft.trim() || 'your topic', selectedProfile)}
                    </span>
                  </span>
                  <span className="pl-fact">
                    <span className="pl-key">Budget</span>
                    <span className="pl-val pl-fig">
                      up to <b>{selectedProfile.fetchEstimate}</b> fetches
                    </span>
                  </span>
                  <span className="pl-fact">
                    <span className="pl-key">Commits</span>
                    <span className="pl-val pl-fig">
                      <b>1</b>
                    </span>
                  </span>
                </div>
              </div>
            )
          ) : (
            <div className="planline">
              <div className="pl-row">
                <span className="pl-fact">
                  <span className="pl-key">Mode</span>
                  <span className="pl-val pl-hi">Read-only</span>
                </span>
                <span className="pl-blurb">
                  Answers come only from pages the vault already holds. No lens applies.
                </span>
              </div>
              <div className="pl-row">
                <span className="pl-fact">
                  <span className="pl-key">Cites</span>
                  <span className="pl-val">the vault pages the answer came from</span>
                </span>
                <span className="pl-fact">
                  <span className="pl-key">Fetches</span>
                  <span className="pl-val pl-fig">
                    <b>0</b>
                  </span>
                </span>
                <span className="pl-fact">
                  <span className="pl-key">Commits</span>
                  <span className="pl-val pl-fig">
                    <b>0</b>
                  </span>
                </span>
              </div>
            </div>
          )}
          {/* The step strips that used to be the console's footer moved into the activity
              box below (2026-09-08): they belong to the work in flight, not to the console
              that starts it. */}
        </div>

        {/* The agent's own section, above the list: the run in flight, or the question. */}
        {mode === 'research' && <RunActivity live={liveRunning} topic={lastTopic !== '' ? lastTopic : (liveEntry?.topic ?? '')} />}
        {mode === 'ask' && (
          <AskActivity
            question={askQuestion}
            lines={askTrail}
            pending={ask.isPending}
            streamed={streamed}
            citations={lastCitations}
            answered={messages.some((m) => m.role === 'assistant')}
          />
        )}

        {mode === 'research' && research.error !== null && (
          <div className="toast err runbanner">
            {research.error}{' '}
            <button className="btn" onClick={research.start}>
              Retry
            </button>
          </div>
        )}
        {/* A run that came back ok but owes its synthesis page reads as a WARNING, not a
            success: the pages it wrote are real and linked below, but nothing pulls them
            together, so presenting it in the green band would overstate what happened.

            One line, and it closes. A finished run is news for about as long as it takes to
            read; what is worth keeping - the pages, the cost - is in the run's own row a few
            pixels below, which is where anyone would look for it tomorrow. The band used to
            sit there until the next run, holding a strip of the screen for a fact nobody was
            still reading. */}
        {mode === 'research' && research.result?.ok === true && !resultDismissed && (
          <div className={`toast ${research.result.warning !== undefined ? 'warn' : 'ok'} runbanner`}>
            {lastTopic === '' ? 'Run finished' : `Run finished: ${lastTopic}`}
            {research.result.usage.costUsd > 0 && (
              <span>
                {' '}
                · <Cost value={research.result.usage.costUsd} authMode={authMode} />
                {isEstimate(authMode) && <span className="dim"> ({ESTIMATE_LABEL})</span>}
              </span>
            )}
            {research.result.warning !== undefined && <> - {research.result.warning}</>}
            {research.result.pages.length > 0 ? (
              <PageLinks vaultName={vaultName} paths={research.result.pages} />
            ) : (
              <> - no changes.</>
            )}
            <button className="toast-x" onClick={() => setResultDismissed(true)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {/* The region that swaps: the two ledgers, or ONE detail in their place. The
            console above and the backlog below stay mounted either way, so opening a run
            changes what fills one region and moves nothing else on the screen. */}
        <div className="rstack">
          {view.kind === 'start' && (
            <StartView
              mode={mode}
              entries={entries}
              livePaths={progress.pagePaths}
              totalRuns={entries.length}
              profiles={profiles}
              sessions={sessions}
              authMode={authMode}
              runState={queryState(merge(historyQ, runsQ, stateQ), 'the run history')}
              sessionState={queryState(sessionsQ, 'the conversations')}
              activeSessionId={activeId}
              onOpen={openEntry}
              onOpenThread={openThread}
              onSessionsChanged={() => void qc.invalidateQueries({ queryKey: ['sessions'] })}
            />
          )}

          {view.kind === 'gaps' && (
            <section className="box gaps grow">
              <div className="sub-head">
                <h3 className="sub-title">Worth a run</h3>
                <span className="box-sub">pages your vault links to but has never written</span>
                <span className="spacer" />
                <span className="count">{gaps.length}</span>
                {/* Escape does this too, but a key nobody can see is not a control. */}
                <button className="btn ghost sm" onClick={() => setView({ kind: 'start' })}>
                  Back to runs
                </button>
              </div>
              <div className="box-body gaplist">
                {queryState(graphQ, 'the knowledge gaps') ??
                  (gaps.length === 0 ? (
                    <div className="empty">No open knowledge gaps - every link resolves to a page.</div>
                  ) : (
                    gaps.slice(0, BACKLOG_SIZE).map((g) => (
                      <button
                        key={g.title}
                        className="gaprow"
                        onClick={() => {
                          // A gap is a way in, not a place to stay: the composer takes it and
                          // the list comes back.
                          setView({ kind: 'start' })
                          startAbout(g.title)
                        }}
                      >
                        <span className="nm" title={g.title}>
                          {g.title}
                        </span>
                        <span className="links">
                          {g.refBy.length} page{g.refBy.length === 1 ? '' : 's'} link{g.refBy.length === 1 ? 's' : ''} here
                        </span>
                        <span className="go">Research &rarr;</span>
                      </button>
                    ))
                  ))}
              </div>
            </section>
          )}

          {view.kind === 'run' && (
            <RunDetail
              entry={entries.find((e) => e.id === view.id)}
              profiles={profiles}
              nodes={graphQ.data?.nodes ?? []}
              vaultName={vaultName}
              onBack={() => setView({ kind: 'start' })}
              onRerun={(topic, key) => {
                setProfileKey(key ?? 'broad')
                startAbout(topic)
              }}
            />
          )}

          {view.kind === 'thread' && (
            <ThreadDetail
              title={threadTitle}
              sessionTitle={sessionTitle}
              messages={messages}
              streamed={streamed}
              pending={ask.isPending}
              pendingQuestion={typeof ask.variables === 'string' ? ask.variables : ''}
              askError={ask.isError ? (ask.error as Error).message : null}
              vaultName={vaultName}
              authMode={authMode}
              contentRef={threadRef}
              canSave={canSave}
              saving={save.running}
              saveError={save.error}
              saveResult={save.result}
              onSave={save.start}
              onBack={leaveThread}
              onAskAgain={() => {
                setMode('ask')
                composerRef.current?.focus()
              }}
            />
          )}
        </div>

      </div>
    </div>
  )
}

/**
 * The screen with nothing selected: the two ledgers, splitting the region between them.
 *
 * They are the same object from the user's side - something you asked, and the record of
 * what came back - so they are two tables of the SAME SHAPE, on one column template
 * (`.rtable`): a run's "Cost" sits over a conversation's "Cost", and the title column takes
 * whatever is left instead of the numbers being crushed against the right edge.
 */
function StartView({
  mode,
  entries,
  livePaths,
  totalRuns,
  profiles,
  sessions,
  authMode,
  runState,
  sessionState,
  activeSessionId,
  onOpen,
  onOpenThread,
  onSessionsChanged,
}: {
  /**
   * Which half of the tab is open. The two ledgers used to stand side by side, each in half
   * the width, and every reader was looking at one of them - so the mode moved up to the tab
   * (2026-09-08) and the half you are not reading is not rendered at all.
   */
  mode: ComposerMode
  entries: ResearchRunEntry[]
  /** The pages the run in flight has written so far, counted off its log. */
  livePaths: readonly string[]
  /** Runs before the lens filter, so the count can say "6 of 13" rather than lying. */
  totalRuns: number
  profiles: ResearchProfile[]
  sessions: Session[]
  authMode: AuthMode
  /** Loading/failed for the three queries the run list is built from; null once ready. */
  runState: React.ReactElement | null
  sessionState: React.ReactElement | null
  activeSessionId: string | null
  onOpen: (e: ResearchRunEntry) => void
  onOpenThread: (id: string | null) => void
  onSessionsChanged: () => void
}): React.ReactElement {
  const lensLabel = (key: string | null): string =>
    key === null ? '-' : (profiles.find((p) => p.key === key)?.label ?? key)
  const liveRow = entries.find((e) => e.status === 'running')
  const now = useNow(liveRow !== undefined)
  return (
    <>
      {mode === 'research' && (
      <section className="box ledger grow">
        <div className="sub-head">
          <h3 className="sub-title">Web Research</h3>
          <span className="box-sub">topic, lens, the pages it filed and what it cost</span>
          <span className="spacer" />
          <span className="count">
            {entries.length}
            {entries.length !== totalRuns ? ` of ${totalRuns}` : ''}
          </span>
        </div>
        <div className="box-body">
          {runState ??
            (entries.length === 0 ? (
              <div className="empty">
                {totalRuns === 0
                  ? 'No research run yet. Name a topic above, pick a lens on the left, and the run files one synthesis page.'
                  : 'No run used that lens. Clear the filter on the left to see the rest.'}
              </div>
            ) : (
              <table className="dtable rtable">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th className="c-wrote">Wrote</th>
                    <th className="c-took">Took</th>
                    <th className="num c-cost">Cost</th>
                    <th className="c-when">When</th>
                    {/* The run log is operational; a row can be taken out of it without the
                        vault noticing. Only settled runs have such a row, so the column is
                        declared once and the cell is empty for the rest. */}
                    <th className="c-acts" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    // Bound outside the JSX: the narrowing on `e.removableId` does not
                    // survive into the callback the button holds.
                    const removable = e.removableId
                    return (
                      <tr key={e.id} {...openableRow(() => onOpen(e), `Open the run about ${e.topic}`)}>
                        <td>
                          <span className="hrow-name">
                            {/* The lens leads the row, in a lane of its own so the topics of
                                four lenses still start on one x. It replaces a whole column:
                                a mark says the same thing as a word and leaves the width to
                                the topic. */}
                            <span className="lensmark rowlens" title={lensLabel(e.profileKey)}>
                              <Icon name={lensIcon(e.profileKey)} />
                            </span>
                            <span className={`hrow-dot ${e.status === 'running' ? 'running' : e.status}`} aria-hidden />
                            <span className="nm" title={e.topic}>
                              {e.topic}
                            </span>
                          </span>
                          {e.error !== null && <span className="rowerr">{e.error}</span>}
                        </td>
                        {/* What it wrote, by kind. The width is declared for the run that wrote
                            all four, so a figure that moves while a run works cannot push the
                            columns beside it sideways. */}
                        {/* Live while it runs: the pages come off the log, not the settle
                            record, and the clock ticks. Cost stays a dash until it settles - a
                            running total is not the final one, and a dash says "not known yet"
                            where a 0 would lie. */}
                        {/* One figure, live for the run in flight: the kinds are stated in the
                            opened run, where there is room for them. */}
                        <td className={`wrotec${e.status === 'running' ? ' pending' : ''}`} title={countLine(e.status === 'running' ? livePaths : e.pages)}>
                          {(() => {
                            const n = e.status === 'running' ? livePaths.length : e.pages.length
                            if (n === 0) return e.status === 'running' ? 'nothing yet' : '-'
                            return `${n} page${n === 1 ? '' : 's'}`
                          })()}
                        </td>
                        <td className={`tookc${e.status === 'running' ? ' pending' : ''}`}>{took(e, now)}</td>
                        <td className={`num dimc${e.status === 'running' ? ' pending' : ''}`}>
                          {e.costUsd !== null ? <Cost value={e.costUsd} authMode={authMode} /> : '-'}
                        </td>
                        <td className="faintc">{e.status === 'running' ? 'running' : timeAgo(e.finishedAt)}</td>
                        <td className="c-acts">
                          {removable !== null && (
                            <RowDelete label={shortTopic(e.topic)} remove={() => api.deleteRun(removable)} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ))}
        </div>
      </section>

      )}
      {mode === 'ask' && (
      <section className="box ledger grow">
        <div className="sub-head">
          <h3 className="sub-title">Vault Research</h3>
          <span className="box-sub">questions the vault answered from what it already holds</span>
          <span className="spacer" />
          <span className="count">{sessions.length}</span>
        </div>
        <div className="box-body">
          {sessionState ??
            (sessions.length === 0 ? (
              <div className="empty">
                Nothing asked yet. Ask above - the answer cites the pages it came from, and nothing is
                written.
              </div>
            ) : (
              <table className="dtable rtable">
                <thead>
                  <tr>
                    <th>Question</th>
                    {/* The lens column's counterpart. A conversation has no lens, and saying
                        so keeps the two tables on one grid instead of two. */}
                    <th>Mode</th>
                    <th className="num">Turns</th>
                    <th className="num">Cost</th>
                    <th>Last reply</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <SessionLedgerRow
                      key={s.id}
                      session={s}
                      authMode={authMode}
                      active={s.id === activeSessionId}
                      onSelect={() => onOpenThread(s.id)}
                      onChanged={onSessionsChanged}
                    />
                  ))}
                </tbody>
              </table>
            ))}
        </div>
      </section>
      )}
    </>
  )
}

/**
 * ONE detail shell, two kinds (2026-08-27).
 *
 * A run and a conversation are the same object from the reader's side, so they are read in
 * the same frame: bar, facts, chips, content, foot - five bands in one order, at one set of
 * heights. Only the words inside them differ. They used to be two constructions, and moving
 * between them shifted every row on the screen.
 *
 * The bands are props rather than children so a kind cannot quietly skip one: a conversation
 * that stated no facts and listed no cited pages was exactly the asymmetry this replaces.
 */
function DetailShell({
  kind,
  icon,
  backLabel,
  onBack,
  title,
  tag,
  state,
  action,
  facts,
  chipsKey,
  chips,
  band,
  heading,
  contentRef,
  children,
  provenance,
  footAction,
}: {
  kind: 'web' | 'vault'
  icon: 'flask' | 'chat'
  backLabel: string
  onBack: () => void
  title: string
  tag?: React.ReactNode
  state: React.ReactNode
  action: React.ReactNode
  /** The facts strip. A run has none any more - its figures are in the list it came from. */
  facts?: React.ReactNode
  chipsKey: string
  chips: React.ReactNode
  /** Replaces the flat chip band outright. A run's pages are grouped by kind; a
      conversation's citations are a flat list and keep the band. */
  band?: React.ReactNode
  /**
   * A heading at the top of the scrolling box, in place of the bar's title. A run's title used
   * to appear three times - in the bar, as a fact, and as the page's own first line - and this
   * is the one place it stands now.
   */
  heading?: React.ReactNode
  /** The scrolling element, for a caller that keeps its content scrolled to the end. */
  contentRef?: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
  provenance: React.ReactNode
  footAction: React.ReactNode
}): React.ReactElement {
  /*
   * One box that scrolls (2026-09-08). It used to be a fixed head - bar, facts, chips - over a
   * band that scrolled on its own, which spent a third of the height on figures the list
   * above had already shown. Everything is in one scrolling element now; only the bar sticks,
   * because the way back should not scroll away with the article.
   */
  return (
    <section className="box detail">
      <div className="detail-scroll" ref={contentRef}>
        <div className={`detail-bar ${kind}`}>
          <button className="backlink" onClick={onBack}>
            <Icon name="back" />
            {backLabel}
          </button>
          {heading === undefined && (
            <>
              <Icon name={icon} />
              <h3 className="detail-title" title={title}>
                {title}
              </h3>
            </>
          )}
          {tag}
          {state}
          <span className="spacer" />
          {action}
        </div>
        {heading}
        {facts !== undefined && <Facts size="lead">{facts}</Facts>}
        {band ?? (
          <div className="chipband">
            <span className="bandkey">{chipsKey}</span>
            {chips}
          </div>
        )}
        <div className="detail-content">{children}</div>
        <div className="detail-foot">
          <span className="prov">{provenance}</span>
          <span className="spacer" />
          {footAction}
        </div>
      </div>
    </section>
  )
}

/**
 * The pages a run wrote, grouped by kind (2026-09-08).
 *
 * The band was a flat row of chips in a container fixed at two rows' height, so a run that
 * wrote nine pages showed four and put the rest behind a scrollbar - and printed the kind on
 * every chip, which is the same word four times over. Now the kind is a column label stated
 * once, the names take the full width, and a group longer than `PILLS_SHOWN` ends in a
 * control that opens the rest in place. Nothing is behind a scrollbar.
 */
const PILLS_SHOWN = 4

function WroteBand({ paths, vaultName, empty }: { paths: readonly string[]; vaultName: string; empty: string }): React.ReactElement {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const groups = groupPages(paths)
  if (groups.length === 0) return <div className="wroteband empty-band">{empty}</div>
  return (
    <div className="wroteband">
      {groups.map((g) => {
        const all = open[g.kind] === true
        const shown = all ? g.paths : g.paths.slice(0, PILLS_SHOWN)
        const rest = g.paths.length - shown.length
        return (
          <div key={g.kind} className="wrow">
            <span className="wkey">{g.name}</span>
            <span className="wpills">
              {shown.map((path) => (
                <PageLink key={path} vaultName={vaultName} path={path} plain />
              ))}
              {(rest > 0 || all) && g.paths.length > PILLS_SHOWN && (
                <button className="chip more" onClick={() => setOpen({ ...open, [g.kind]: !all })}>
                  {rest > 0 ? `+${rest} more` : 'show fewer'}
                </button>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** A settled run from the list: its facts, its pages, and the way to run the topic again. */
function RunDetail({
  entry,
  profiles,
  nodes,
  vaultName,
  onBack,
  onRerun,
}: {
  entry: ResearchRunEntry | undefined
  profiles: ResearchProfile[]
  /** The graph's pages, to resolve the synthesis page by the name it calls itself. */
  nodes: readonly GraphNode[]
  vaultName: string
  onBack: () => void
  onRerun: (topic: string, profileKey: string | null) => void
}): React.ReactElement {
  if (entry === undefined) return <div className="empty">That run is no longer in the list.</div>
  const profile = profiles.find((p) => p.key === entry.profileKey)
  return (
    <RunDetailBody
      entry={entry}
      profile={profile}
      profiles={profiles}
      nodes={nodes}
      vaultName={vaultName}
      onBack={onBack}
      onRerun={onRerun}
    />
  )
}

/**
 * The body, split off so the article below it may use hooks - the guard above returns early
 * and hooks cannot live after that.
 */
function RunDetailBody({
  entry,
  profile,
  profiles,
  nodes,
  vaultName,
  onBack,
  onRerun,
}: {
  entry: ResearchRunEntry
  profile: ResearchProfile | undefined
  profiles: ResearchProfile[]
  nodes: readonly GraphNode[]
  vaultName: string
  onBack: () => void
  onRerun: (topic: string, profileKey: string | null) => void
}): React.ReactElement {
  const articlePath = synthesisPage(entry, profiles, nodes)
  const article = useQuery({
    queryKey: ['page-full', articlePath],
    queryFn: () => api.pageFull(articlePath as string),
    enabled: articlePath !== null,
  })
  const raw = article.data ? frontmatter(article.data.markdown).body : ''
  // The page's own first line is its title, which the heading above it already states: the
  // third copy of the same words on one screen, and the one that scrolled.
  const body = raw.replace(/^\s*#\s[^\n]*\n+/, '')
  // What the run FILED, which is not always what the deterministic title predicted - the
  // agent names the page itself. The heading shows the real one, without the prefix every
  // synthesis page carries: the lens mark beside it says what kind of page this is.
  const filedTitle = articlePath !== null ? (articlePath.split('/').pop() ?? '').replace(/\.md$/, '') : null
  const heading = (filedTitle ?? entry.topic).replace(new RegExp(`^${RESEARCH_PREFIX}`), '')
  return (
    <DetailShell
      kind="web"
      icon="flask"
      backLabel="All runs"
      onBack={onBack}
      title={entry.topic}
      heading={
        <div className="art-head">
          <span className="art-lens" title={profile?.label ?? 'lens'}>
            <Icon name={lensIcon(entry.profileKey)} />
          </span>
          <h2 className="art-title" title={heading}>
            {heading}
          </h2>
        </div>
      }
      state={<span className={`badge ${entry.status === 'failed' ? 'failed' : 'ok'}`}>{entry.status}</span>}
      action={
        <button className="btn sm" onClick={() => onRerun(entry.topic, entry.profileKey)}>
          Run again
        </button>
      }
      chipsKey="Wrote"
      chips={null}
      band={<WroteBand paths={entry.pages} vaultName={vaultName} empty="This run wrote no page of its own." />}
      provenance={
        entry.source === 'state'
          ? 'From the restart-proof settle record - the run wrote no page.'
          : entry.source === 'run'
            ? 'From the run record the service still holds in memory.'
            : 'From the run log - recorded when the run settled, and kept across restarts.'
      }
      footAction={
        articlePath !== null ? (
          <>
            {/* Both land on the page. The graph is asked to drop every filter first, so the
                page is seen among everything rather than inside the last visit's narrowing;
                the reader opens the page itself, the way a catalog row does. */}
            <button className="btn sm" onClick={() => navigate(`/graph?focus=${encodeURIComponent(articlePath)}&all=1`)}>
              <Icon name="graph" />
              View in graph
            </button>
            <button className="btn sm" onClick={() => navigate(pageRoute(articlePath))}>
              <Icon name="file" />
              Open page
            </button>
          </>
        ) : null
      }
    >
      {entry.error !== null && <div className="toast err">{entry.error}</div>}
      {articlePath === null ? (
        /* Two different things wear the same empty state, and conflating them sent the reader
           looking for a dashboard bug when the run itself was incomplete. A run that filed
           pages but no synthesis DID work, it just owes the page that pulls the work together;
           a run that filed nothing is a different problem. Both offer the one repair there is. */
        <div className="empty">
          {entry.pages.length > 0 ? (
            <>
              This run filed {entry.pages.length} {entry.pages.length === 1 ? 'page' : 'pages'} but no
              synthesis page. They are listed above and are safely in the vault, but nothing pulls
              them together, so there is no page to show here.
            </>
          ) : (
            <>
              This run committed no page at all, so there is nothing to show. Its log may say why.
            </>
          )}{' '}
          <button className="btn sm" onClick={() => onRerun(entry.topic, entry.profileKey)}>
            Run the topic again
          </button>
        </div>
      ) : article.isPending ? (
        <div className="empty">Loading the page…</div>
      ) : article.isError ? (
        <div className="empty">That page could not be read: {(article.error as Error).message}</div>
      ) : (
        <Markdown source={body} />
      )}
    </DetailShell>
  )
}

/**
 * A conversation, in the same five bands as a run. What differs is what fills them: a run
 * states what it filed and wrote, a conversation what it asked and cited.
 */
function ThreadDetail({
  title,
  sessionTitle,
  messages,
  streamed,
  pending,
  pendingQuestion,
  askError,
  vaultName,
  authMode,
  contentRef,
  canSave,
  saving,
  saveError,
  saveResult,
  onSave,
  onBack,
  onAskAgain,
}: {
  title: string
  sessionTitle: string | null
  messages: ChatMessage[]
  streamed: string
  pending: boolean
  pendingQuestion: string
  askError: string | null
  vaultName: string
  authMode: AuthMode
  contentRef: React.RefObject<HTMLDivElement | null>
  canSave: boolean
  saving: boolean
  saveError: string | null
  saveResult: MaintenanceResult | undefined
  onSave: () => void
  onBack: () => void
  onAskAgain: () => void
}): React.ReactElement {
  // Every page the conversation cited, once, in the order it first cited them - the
  // counterpart of the pages a run wrote.
  const cited = new Map<string, string>()
  let cost = 0
  let costed = false
  for (const m of messages) {
    if (m.cost_usd !== null) {
      cost += m.cost_usd
      costed = true
    }
    for (const c of parseCitations(m.citations)) {
      if (c.path !== null && c.path !== undefined && !cited.has(c.path)) cited.set(c.path, c.label)
    }
  }
  const answers = messages.filter((m) => m.role === 'assistant')
  const asked = messages.find((m) => m.role === 'user')?.content ?? title
  const lastTs = messages.length > 0 ? (messages[messages.length - 1]?.ts ?? null) : null

  return (
    <DetailShell
      kind="vault"
      icon="chat"
      backLabel="All conversations"
      onBack={onBack}
      title={title}
      tag={<span className="lens-tag">Read-only</span>}
      state={
        <span className={`badge ${answers.length > 0 ? 'ok' : 'queued-badge'}`}>
          {answers.length > 0 ? 'answered' : 'new'}
        </span>
      }
      action={
        <button className="btn sm" onClick={onAskAgain}>
          Ask again
        </button>
      }
      facts={
        <>
          <Fact k="Asked" v={<span className="mono-meta">{asked}</span>} />
          <Fact k="When" v={timeAgo(lastTs)} />
          <Fact k="Turns" v={messages.length} />
          <Fact k="Cost" v={costed ? <Cost value={cost} authMode={authMode} /> : 'not kept'} />
          <Fact k="Pages cited" v={cited.size} />
        </>
      }
      chipsKey="Cited"
      chips={
        cited.size > 0 ? (
          [...cited.keys()].map((path) => <CitationChip key={path} vaultName={vaultName} path={path} />)
        ) : (
          <span className="empty">No answer here cited a page yet.</span>
        )
      }
      contentRef={contentRef}
      provenance="Read-only. Nothing was written and nothing was fetched from the web."
      footAction={
        canSave ? (
          <button className="btn" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save conversation to vault'}
          </button>
        ) : null
      }
    >
      <div className="thread">
        {messages.length === 0 && !pending && askError === null && (
          <div className="chat-empty">
            <div className="icon">
              <Icon name="chat" />
            </div>
            <p>Ask the vault anything - answers cite the underlying wiki pages as clickable chips.</p>
            <p className="dim">
              Read-only: nothing is written, nothing is fetched from the web. Switch the composer to{' '}
              <strong>Web Research</strong> for that.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          // A conversation is NAMED after its first question, and that name is in the bar
          // above. Repeating it as the opening bubble says the same thing twice.
          const isTitleEcho =
            i === 0 && m.role === 'user' && sessionTitle !== null && m.content.trim() === sessionTitle.trim()
          if (isTitleEcho) return null
          return <Bubble key={m.id} message={m} vaultName={vaultName} authMode={authMode} />
        })}

        {pending && (
          <>
            <div className="bubble user">
              <div className="bubble-body">{pendingQuestion}</div>
            </div>
            <div className="bubble assistant">
              {streamed === '' ? (
                <div className="bubble-body typing">thinking…</div>
              ) : (
                // Plain text while streaming, not Markdown: the buffer is mid-sentence by
                // definition, and half-parsed markup would flicker as it completes.
                <div className="bubble-body streaming">{streamed}</div>
              )}
            </div>
          </>
        )}
        {askError !== null && (
          <div className="bubble system">
            <div className="bubble-body">Error: {askError}</div>
          </div>
        )}

        {saving && <JobLog jobId="maintenance:save" seed={false} />}
        {saveError !== null && <div className="toast err">{saveError}</div>}
        {saveResult?.ok === true && (
          <div className="toast ok">
            Session saved
            {saveResult.pages.length > 0 ? (
              <PageLinks vaultName={vaultName} paths={saveResult.pages} />
            ) : (
              <> - no new pages.</>
            )}
          </div>
        )}
      </div>
    </DetailShell>
  )
}

/**
 * One conversation as a ledger row: the question, how many turns it took, when it last
 * answered, and the two actions it owns. Rename is an inline input (no `window.prompt` -
 * blocked and ugly in installed PWAs) and delete is two-step, both unchanged from the rail
 * row this replaces; what changed is that a conversation is now listed in the same shape as
 * a research run, because from the user's side they are the same kind of thing.
 */
function SessionLedgerRow({
  session,
  authMode,
  active,
  onSelect,
  onChanged,
}: {
  session: Session
  authMode: AuthMode
  active: boolean
  onSelect: () => void
  onChanged: () => void
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    [],
  )

  const commitRename = async (): Promise<void> => {
    setEditing(false)
    const trimmed = title.trim()
    if (trimmed !== '' && trimmed !== (session.title ?? '')) {
      await api.renameSession(session.id, trimmed)
      onChanged()
    }
  }

  const del = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    await api.deleteSession(session.id)
    onChanged()
  }

  return (
    <tr className={active ? 'active' : undefined}>
      <td>
        {editing ? (
          <input
            className="session-rename"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            aria-label="Rename conversation"
          />
        ) : (
          <span
            className="hrow-name"
            {...openableRow(onSelect, `Open the conversation ${session.title ?? 'untitled'}`)}
          >
            <span className="hrow-dot done" aria-hidden />
            <span className="nm" title={session.title ?? 'untitled'}>
              {session.title ?? 'New conversation'}
            </span>
          </span>
        )}
      </td>
      {/* The lens column's counterpart: a conversation has one mode and no lens. */}
      <td className="dimc">Read-only</td>
      <td className="num dimc">{session.message_count ?? '-'}</td>
      <td className="num dimc">
        {session.cost_usd !== null && session.cost_usd !== undefined ? (
          <Cost value={session.cost_usd} authMode={authMode} />
        ) : (
          '-'
        )}
      </td>
      <td className="faintc">{timeAgo(session.last_ts ?? session.created_at)}</td>
      {/* The flex row is a span INSIDE the cell. A `td` set to `display: flex` drops out of
          the table layout: this one stopped taking its 10% column, so the active row's
          background ended three columns in, and its `opacity` made the cell its own layer
          with a seam down the edge. Same rule as the library's `.lt-cell`. */}
      <td className="lt-acts-cell">
        <span className="rowacts">
          <button
            className="session-act"
            onClick={() => {
              setTitle(session.title ?? '')
              setEditing(true)
            }}
            title="Rename"
            aria-label="Rename conversation"
          >
            <Icon name="edit" />
          </button>
          <button
            className={`session-act${confirming ? ' danger' : ''}`}
            onClick={() => void del()}
            title={confirming ? 'Really delete?' : 'Delete'}
            aria-label={confirming ? 'Confirm delete' : 'Delete conversation'}
          >
            {confirming ? 'Really?' : <Icon name="x" />}
          </button>
        </span>
      </td>
    </tr>
  )
}

function Bubble({
  message,
  vaultName,
  authMode,
}: {
  message: ChatMessage
  vaultName: string
  authMode: AuthMode
}): React.ReactElement {
  const citations = parseCitations(message.citations)
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (message.role !== 'assistant') {
    return (
      <div className={`bubble ${message.role}`}>
        <div className="bubble-body">{message.content}</div>
        <div className="bubble-ts">{timeAgo(message.ts)}</div>
      </div>
    )
  }

  // Every answer keeps its own usage (persisted since v6); older rows simply have none.
  const hasUsage = message.tokens_out !== null
  return (
    <div className="bubble assistant">
      <div className="bubble-body">
        <Markdown source={message.content} />
      </div>
      <div className="bfoot">
        {citations.length > 0 && (
          <>
            <span className="cites-label">Sources</span>
            <span className="pages">
              {citations.map((c, i) =>
                c.path ? (
                  <CitationChip key={`${c.label}-${i}`} vaultName={vaultName} path={c.path} />
                ) : (
                  <span key={`${c.label}-${i}`} className="pagelink unresolved" title="Page not found in the vault">
                    {c.label}
                  </span>
                ),
              )}
            </span>
          </>
        )}
        <span className="bact">
          <span className="busage">
            {timeAgo(message.ts)}
            {hasUsage && (
              <>
                {' · '}
                {tokens((message.tokens_in ?? 0) + (message.tokens_out ?? 0))} tok ·{' '}
                <Cost value={message.cost_usd} authMode={authMode} />
              </>
            )}
          </span>
          <button onClick={copy} title="Copy answer as markdown">
            <Icon name="copy" /> {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </div>
    </div>
  )
}
