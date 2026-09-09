/**
 * The Fellow command centre (docs/tasks/TASKS-A7.md).
 *
 * Opens like a shelf window - over the room, in the same frame, Escape steps back one level -
 * and manages the Fellows completely, so that the docked Fellow card can be retired. Four
 * levels: the night, a Fellow's dossier, the decisions overlay, and the spawn form; the domain
 * rotation has one stop past its last staffed shelf for the ones that have nobody.
 *
 * REPRESENTATIVE MOCKUP. The components are real and this is what the window will look like;
 * the data comes from `lib/command/fixture.ts` rather than from the API, because three of the
 * things it draws do not exist in the service yet (A7 section 3.3: the full sweep, an art per
 * Fellow, an order for the domains). Reachable at `/library?cc=1`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ART_TEXT,
  AUTONOMY_TEXT,
  DOMAINS,
  DRIFT_THRESHOLD,
  SHAPES,
  taskMinutes,
  taskUsd,
  tonightTasks,
  type CcDomain,
  type CcFellow,
  type CcOption,
  type CcShape,
} from '../../lib/command/fixture.ts'
import { domainColor } from '../../lib/domains.ts'
import type { TaskKind } from '../../api/types.ts'

type View = 'tonight' | 'dossier' | 'decisions' | 'spawn'
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

export function CommandCentre({ onClose }: { onClose: () => void }): React.ReactElement {
  const [view, setView] = useState<View>('tonight')
  const [order, setOrder] = useState<readonly string[]>([])
  const [domainIndex, setDomainIndex] = useState(0)
  const [row, setRow] = useState(0)
  const [fellowId, setFellowId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('notebook')
  const [decIndex, setDecIndex] = useState(0)
  const [optIndex, setOptIndex] = useState(0)
  const [shapeIndex, setShapeIndex] = useState(0)
  const [gearOpen, setGearOpen] = useState(false)
  const [winFrom, setWinFrom] = useState(25 * 60)
  const [winTo, setWinTo] = useState(30 * 60)
  const [decided, setDecided] = useState<Record<string, 'approved' | 'vetoed'>>({})
  const trackRef = useRef<HTMLDivElement>(null)

  /* A Fellow appears at its home domain only (A7 D10), so a night is never counted twice. */
  const staffed = useMemo(() => {
    const known = DOMAINS.filter((d) => d.fellows.length > 0)
    const byKey = new Map(known.map((d) => [d.key, d]))
    const out = order.map((k) => byKey.get(k)).filter((d): d is CcDomain => d !== undefined)
    for (const d of known) if (!out.includes(d)) out.push(d)
    return out
  }, [order])
  const unstaffed = useMemo(() => DOMAINS.filter((d) => d.fellows.length === 0), [])
  const atShelves = domainIndex >= staffed.length
  const domain = staffed[Math.min(domainIndex, staffed.length - 1)]!
  const stops = staffed.length + 1

  const openCount = (f: CcFellow): number => f.options.filter((o) => decided[o.id] === undefined).length
  const allOpen = DOMAINS.reduce((n, d) => n + d.fellows.reduce((m, f) => m + openCount(f), 0), 0)
  const deciders = useMemo(
    () =>
      DOMAINS.flatMap((d) =>
        d.fellows.filter((f) => f.options.some((o) => decided[o.id] === undefined)).map((f) => ({ d, f })),
      ),
    [decided],
  )
  const fellow = fellowId === null ? undefined : DOMAINS.flatMap((d) => d.fellows).find((f) => f.id === fellowId)

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

  /** Contiguous runs of one domain: the unit you read, divided by hairlines into its topics. */
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
      if (view === 'decisions') {
        const list = deciders
        if (list.length === 0) return
        const cur = list[Math.min(decIndex, list.length - 1)]!.f
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          setDecIndex((i) => (i + 1) % list.length)
          setOptIndex(0)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          setDecIndex((i) => (i - 1 + list.length) % list.length)
          setOptIndex(0)
        } else if (e.key === 'j') setOptIndex((i) => Math.min(cur.options.length - 1, i + 1))
        else if (e.key === 'k') setOptIndex((i) => Math.max(0, i - 1))
        else if (e.key === 'a' || e.key === 'v') {
          const opt = cur.options[optIndex]
          if (opt) setDecided((d) => ({ ...d, [opt.id]: e.key === 'a' ? 'approved' : 'vetoed' }))
        }
        return
      }
      if (view === 'dossier') {
        const order: Pane[] = ['notebook', 'recap', 'ledger', 'pages', 'settings']
        const n = Number(e.key)
        if (n >= 1 && n <= 5) setPane(order[n - 1]!)
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
        setDomainIndex((i) => (i - 1 + stops) % stops)
        setRow(0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setDomainIndex((i) => (i + 1) % stops)
        setRow(0)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setRow((r) => Math.min((atShelves ? unstaffed.length : domain.fellows.length) - 1, r + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setRow((r) => Math.max(0, r - 1))
      } else if (e.key === 'Enter' && !atShelves) {
        const f = domain.fellows[row]
        if (f) {
          setFellowId(f.id)
          setPane('notebook')
          setView('dossier')
        }
      } else if (e.key === 'n') {
        setShapeIndex(0)
        setGearOpen(false)
        setView('spawn')
      } else if (e.key === 'd' && allOpen > 0) {
        setDecIndex(0)
        setOptIndex(0)
        setView('decisions')
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
    const move = (ev: MouseEvent): void => {
      const rect = (e.currentTarget as HTMLElement).closest('.cc-setter-track')?.getBoundingClientRect()
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

  const title =
    view === 'decisions'
      ? 'decisions · all domains'
      : view === 'spawn'
        ? 'new Fellow'
        : view === 'dossier'
          ? (fellow?.name ?? '')
          : atShelves
            ? `${unstaffed.length} with nobody on them`
            : `${domain.fellows.length} Fellows · ${domain.pages} pages`

  return (
    <div className="lib-window cc" role="dialog" aria-label="Fellow command centre">
      <div className="box-head cc-head">
        <div className="cc-rot">
          <button className="cc-arrow" onClick={() => { setDomainIndex((i) => (i - 1 + stops) % stops); setRow(0) }} aria-label="Previous shelf">‹</button>
          <span className="cc-name">{atShelves && view === 'tonight' ? 'unstaffed shelves' : domain.key}</span>
          <button className="cc-arrow" onClick={() => { setDomainIndex((i) => (i + 1) % stops); setRow(0) }} aria-label="Next shelf">›</button>
          <span className="cc-of">{title}</span>
          <span className="cc-dots">
            {staffed.map((d, i) => (
              <i
                key={d.key}
                className={`${i === domainIndex ? 'on' : ''} ${d.fellows.some((f) => openCount(f) > 0) && i !== domainIndex ? 'due' : ''}`}
                title={d.key}
                onClick={() => { setDomainIndex(i); setRow(0); setView('tonight') }}
              />
            ))}
            <i className={`shelf ${atShelves ? 'on' : ''}`} title="shelves with nobody on them" onClick={() => { setDomainIndex(staffed.length); setRow(0); setView('tonight') }} />
          </span>
        </div>
        <span className="grow" />
        <button className={`cc-dec ${allOpen > 0 ? 'due' : ''}`} onClick={() => { setDecIndex(0); setOptIndex(0); setView('decisions') }}>
          Decisions <span className="n">{allOpen}</span>
        </button>
        <span className="cc-keys">
          {view === 'decisions' ? (
            <><kbd>←</kbd><kbd>→</kbd> Fellow <kbd>j</kbd><kbd>k</kbd> option <kbd>a</kbd>/<kbd>v</kbd> decide</>
          ) : view === 'tonight' ? (
            <><kbd>←</kbd><kbd>→</kbd> shelf <kbd>↑</kbd><kbd>↓</kbd> Fellow <kbd>↵</kbd> open <kbd>n</kbd> new</>
          ) : (
            <><kbd>esc</kbd> back</>
          )}
        </span>
        <button className="gx-close" onClick={onClose} aria-label="Close the command centre">✕</button>
      </div>

      {view === 'tonight' && !atShelves && (
        <div className="lib-window-body cc-body">
          <div className="cc-night">
            <h2>Tonight</h2>
            <span className="cc-sub">
              {blocks.length} task{blocks.length === 1 ? '' : 's'} across {new Set(blocks.map((b) => b.domain.key)).size} domains ·{' '}
              <b>{dur(booked)} of {dur(span)}</b> · {dur(here)} of that in {domain.key}
            </span>
          </div>

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
              <b>{hhmm(winFrom)} – {hhmm(winTo)}</b> · {dur(span)} · every Fellow shares it
              <span className="grow" />
              <span className="mono-meta">drag either end</span>
            </div>
          </div>

          <div className="cc-ticks">
            {Array.from({ length: Math.max(1, Math.floor(span / 60)) }, (_, i) => (
              <span key={i}>{pad2(Math.floor(((winFrom + i * 60) % 1440) / 60))}</span>
            ))}
          </div>
          <div className="cc-track" ref={trackRef}>
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
                <span className="cc-band-label">{((g.to - g.from) / span) * 100 > 9 ? g.domain.key : ''}</span>
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
            <span className="cc-legend-note">drag a domain to move it in the queue · hairlines are its topics</span>
          </div>

          {overflow.length > 0 ? (
            <p className="cc-note warn">
              <b>{overflow.length} task{overflow.length === 1 ? ' does' : 's do'} not fit tonight.</b> The night is one queue for
              every Fellow, not one per domain: {dur(booked)} of work against a {dur(span)} window. Widen the window, put a
              Fellow on <b>one task a night</b>, or leave it — what does not fit stands for tomorrow.
            </p>
          ) : blocks.some((b) => b.waits) ? (
            <p className="cc-note">
              {blocks.filter((b) => b.waits).length} of tonight’s {blocks.length} tasks belong to a Fellow set to{' '}
              <b>ask me every time</b> — those wait for you. The rest run unless you veto them during the day.
            </p>
          ) : (
            <p className="cc-note">
              Everything here runs on its own. What a Fellow proposes tonight runs tomorrow night unless you veto it; only a
              proposal that drifts from the intent waits for your approval.
            </p>
          )}

          <h3 className="cc-sec">
            Fellows of this shelf <span className="c">{domain.fellows.length}</span>
            {domain.fellows.some((f) => openCount(f) > 0) && (
              <span className="due">· {domain.fellows.reduce((n, f) => n + openCount(f), 0)} up for review</span>
            )}
          </h3>
          <div className="cc-rows">
            {domain.fellows.map((f, i) => {
              const mine = tonightTasks(f)
              const minutes = mine.reduce((n, t) => n + taskMinutes(t.kind), 0)
              return (
                <div
                  key={f.id}
                  className={`cc-row ${i === row ? 'sel' : ''}`}
                  onClick={() => { setRow(i); setFellowId(f.id); setPane('notebook'); setView('dossier') }}
                >
                  <span className="cc-id">
                    <span className="cc-idline">
                      <b>{f.name}</b>
                      <span className={`sev ${f.state === 'working' ? 'rec' : f.state === 'paused' ? 'mut' : 'ok'}`}>{f.state}</span>
                    </span>
                    <span className="cc-t">
                      {f.tasks.length > 0 && f.tasks.every((t) => t.resting === true)
                        ? `all ${f.tasks.length} questions answered — nothing standing`
                        : f.intent}
                    </span>
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
            <div className="cc-row new" onClick={() => { setShapeIndex(0); setGearOpen(false); setView('spawn') }}>
              <span className="cc-id">
                <b>+ New Fellow for {domain.key}</b>
                <span className="cc-t">take an example and change anything about it</span>
              </span>
              <span className="cc-right"><kbd>n</kbd></span>
            </div>
          </div>
        </div>
      )}

      {view === 'tonight' && atShelves && <Shelves list={unstaffed} row={row} onStaff={() => { setShapeIndex(0); setView('spawn') }} />}
      {view === 'dossier' && fellow && <Dossier fellow={fellow} pane={pane} setPane={setPane} onBack={back} />}
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

function Shelves({ list, row, onStaff }: { list: readonly CcDomain[]; row: number; onStaff: (key: string) => void }): React.ReactElement {
  const sorted = [...list].sort((a, b) => b.questions + b.gaps * 2 - (a.questions + a.gaps * 2))
  const top = sorted[0]
  return (
    <div className="lib-window-body cc-body">
      <div className="cc-night">
        <h2>Shelves with nobody on them</h2>
        <span className="cc-sub">{sorted.length} of {DOMAINS.length} domains · sorted by what is waiting there, not by size</span>
      </div>
      <p className="cc-note">
        A shelf earns a Fellow when it holds questions nobody is answering.
        {top && <> <b>{top.key}</b> has the most: {top.questions} open questions and {top.gaps} pages linked but never written.</>}
      </p>
      <div className="cc-rows">
        {sorted.map((d, i) => (
          <div key={d.key} className={`cc-row ${i === row ? 'sel' : ''}`} onClick={() => onStaff(d.key)}>
            <span className="cc-id">
              <b>{d.key}</b>
              <span className="cc-t">
                {d.pages} pages · {d.questions} open question{d.questions === 1 ? '' : 's'} · {d.gaps} linked but never written
                {d.handoffs.length > 0 && <> · <b className="cc-handoff">{d.handoffs.length} question{d.handoffs.length === 1 ? '' : 's'} handed here with nobody to take {d.handoffs.length === 1 ? 'it' : 'them'}</b></>}
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
        A shelf without a Fellow is not idle — ingests still file pages there. It only means nobody plans work for it at night.
      </p>
    </div>
  )
}

function Dossier({
  fellow: f,
  pane,
  setPane,
  onBack,
}: {
  fellow: CcFellow
  pane: Pane
  setPane: (p: Pane) => void
  onBack: () => void
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
    <div className="cc-fixed">
      <div className="cc-dos-head">
        <div>
          <button className="cc-back" onClick={onBack}>‹ Tonight</button>
          <h2>
            {f.name}
            {(['watch', 'explore', 'deepen'] as TaskKind[]).map((a) => {
              const n = f.tasks.filter((t) => t.kind === a).length
              return n === 0 ? null : (
                <span key={a} className={`cc-art a-${a}`} title={ART_TEXT[a]}>{a}{n > 1 ? ` ×${n}` : ''}</span>
              )
            })}
          </h2>
        </div>
        <span className="grow" />
        <span className="mono-meta">{f.state} · {AUTONOMY_TEXT[f.autonomy].short}</span>
        <button className="btn primary sm">Run a task now</button>
        <button className="btn sm">Plan now</button>
      </div>
      {upNext && (
        <div className="cc-upnext">
          <span className="k">up next</span>
          <span className={`cc-art a-${upNext.kind}`}>{upNext.kind}</span>
          {upNext.text}
        </div>
      )}
      <div className="cc-bar-row">
        <span className="seg">
          {panes.map(([k, label]) => (
            <button key={k} className={pane === k ? 'active' : ''} onClick={() => setPane(k)}>{label}</button>
          ))}
        </span>
        <span className="grow" />
        <span className="mono-meta">
          {pane === 'notebook' ? `wiki/meta/agents/${f.id}.md` : pane === 'recap' ? 'one Fellow’s slice · the wall board keeps the whole' : pane === 'settings' ? 'changes apply to the next night' : ''}
        </span>
      </div>

      <div className="cc-area">
        {pane === 'notebook' && (
          f.notebook.length === 0 ? <p className="empty">Nothing written yet.</p> : (
            <>
              <h4>{f.name} — notebook</h4>
              {f.notebook.map((n) => <p key={n.head}><b>{n.head}.</b> {n.body}</p>)}
            </>
          )
        )}

        {pane === 'recap' && (
          <>
            <h4>{f.name}’s night — {f.recap.date}</h4>
            {f.recap.ran ? (
              <p className="mono-meta">{f.recap.pages} pages · {f.recap.cost} · the shift ran it inside the window</p>
            ) : (
              <p className="cc-note warn">Did not run: {f.recap.reason}</p>
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
                    <li key={p.topic}><span className={`sev ${p.status === 'approved' ? 'ok' : p.status === 'vetoed' ? 'mut' : 'due'}`}>{p.status}</span> {p.topic}</li>
                  ))}
                </ul>
              </>
            )}
            <h5>Did you use it</h5>
            <p className="mono-meta">{f.recap.opens} page open(s) this month</p>
            <p className="cc-note dim">
              This is {f.name}’s slice of last night. The wall board in the Library keeps the whole night, every Fellow together.
            </p>
          </>
        )}

        {pane === 'ledger' && (
          f.ledger.length === 0 ? <p className="empty">No runs yet.</p> : (
            <table className="cc-ledger">
              <thead><tr><th>When</th><th>Task</th><th>Out</th><th>Cost</th></tr></thead>
              <tbody>
                {f.ledger.map((r) => (
                  <tr key={r.when}>
                    <td className="n">{r.when}</td>
                    <td className="t">{r.topic} <span className="sev mut">{r.kind}</span></td>
                    <td className="n">{r.out}</td>
                    <td className="n">{r.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {pane === 'pages' && (
          f.pages.length === 0 ? <p className="empty">No pages yet.</p> : (
            <ul className="cc-pages">{f.pages.map((p) => <li key={p}><span className="p">{p}</span></li>)}</ul>
          )
        )}

        {pane === 'settings' && (
          <div className="cc-settings">
            <section>
              <h5>How much of the night</h5>
              <div className="cc-card">
                <span className="seg">
                  <button className={f.mode === 'sweep' ? 'active' : ''}>All {active.length} tasks, every night</button>
                  <button className={f.mode === 'rotate' ? 'active' : ''}>One task a night, rotating</button>
                </span>
                <p className="cc-note">
                  A <b>task</b> is one piece of research: read the sources, write or extend a page, update the notebook.
                  Each carries its own planning run — measured at 1.4 min. Keeping them separate is what stops a deepen
                  task from being proposed as a free search.
                </p>
                <p className="cc-note dim">
                  {Math.round(nightly)} min a night, about ${nightlyUsd.toFixed(2)} · over a week ${(nightlyUsd * 7).toFixed(0)},
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
                  A proposal stands for two nights and then expires — approved ones too. Approving moves one ahead of the
                  others and is what lets it run at all in “ask me every time”; in the other two modes it is not what
                  permits it.
                </p>
              </div>
            </section>
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
                  {f.art === 'custom'
                    ? <><b>watch</b> {ART_TEXT.watch} <b>explore</b> {ART_TEXT.explore} <b>deepen</b> {ART_TEXT.deepen}</>
                    : <><b>{f.art}</b> {ART_TEXT[f.art]}</>}
                </p>
              </div>
            </section>
            <section className="wide">
              <h5>Model, effort, share</h5>
              <div className="cc-card">
                <span className="mono-meta">
                  {f.model.toLowerCase()} · {f.effort.toLowerCase()} effort · {f.depth.toLowerCase()} depth · {f.lens} lens · {f.weekPct}% of the week
                  {' · '}this week {f.week.runs} run(s), ${f.week.usd.toFixed(2)}, {f.week.points} points
                </span>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
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
      <div className="lib-window-body cc-body">
        <p className="empty">Nothing is waiting for a decision. <button className="btn sm" onClick={onBack}>Back to tonight</button></p>
      </div>
    )
  }
  const { d, f } = list[at]!
  const open = f.options.filter((o) => decided[o.id] === undefined)
  const groups = (['watch', 'explore', 'deepen'] as TaskKind[])
    .map((a) => ({ art: a, items: f.options.map((o, i) => ({ o, i })).filter((x) => x.o.art === a) }))
    .filter((g) => g.items.length > 0)

  return (
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
        <div className="cc-night">
          <h2>{f.name}</h2>
          <span className="cc-sub">{d.key} · {AUTONOMY_TEXT[f.autonomy].label.toLowerCase()} · {open.length} of {f.options.length} still undecided</span>
        </div>
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
    <div className="lib-window-body cc-body">
      <button className="cc-back" onClick={onBack}>‹ Tonight</button>
      <h3 className="cc-sec">A new Fellow for {shelf}</h3>
      <p className="cc-note">
        Four shapes. The first three hold one art each; the fourth holds any mix. Whichever you take, the gear opens
        everything it decided for you.
      </p>
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
            What the example set, and what you can change. The arts of the tasks live below, in the task list; this is what
            belongs to the <b>Fellow</b> rather than to any one task.
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

      <div className="cc-field">
        <label>
          Standing work <span className="lead">— {shape.art === 'custom' ? 'any mix' : `${shape.art} tasks only`}, up to {shape.cap}, all worked every night by default</span>
        </label>
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
      </div>

      <div className="cc-field short">
        <label>Name</label>
        <input className="input" defaultValue="Nadia" />
      </div>

      <div className="cc-acts">
        <span className="grow" />
        <button className="btn" onClick={onBack}>Cancel</button>
        <button className="btn primary" onClick={onBack}>Spawn the fellow</button>
      </div>
    </div>
  )
}
