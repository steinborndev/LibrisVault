/**
 * The Fellow command centre (docs/tasks/TASKS-A7.md).
 *
 * Opens over the room in the frame a department gets, and takes the same two-line headline:
 * the shelf's name in the middle of the row above, what is there in the row below. The
 * rotation therefore lives in `LibraryScreen` and arrives as props - the headline belongs to
 * the screen, the body to the window - and while the window is open the room's own controls
 * stand down: no mode toggle, no room strip, and the arrow keys reach the window rather than
 * paging the room behind it.
 *
 * REPRESENTATIVE MOCKUP. The components are real and this is what the window will look like;
 * the data comes from `lib/command/fixture.ts`, because three of the things it draws do not
 * exist in the service yet (A7 section 3.3: the full sweep, an art per Fellow, an order for
 * the domains). Reachable from "Manage Fellows" or `/library?cc=1`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ART_TEXT,
  AUTONOMY_TEXT,
  DOMAINS,
  DRIFT_THRESHOLD,
  SHAPES,
  UNSTAFFED,
  fellowsIn,
  staffedIn,
  taskMinutes,
  taskUsd,
  tonightTasks,
  type CcDomain,
  type CcFellow,
  type CcOption,
  type CcShape,
} from '../../lib/command/fixture.ts'
import { domainColor } from '../../lib/domains.ts'
import { navigate, pageRoute } from '../../lib/router.ts'
import type { TaskKind } from '../../api/types.ts'

export type CcView = 'tonight' | 'dossier' | 'decisions' | 'spawn'
type Pane = 'notebook' | 'recap' | 'ledger' | 'pages' | 'settings'

/** The scale the window setter is drawn on: 18:00 to 12:00 the next day, in minutes. */
const SCALE_FROM = 18 * 60
const SCALE_TO = 36 * 60
const pad2 = (n: number): string => String(n).padStart(2, '0')
const hhmm = (m: number): string => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(Math.round(m) % 60)}`
const dur = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)} h ${pad2(Math.round(m % 60))}` : `${Math.round(m)} min`)

interface Block {
  readonly domain: CcDomain
  readonly fellow: CcFellow
  readonly kind: TaskKind
  readonly text: string
  readonly minutes: number
  readonly from: number
  readonly to: number
  /** A task whose Fellow asks before every run does not start on its own. */
  readonly waits: boolean
}

export interface CommandCentreProps {
  /** Which stop of the rotation; one past the staffed shelves is the unstaffed screen. */
  readonly stop: number
  readonly setStop: (n: number) => void
  readonly order: readonly string[]
  readonly setOrder: (o: readonly string[]) => void
  readonly view: CcView
  readonly setView: (v: CcView) => void
  readonly onClose: () => void
}

export function CommandCentre({ stop, setStop, order, setOrder, view, setView, onClose }: CommandCentreProps): React.ReactElement {
  const [fellowId, setFellowId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('notebook')
  const [decIndex, setDecIndex] = useState(0)
  const [optIndex, setOptIndex] = useState(0)
  const [shapeIndex, setShapeIndex] = useState(0)
  const [gearOpen, setGearOpen] = useState(false)
  const [row, setRow] = useState(0)
  const [winFrom, setWinFrom] = useState(25 * 60)
  const [winTo, setWinTo] = useState(30 * 60)
  const [decided, setDecided] = useState<Record<string, 'approved' | 'vetoed'>>({})
  const trackRef = useRef<HTMLDivElement>(null)

  const staffed = useMemo(() => staffedIn(order), [order])
  const roster = useMemo(() => fellowsIn(order), [order])
  const atShelves = stop >= staffed.length
  const domain = staffed[Math.min(stop, staffed.length - 1)]!
  const stops = staffed.length + 1

  const deciders = useMemo(
    () => DOMAINS.flatMap((d) => d.fellows.filter((f) => f.options.some((o) => decided[o.id] === undefined)).map((f) => ({ d, f }))),
    [decided],
  )
  const fellow = fellowId === null ? undefined : roster.find((r) => r.fellow.id === fellowId)?.fellow

  /*
   * The night, whole. Every Fellow shares one window and runs are serialized on the run mutex,
   * so a schedule drawn per domain would show four domains each fitting comfortably into a
   * night that cannot hold their sum (A7 D9).
   */
  const blocks = useMemo(() => {
    const out: Block[] = []
    let cur = winFrom
    for (const d of staffed) {
      for (const f of d.fellows) {
        for (const t of tonightTasks(f)) {
          const minutes = taskMinutes(t.kind)
          out.push({ domain: d, fellow: f, kind: t.kind, text: t.text, minutes, from: cur, to: cur + minutes, waits: f.autonomy === 'manual' })
          cur += minutes
        }
      }
    }
    return out
  }, [staffed, winFrom])

  const span = winTo - winFrom
  const booked = blocks.reduce((n, b) => n + b.minutes, 0)
  const here = blocks.filter((b) => b.domain.key === domain.key).reduce((n, b) => n + b.minutes, 0)
  const overflow = blocks.filter((b) => b.to > winTo)

  /** Contiguous runs of one shelf: the unit you read, divided by hairlines into its topics. */
  const bands = useMemo(() => {
    const out: Array<{ domain: CcDomain; from: number; to: number; parts: Block[] }> = []
    for (const b of blocks) {
      const last = out[out.length - 1]
      if (last && last.domain === b.domain) {
        last.to = b.to
        last.parts.push(b)
      } else out.push({ domain: b.domain, from: b.from, to: b.to, parts: [b] })
    }
    return out
  }, [blocks])

  /* One label per full hour, with a gridline under each: an axis, not four stray numbers. */
  const hours = useMemo(() => {
    const out: number[] = []
    for (let m = Math.ceil(winFrom / 60) * 60; m <= winTo; m += 60) out.push(m)
    return out
  }, [winFrom, winTo])

  /** Opening a Fellow puts the rotation on its shelf, so the headline never lies about where you are. */
  const openFellow = (id: string): void => {
    const at = roster.findIndex((r) => r.fellow.id === id)
    if (at < 0) return
    setFellowId(id)
    setPane('notebook')
    setStop(staffed.indexOf(roster[at]!.domain))
    setView('dossier')
  }

  /** Left and right in a dossier walk the whole roster, across shelves; the headline follows. */
  const stepFellow = (delta: number): void => {
    if (roster.length === 0) return
    const at = roster.findIndex((r) => r.fellow.id === fellowId)
    const next = roster[((at < 0 ? 0 : at) + delta + roster.length) % roster.length]!
    setFellowId(next.fellow.id)
    setStop(staffed.indexOf(next.domain))
  }

  const back = (): void => {
    if (view === 'tonight') onClose()
    else {
      setView('tonight')
      setGearOpen(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        back()
        return
      }
      if (view === 'dossier') {
        const order: Pane[] = ['notebook', 'recap', 'ledger', 'pages', 'settings']
        const n = Number(e.key)
        if (n >= 1 && n <= 5) setPane(order[n - 1]!)
        else if (e.key === 'ArrowRight') {
          e.preventDefault()
          stepFellow(1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          stepFellow(-1)
        }
        return
      }
      if (view === 'decisions') {
        if (deciders.length === 0) return
        const cur = deciders[Math.min(decIndex, deciders.length - 1)]!.f
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          setDecIndex((i) => (i + 1) % deciders.length)
          setOptIndex(0)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          setDecIndex((i) => (i - 1 + deciders.length) % deciders.length)
          setOptIndex(0)
        } else if (e.key === 'j') setOptIndex((i) => Math.min(cur.options.length - 1, i + 1))
        else if (e.key === 'k') setOptIndex((i) => Math.max(0, i - 1))
        else if (e.key === 'a' || e.key === 'v') {
          const opt = cur.options[optIndex]
          if (opt) setDecided((d) => ({ ...d, [opt.id]: e.key === 'a' ? 'approved' : 'vetoed' }))
        }
        return
      }
      if (view === 'spawn') {
        if (e.key === 'ArrowRight') setShapeIndex((i) => (i + 1) % SHAPES.length)
        else if (e.key === 'ArrowLeft') setShapeIndex((i) => (i - 1 + SHAPES.length) % SHAPES.length)
        else if (e.key === 'c') setGearOpen((g) => !g)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setStop((stop - 1 + stops) % stops)
        setRow(0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setStop((stop + 1) % stops)
        setRow(0)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setRow(Math.min((atShelves ? UNSTAFFED.length : domain.fellows.length) - 1, row + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setRow(Math.max(0, row - 1))
      } else if (e.key === 'Enter' && !atShelves) {
        const f = domain.fellows[row]
        if (f) openFellow(f.id)
      } else if (e.key === 'n') {
        setShapeIndex(0)
        setGearOpen(false)
        setView('spawn')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* Dragging a band reorders the night: it is one serial queue, so the order IS the schedule. */
  const startDrag = (key: string) => (e: React.MouseEvent): void => {
    e.preventDefault()
    const move = (ev: MouseEvent): void => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const keys = staffed.map((d) => d.key)
      let acc = 0
      let target = keys.length - 1
      for (let i = 0; i < keys.length; i++) {
        const w = blocks.filter((b) => b.domain.key === keys[i]).reduce((n, b) => n + b.minutes, 0) / span
        if (x < acc + w) {
          target = i
          break
        }
        acc += w
      }
      const from = keys.indexOf(key)
      if (from >= 0 && from !== target) {
        const next = [...keys]
        next.splice(target, 0, next.splice(from, 1)[0]!)
        setOrder(next)
      }
    }
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const dragEdge = (edge: 'from' | 'to') => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const track = (e.currentTarget as HTMLElement).closest('.cc-setter-track')
    const move = (ev: MouseEvent): void => {
      const rect = track?.getBoundingClientRect()
      if (!rect) return
      const m = SCALE_FROM + Math.round((((ev.clientX - rect.left) / rect.width) * (SCALE_TO - SCALE_FROM)) / 15) * 15
      if (edge === 'from') setWinFrom(Math.max(SCALE_FROM, Math.min(m, winTo - 60)))
      else setWinTo(Math.min(SCALE_TO, Math.max(m, winFrom + 60)))
    }
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  return (
    <div className="lib-window cc" role="dialog" aria-label="Fellow command centre">
      {view === 'tonight' && !atShelves && (
        <>
          <div className="cc-line2">
            <span className="cc-lead">
              <b>Tonight</b>
              <span className="cc-sub">
                {blocks.length} task{blocks.length === 1 ? '' : 's'} across {new Set(blocks.map((b) => b.domain.key)).size} shelves ·{' '}
                <b>{dur(booked)}</b> of {dur(span)} · {dur(here)} of that here
              </span>
            </span>
            <span className="grow" />
            <span className="mono-meta">{domain.fellows.length} Fellows · {domain.pages} pages</span>
            <button className="btn sm" onClick={() => { setShapeIndex(0); setGearOpen(false); setView('spawn') }}>New Fellow</button>
          </div>

          <div className="lib-window-body cc-body">
            <section className="cc-block">
              <h3 className="cc-sec">
                The window
                <span className="grow" />
                <span className="c">drag either end · every Fellow shares it</span>
              </h3>
              <div className="cc-setter">
                <div className="cc-setter-scale">
                  {[18, 21, 0, 3, 6, 9, 12].map((h) => <span key={h}>{pad2(h)}</span>)}
                </div>
                <div className="cc-setter-track">
                  <div
                    className="cc-setter-win"
                    style={{ left: `${((winFrom - SCALE_FROM) / (SCALE_TO - SCALE_FROM)) * 100}%`, width: `${(span / (SCALE_TO - SCALE_FROM)) * 100}%` }}
                  >
                    <span className="h l" onMouseDown={dragEdge('from')} />
                    <span className="h r" onMouseDown={dragEdge('to')} />
                  </div>
                </div>
                <div className="cc-setter-legend">
                  <b>{hhmm(winFrom)} – {hhmm(winTo)}</b>
                  <span>{dur(span)}</span>
                </div>
              </div>
            </section>

            <section className="cc-block">
              <h3 className="cc-sec">
                The queue
                <span className="grow" />
                <span className="c">one run at a time, planning included · drag a shelf to move it</span>
              </h3>
              <div className="cc-axis">
                {hours.map((m) => (
                  <span key={m} className="cc-hour" style={{ left: `${((m - winFrom) / span) * 100}%` }}>{hhmm(m)}</span>
                ))}
              </div>
              <div className="cc-track" ref={trackRef}>
                {hours.slice(1, -1).map((m) => (
                  <span key={m} className="cc-grid" style={{ left: `${((m - winFrom) / span) * 100}%` }} />
                ))}
                {bands.map((g) => (
                  <div
                    key={`${g.domain.key}-${g.from}`}
                    className={`cc-band ${g.domain.key === domain.key ? 'here' : ''}`}
                    style={{ left: `${((g.from - winFrom) / span) * 100}%`, width: `${Math.max(0.6, ((g.to - g.from) / span) * 100)}%`, ['--dc' as string]: domainColor(g.domain.key) }}
                    title={`${g.domain.key} — ${g.parts.length} task(s), ${dur(g.to - g.from)} · drag to move it in the queue`}
                    onMouseDown={startDrag(g.domain.key)}
                  >
                    <span className="cc-parts">
                      {g.parts.map((b, i) => (
                        <span
                          key={`${b.fellow.id}-${b.text}`}
                          className="cc-part"
                          style={{ width: `${(b.minutes / (g.to - g.from)) * 100}%`, borderLeft: i > 0 ? '1px solid rgba(255,255,255,.55)' : undefined }}
                          title={`${b.fellow.name} · ${b.kind}: ${b.text} · ${dur(b.minutes)}, planning included`}
                        />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
              <div className="cc-legend">
                {staffed.filter((d) => blocks.some((b) => b.domain.key === d.key)).map((d) => (
                  <span key={d.key}>
                    <i style={{ background: domainColor(d.key), ...(d.key === domain.key ? { outline: '2px solid var(--text)', outlineOffset: '1px' } : { opacity: 0.5 }) }} />
                    {d.key}
                  </span>
                ))}
              </div>
              {overflow.length > 0 ? (
                <p className="cc-note warn">
                  <b>{overflow.length} task{overflow.length === 1 ? ' does' : 's do'} not fit tonight.</b> The night is one
                  queue for every Fellow, not one per shelf: {dur(booked)} of work against a {dur(span)} window. Widen the
                  window, put a Fellow on <b>one task a night</b>, or leave it — what does not fit stands for tomorrow.
                </p>
              ) : blocks.some((b) => b.waits) ? (
                <p className="cc-note">
                  {blocks.filter((b) => b.waits).length} of tonight’s {blocks.length} tasks belong to a Fellow set to{' '}
                  <b>ask me every time</b> — those wait for you. The rest run unless you veto them during the day.
                </p>
              ) : (
                <p className="cc-note">
                  Everything here runs on its own. What a Fellow proposes tonight runs tomorrow night unless you veto it.
                </p>
              )}
            </section>

            <section className="cc-block">
              <h3 className="cc-sec">
                Fellows of this shelf <span className="c">{domain.fellows.length}</span>
                <span className="grow" />
                <span className="c">↑ ↓ to walk · ↵ to open</span>
              </h3>
              <div className="cc-rows">
                {domain.fellows.map((f, i) => {
                  const mine = tonightTasks(f)
                  const minutes = mine.reduce((n, t) => n + taskMinutes(t.kind), 0)
                  const quiet = f.tasks.length > 0 && f.tasks.every((t) => t.resting === true)
                  return (
                    <div key={f.id} className={`cc-row ${i === row ? 'sel' : ''}`} onClick={() => { setRow(i); openFellow(f.id) }}>
                      <span className="cc-id">
                        <span className="cc-idline">
                          <b>{f.name}</b>
                          <span className={`sev ${f.state === 'working' ? 'rec' : f.state === 'paused' ? 'mut' : 'ok'}`}>{f.state}</span>
                        </span>
                        <span className="cc-t">{quiet ? `all ${f.tasks.length} questions answered — nothing standing` : f.intent}</span>
                      </span>
                      <span className="cc-right">
                        {mine.length === 0 ? (
                          <button
                            className="cc-link quiet"
                            onClick={(e) => { e.stopPropagation(); setFellowId(f.id); setPane('settings'); setView('dossier') }}
                          >
                            Assign a new task ›
                          </button>
                        ) : (
                          <>
                            <span className="sev ok" title={f.mode === 'sweep' ? 'every standing task, tonight' : `one task a night — each comes round every ${f.tasks.length} nights`}>
                              {f.mode === 'sweep' ? `all ${mine.length} tonight` : `1 of ${f.tasks.length}, rotating`}
                            </span>
                            <span className="mono-meta">{Math.round(minutes)} min</span>
                          </>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </>
      )}

      {view === 'tonight' && atShelves && <Shelves row={row} onStaff={() => { setShapeIndex(0); setView('spawn') }} />}
      {view === 'dossier' && fellow && <Dossier fellow={fellow} pane={pane} setPane={setPane} onBack={back} onStep={stepFellow} />}
      {view === 'decisions' && (
        <Decisions
          list={deciders}
          at={Math.min(decIndex, Math.max(0, deciders.length - 1))}
          opt={optIndex}
          decided={decided}
          span={span}
          onPick={(i) => { setDecIndex(i); setOptIndex(0) }}
          onOpt={setOptIndex}
          onDecide={(id, how) => setDecided((d) => ({ ...d, [id]: how }))}
          onBack={back}
        />
      )}
      {view === 'spawn' && (
        <Spawn shelf={domain.key} shape={SHAPES[shapeIndex]!} index={shapeIndex} gear={gearOpen} onShape={setShapeIndex} onGear={() => setGearOpen((g) => !g)} onBack={back} />
      )}
    </div>
  )
}

function Shelves({ row, onStaff }: { row: number; onStaff: (key: string) => void }): React.ReactElement {
  const sorted = [...UNSTAFFED].sort((a, b) => b.questions + b.gaps * 2 - (a.questions + a.gaps * 2))
  const top = sorted[0]
  return (
    <>
      <div className="cc-line2">
        <span className="cc-lead">
          <b>Nobody on them</b>
          <span className="cc-sub">{sorted.length} of {DOMAINS.length} shelves · sorted by what is waiting there, not by size</span>
        </span>
      </div>
      <div className="lib-window-body cc-body">
        <section className="cc-block">
          <p className="cc-note">
            A shelf earns a Fellow when it holds questions nobody is answering.
            {top && <> <b>{top.key}</b> has the most: {top.questions} open questions and {top.gaps} pages linked but never written.</>}
          </p>
          <div className="cc-rows">
            {sorted.map((d, i) => (
              <div key={d.key} className={`cc-row ${i === row ? 'sel' : ''}`} onClick={() => onStaff(d.key)}>
                <span className="cc-id">
                  <span className="cc-idline"><b>{d.key}</b></span>
                  <span className="cc-t">
                    {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'} · {d.gaps} linked but never written
                    {d.handoffs.length > 0 && (
                      <> · <b className="cc-handoff">{d.handoffs.length} question{d.handoffs.length === 1 ? '' : 's'} handed here with nobody to take {d.handoffs.length === 1 ? 'it' : 'them'}</b></>
                    )}
                  </span>
                </span>
                <span className="cc-right">
                  <span className="cc-bar" title="how much is waiting here"><i style={{ width: `${Math.min(100, (d.questions + d.gaps * 2) * 6)}%` }} /></span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); onStaff(d.key) }}>Staff it ›</button>
                </span>
              </div>
            ))}
          </div>
          <p className="cc-note dim">
            A shelf without a Fellow is not idle — ingests still file pages there. It only means nobody plans work for it
            at night.
          </p>
        </section>
      </div>
    </>
  )
}

function Dossier({
  fellow: f,
  pane,
  setPane,
  onBack,
  onStep,
}: {
  fellow: CcFellow
  pane: Pane
  setPane: (p: Pane) => void
  onBack: () => void
  onStep: (delta: number) => void
}): React.ReactElement {
  const active = f.tasks.filter((t) => t.resting !== true)
  const resting = f.tasks.filter((t) => t.resting === true)
  const upNext = tonightTasks(f)[0]
  const panes: Array<[Pane, string]> = [
    ['notebook', 'Notebook'],
    ['recap', 'Recap'],
    ['ledger', `Ledger ${f.ledger.length}`],
    ['pages', `Pages ${f.pages.length}`],
    ['settings', 'Settings'],
  ]
  const nightly = tonightTasks(f).reduce((n, t) => n + taskMinutes(t.kind), 0)
  const nightlyUsd = tonightTasks(f).reduce((n, t) => n + taskUsd(t.kind, f.model), 0)

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
        <span className="cc-lead">
          <b>{f.name}</b>
          {(['watch', 'explore', 'deepen'] as TaskKind[]).map((a) => {
            const n = f.tasks.filter((t) => t.kind === a).length
            return n === 0 ? null : <span key={a} className={`cc-art a-${a}`} title={ART_TEXT[a]}>{a}{n > 1 ? ` ×${n}` : ''}</span>
          })}
          <span className={`sev ${f.state === 'working' ? 'rec' : f.state === 'paused' ? 'mut' : 'ok'}`}>{f.state}</span>
          <span className="cc-sub">{AUTONOMY_TEXT[f.autonomy].short}</span>
        </span>
        <span className="grow" />
        <span className="cc-step">
          <button onClick={() => onStep(-1)} title="Previous Fellow · ←">‹</button>
          <span>Fellow</span>
          <button onClick={() => onStep(1)} title="Next Fellow · →">›</button>
        </span>
        <button className="btn sm">Plan now</button>
        <button className="btn primary sm">Run a task now</button>
      </div>

      <div className="cc-fixed">
        <div className="cc-upnext">
          {upNext ? (
            <>
              <span className="k">up next</span>
              <span className={`cc-art a-${upNext.kind}`}>{upNext.kind}</span>
              <span className="cc-upnext-t">{upNext.text}</span>
              <span className="grow" />
              <span className="mono-meta">{Math.round(nightly)} min tonight · ${nightlyUsd.toFixed(2)}</span>
            </>
          ) : (
            <>
              <span className="k">nothing standing</span>
              <span className="cc-upnext-t">every task is answered — give it a new one in Settings</span>
            </>
          )}
        </div>

        <div className="cc-bar-row">
          <span className="seg">
            {panes.map(([k, label]) => (
              <button key={k} className={pane === k ? 'active' : ''} onClick={() => setPane(k)}>{label}</button>
            ))}
          </span>
          <span className="grow" />
          <span className="mono-meta">
            {pane === 'notebook'
              ? `wiki/meta/agents/${f.id}.md`
              : pane === 'recap'
                ? 'one Fellow’s slice · the wall board keeps the whole'
                : pane === 'ledger'
                  ? 'a row opens the page it filed'
                  : pane === 'settings'
                    ? 'changes apply to the next night'
                    : ''}
          </span>
        </div>

        <div className="cc-area">
          {pane === 'notebook' &&
            (f.notebook.length === 0 ? (
              <p className="empty">Nothing written yet.</p>
            ) : (
              <div className="cc-prose">
                {f.notebook.map((n) => (
                  <p key={n.head}><b>{n.head}.</b> {n.body}</p>
                ))}
              </div>
            ))}

          {pane === 'recap' && (
            <div className="cc-prose">
              {f.recap.ran ? (
                <p className="mono-meta">{f.recap.date} · {f.recap.pages} pages · {f.recap.cost} · ran inside the window</p>
              ) : (
                <p className="cc-note warn">{f.recap.date} · did not run: {f.recap.reason}</p>
              )}
              {f.recap.found.length > 0 && (
                <>
                  <h5>What it found</h5>
                  {f.recap.found.map((x) => <p key={x}>{x}</p>)}
                </>
              )}
              {f.recap.questions.length > 0 && (
                <>
                  <h5>Questions it raised</h5>
                  <ul className="cc-list">{f.recap.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                </>
              )}
              {f.recap.proposals.length > 0 && (
                <>
                  <h5>What it proposed</h5>
                  <ul className="cc-list">
                    {f.recap.proposals.map((p) => (
                      <li key={p.topic}>
                        <span className={`sev ${p.status === 'approved' ? 'ok' : p.status === 'vetoed' ? 'mut' : 'due'}`}>{p.status}</span> {p.topic}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h5>Did you use it</h5>
              <p className="mono-meta">{f.recap.opens} page open(s) this month</p>
              <p className="cc-note dim">
                {f.name}’s slice of last night. The wall board in the Library keeps the whole night, every Fellow together.
              </p>
            </div>
          )}

          {pane === 'ledger' &&
            (f.ledger.length === 0 ? (
              <p className="empty">No runs yet.</p>
            ) : (
              <table className="cc-ledger">
                <thead>
                  <tr><th>When</th><th>Task</th><th>Out</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {f.ledger.map((r) => (
                    <tr
                      key={r.when}
                      className={r.page === undefined ? '' : 'open'}
                      title={r.page === undefined ? 'A planning run files no page' : `Open ${r.page.split('/').pop()?.replace(/\.md$/, '')}`}
                      onClick={() => { if (r.page !== undefined) navigate(pageRoute(r.page)) }}
                    >
                      <td className="n">{r.when}</td>
                      <td className="t">{r.topic} <span className="sev mut">{r.kind}</span></td>
                      <td className="n">{r.out}</td>
                      <td className="n">{r.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}

          {pane === 'pages' &&
            (f.pages.length === 0 ? (
              <p className="empty">No pages yet.</p>
            ) : (
              <ul className="cc-pages">{f.pages.map((p) => <li key={p}><span className="p">{p}</span></li>)}</ul>
            ))}

          {pane === 'settings' && (
            <div className="cc-settings">
              <section className="wide">
                <h5>
                  Standing work
                  <span className="lead">— {f.art === 'custom' ? 'any mix, up to 3' : `${f.art} tasks only, up to ${f.cap}`}</span>
                </h5>
                <div className="cc-card">
                  <ul className="cc-tasks">
                    {active.map((t, i) => (
                      <li key={t.text} className={i === 0 ? 'on' : ''}>
                        <span className={`cc-art a-${t.kind}`}>{t.kind}</span>
                        <span className="t">{t.text}</span>
                        <span className="mono-meta">{i === 0 ? 'up next' : 'waiting'}</span>
                      </li>
                    ))}
                    {resting.map((t) => (
                      <li key={t.text} className="rest">
                        <span className={`cc-art a-${t.kind}`}>{t.kind}</span>
                        <span className="t">{t.text}</span>
                        <span className="mono-meta">at rest</span>
                      </li>
                    ))}
                  </ul>
                  {active.length < f.cap && (
                    <button className={`btn sm ${active.length === 0 ? 'primary' : ''}`}>
                      + {active.length === 0 ? 'Give it a new' : 'Add another'} {f.art === 'custom' ? 'task' : `${f.art} task`}
                    </button>
                  )}
                  <p className="cc-note dim">
                    {f.art === 'custom' ? (
                      <><b>watch</b> {ART_TEXT.watch} <b>explore</b> {ART_TEXT.explore} <b>deepen</b> {ART_TEXT.deepen}</>
                    ) : (
                      <><b>{f.art}</b> {ART_TEXT[f.art]}</>
                    )}
                  </p>
                </div>
              </section>
              <section>
                <h5>How much of the night</h5>
                <div className="cc-card">
                  <span className="seg">
                    <button className={f.mode === 'sweep' ? 'active' : ''}>All {active.length}, every night</button>
                    <button className={f.mode === 'rotate' ? 'active' : ''}>One a night</button>
                  </span>
                  <p className="cc-note">
                    A <b>task</b> is one piece of research: read the sources, write or extend a page, update the notebook.
                    Each carries its own planning run, measured at 1.4 min.
                  </p>
                  <p className="cc-note dim">
                    {Math.round(nightly)} min a night, about ${nightlyUsd.toFixed(2)} · a week costs ${(nightlyUsd * 7).toFixed(0)},
                    roughly {((nightlyUsd * 7) / 8).toFixed(1)} points of the plan.
                  </p>
                </div>
              </section>
              <section>
                <h5>Who decides</h5>
                <div className="cc-card">
                  <span className="seg">
                    {(['manual', 'veto', 'auto'] as const).map((k) => (
                      <button key={k} className={f.autonomy === k ? 'active' : ''}>{AUTONOMY_TEXT[k].label}</button>
                    ))}
                  </span>
                  <p className="cc-note">{AUTONOMY_TEXT[f.autonomy].long}</p>
                  <p className="cc-note dim">
                    A proposal stands for two nights and then expires — approved ones too. Approving moves one ahead of
                    the others; it is not what permits it to run.
                  </p>
                </div>
              </section>
              <section className="wide">
                <h5>Model, effort, share</h5>
                <div className="cc-card">
                  <span className="mono-meta">
                    {f.model.toLowerCase()} · {f.effort.toLowerCase()} effort · {f.depth.toLowerCase()} depth · {f.lens} lens ·{' '}
                    {f.weekPct}% of the week · this week {f.week.runs} run(s), ${f.week.usd.toFixed(2)}, {f.week.points} points
                  </span>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Decisions({
  list,
  at,
  opt,
  decided,
  span,
  onPick,
  onOpt,
  onDecide,
  onBack,
}: {
  list: ReadonlyArray<{ d: CcDomain; f: CcFellow }>
  at: number
  opt: number
  decided: Record<string, 'approved' | 'vetoed'>
  span: number
  onPick: (i: number) => void
  onOpt: (i: number) => void
  onDecide: (id: string, how: 'approved' | 'vetoed') => void
  onBack: () => void
}): React.ReactElement {
  if (list.length === 0) {
    return (
      <>
        <div className="cc-line2">
          <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
          <span className="cc-lead"><b>Decisions</b></span>
        </div>
        <div className="lib-window-body cc-body">
          <p className="empty">Nothing is waiting for a decision.</p>
        </div>
      </>
    )
  }
  const { d, f } = list[at]!
  const open = f.options.filter((o) => decided[o.id] === undefined)
  const groups = (['watch', 'explore', 'deepen'] as TaskKind[])
    .map((a) => ({ art: a, items: f.options.map((o, i) => ({ o, i })).filter((x) => x.o.art === a) }))
    .filter((g) => g.items.length > 0)

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
        <span className="cc-lead">
          <b>{f.name}</b>
          <span className="cc-sub">{d.key} · {AUTONOMY_TEXT[f.autonomy].label.toLowerCase()} · {open.length} of {f.options.length} undecided</span>
        </span>
        <span className="grow" />
        <span className="mono-meta">← → Fellow · j k option · a / v decide</span>
      </div>
      <div className="cc-dec-wrap">
        <div className="cc-rail">
          <h6>Up for review</h6>
          {list.map(({ d: dd, f: ff }, i) => (
            <div key={ff.id} className={`cc-rail-i ${i === at ? 'on' : ''}`} onClick={() => onPick(i)}>
              <span className="nm">{ff.name}<i>{dd.key}</i></span>
              <span className="cnt">{ff.options.filter((o) => decided[o.id] === undefined).length}</span>
            </div>
          ))}
        </div>
        <div className="cc-dec-main">
          <div className="cc-fits">
            {f.autonomy === 'manual' ? (
              <><b>Nothing here runs until you approve it.</b> {f.name} asks every time.</>
            ) : (
              <><b>The top option of each task runs tomorrow night on its own.</b> Veto is how you stop it; approving only moves one ahead of the others.</>
            )}
            <span className="grow" />
            <span className="mono-meta">a proposal stands for two nights, then it expires</span>
          </div>

          {groups.map((g) => (
            <div key={g.art} className="cc-group">
              <h4>
                <span className={`cc-art a-${g.art}`}>{g.art}</span>
                <span className="c">{g.items.length} option{g.items.length > 1 ? 's' : ''} for the same task</span>
                <span className="grow" />
                <span className="mono-meta">{ART_TEXT[g.art]}</span>
              </h4>
              {g.items.map(({ o, i }) => (
                <Option
                  key={o.id}
                  option={o}
                  rank={i + 1}
                  current={i === opt && decided[o.id] === undefined}
                  verdict={decided[o.id]}
                  first={i === 0}
                  autonomy={f.autonomy}
                  span={span}
                  onSelect={() => onOpt(i)}
                  onDecide={(how) => onDecide(o.id, how)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function Option({
  option: o,
  rank,
  current,
  verdict,
  first,
  autonomy,
  span,
  onSelect,
  onDecide,
}: {
  option: CcOption
  rank: number
  current: boolean
  verdict: 'approved' | 'vetoed' | undefined
  first: boolean
  autonomy: CcFellow['autonomy']
  span: number
  onSelect: () => void
  onDecide: (how: 'approved' | 'vetoed') => void
}): React.ReactElement {
  const drift = o.scope < DRIFT_THRESHOLD
  const runsByDefault = first && autonomy !== 'manual' && !drift
  return (
    <div className={`cc-opt ${current ? 'cur' : ''} ${verdict === 'approved' ? 'ok' : ''} ${verdict === 'vetoed' ? 'gone' : ''}`} onClick={onSelect}>
      <div className="cc-opt-head">
        <span className="cc-rank">{rank}</span>
        <div>
          <div className="cc-opt-t">{o.topic}</div>
          <div className="cc-opt-meta">
            <span className="sev mut">{o.kind}</span>
            <span className="sev mut">{o.pageSet ? `extends ${o.pageSet.length} pages` : o.lens}</span>
            <span className="mono-meta">up to {o.minutes} min · about ${o.costUsd.toFixed(2)} · {Math.round((o.minutes / span) * 100)}% of tonight</span>
            <span className="cc-scope" title="token overlap with what you asked this Fellow to follow">
              <span className="mono-meta">fit</span>
              <span className="cc-bar"><i style={{ width: `${Math.round(o.scope * 100)}%` }} /></span>
              <span className="mono-meta">{Math.round(o.scope * 100)}%</span>
            </span>
          </div>
        </div>
        <span>
          {verdict === 'approved' ? <span className="sev ok">approved — runs first</span>
            : verdict === 'vetoed' ? <span className="sev mut">vetoed</span>
              : drift ? <span className="sev due" title="scope below the drift threshold of 0.2">drift · will not run</span>
                : runsByDefault ? <span className="sev ok">runs unless vetoed</span>
                  : <span className="sev mut">alternative</span>}
        </span>
      </div>
      <div className="cc-why"><p>{o.rationale}</p></div>
      {o.pageSet && (
        <div className="cc-prov">
          <span className="lbl">will extend</span>
          {o.pageSet.map((p) => <a key={p}>{p}</a>)}
          <span className="lbl">no new pages</span>
        </div>
      )}
      <div className="cc-prov">
        <span className="lbl">came from</span>
        <span className="sev mut">{o.from.candidate}</span>
        <span>{o.from.text}</span>
        <span className="lbl">read on</span>
        <a>{o.from.page}</a>
      </div>
      {verdict === undefined && (
        <div className="cc-opt-foot">
          <span className="grow" />
          <button className="btn sm">Edit topic</button>
          {runsByDefault ? (
            <>
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); onDecide('approved') }}>Approve anyway</button>
              <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); onDecide('vetoed') }}>Veto</button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); onDecide('vetoed') }}>Veto</button>
              <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); onDecide('approved') }}>
                Approve{drift ? ' — it drifts' : ' — run this one'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Spawn({
  shelf,
  shape,
  index,
  gear,
  onShape,
  onGear,
  onBack,
}: {
  shelf: string
  shape: CcShape
  index: number
  gear: boolean
  onShape: (i: number) => void
  onGear: () => void
  onBack: () => void
}): React.ReactElement {
  const [tasks, setTasks] = useState<Array<{ kind: TaskKind; text: string }>>([{ kind: shape.art === 'custom' ? 'watch' : shape.art, text: '' }])
  // A different shape means a different art, so the draft starts over rather than keeping a
  // task the new shape would not allow.
  useEffect(() => setTasks([{ kind: shape.art === 'custom' ? 'watch' : shape.art, text: '' }]), [shape.art])
  const arts: TaskKind[] = shape.art === 'custom' ? ['watch', 'explore', 'deepen'] : [shape.art]

  return (
    <>
      <div className="cc-line2">
        <button className="cc-back" onClick={onBack} title="Back to tonight · Esc">‹</button>
        <span className="cc-lead">
          <b>A new Fellow for {shelf}</b>
          <span className="cc-sub">four shapes — the first three hold one art each, the fourth any mix</span>
        </span>
        <span className="grow" />
        <span className="mono-meta">← → shape · c customize</span>
      </div>
      <div className="lib-window-body cc-body">
        <section className="cc-block">
          <div className="cc-shapes">
            {SHAPES.map((s, i) => (
              <div key={s.key} className={`cc-shape ${i === index ? 'sel' : ''}`} onClick={() => onShape(i)}>
                <b>{s.name} <span className={`cc-art a-${s.art}`}>{s.art === 'custom' ? 'mixed' : s.art}</span></b>
                <p className="want">“{s.want}”</p>
                <p className="what">{s.what}</p>
                <div className="specs">
                  <span>up to {s.cap} tasks, {s.art === 'custom' ? 'any of the three arts' : `all of them ${s.art}`}</span>
                  <span>{Math.round(taskMinutes(s.art === 'custom' ? 'watch' : s.art))} min a task · ${taskUsd(s.art === 'custom' ? 'watch' : s.art, s.model).toFixed(2)}</span>
                  <span>{s.model.toLowerCase()}{s.model !== 'Sonnet' ? ` (×${s.model === 'Opus' ? '2.5' : '5'} the plan)` : ''} · {s.lens} · {s.weekPct}% of the week</span>
                  <span>{AUTONOMY_TEXT[s.autonomy].short}</span>
                </div>
                <button className={`cc-gear ${i === index && gear ? 'open' : ''}`} onClick={(e) => { e.stopPropagation(); onShape(i); onGear() }} title="Customize">⚙</button>
              </div>
            ))}
          </div>

          {gear && (
            <div className="cc-custom">
              <h4>{shape.name}, adjusted</h4>
              <p className="lead">
                What the example set, and what you can change. The arts of the tasks live below, in the task list; this is
                what belongs to the <b>Fellow</b> rather than to any one task.
              </p>
              <div className="cc-grid2">
                <div className="f">
                  <label>Lens</label>
                  <span className="seg">{['broad', 'sota', 'patents', 'startups'].map((l) => <button key={l} className={l === shape.lens ? 'active' : ''}>{l}</button>)}</span>
                </div>
                <div className="f">
                  <label>Model</label>
                  <span className="seg">{['Sonnet', 'Opus', 'Fable'].map((m) => <button key={m} className={m === shape.model ? 'active' : ''}>{m}</button>)}</span>
                  <p className="why">Opus costs 2.5× a Sonnet task against the weekly plan.</p>
                </div>
                <div className="f">
                  <label>Effort</label>
                  <span className="seg">{['Low', 'Medium', 'High'].map((x) => <button key={x} className={x === shape.effort ? 'active' : ''}>{x}</button>)}</span>
                </div>
                <div className="f">
                  <label>Step depth</label>
                  <span className="seg">{['Standard', 'Deep'].map((x) => <button key={x} className={x === shape.depth ? 'active' : ''}>{x}</button>)}</span>
                  <p className="why">Deep follows its own leads one level further, on a 45-minute leash instead of 15.</p>
                </div>
                <div className="f">
                  <label>Who decides</label>
                  <span className="seg">{(['manual', 'veto', 'auto'] as const).map((k) => <button key={k} className={k === shape.autonomy ? 'active' : ''}>{AUTONOMY_TEXT[k].label}</button>)}</span>
                  <p className="why">{AUTONOMY_TEXT[shape.autonomy].long}</p>
                </div>
                <div className="f">
                  <label>Share of the week</label>
                  <span className="mono-meta big">{shape.weekPct}%</span>
                  <p className="why">A ceiling, not a target. Reached, it sleeps until the window resets.</p>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="cc-block">
          <h3 className="cc-sec">
            Standing work
            <span className="grow" />
            <span className="c">{shape.art === 'custom' ? 'any mix' : `${shape.art} tasks only`}, up to {shape.cap}</span>
          </h3>
          {tasks.map((t, i) => (
            <div key={i} className="cc-taskrow">
              <span className="seg vert">
                {arts.map((a) => (
                  <button key={a} className={a === t.kind ? 'active' : ''} title={ART_TEXT[a]} onClick={() => setTasks((ts) => ts.map((x, j) => (j === i ? { ...x, kind: a } : x)))}>{a}</button>
                ))}
              </span>
              <textarea
                rows={2}
                value={t.text}
                placeholder={t.kind === 'watch' ? 'a subject to follow' : t.kind === 'explore' ? 'a question to answer' : 'a theme to build out'}
                onChange={(e) => setTasks((ts) => ts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
              {tasks.length > 1 && <button className="btn ghost sm" onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {tasks.length < shape.cap && (
            <button className="btn sm" onClick={() => setTasks((ts) => [...ts, { kind: arts[0]!, text: '' }])}>
              + Add another {shape.art === 'custom' ? 'task' : `${shape.art} task`}
            </button>
          )}
        </section>

        <section className="cc-block">
          <h3 className="cc-sec">Name</h3>
          <input className="input" defaultValue="Nadia" style={{ maxWidth: 220 }} />
        </section>

        <div className="cc-acts">
          <span className="grow" />
          <button className="btn" onClick={onBack}>Cancel</button>
          <button className="btn primary" onClick={onBack}>Spawn the fellow</button>
        </div>
      </div>
    </>
  )
}
