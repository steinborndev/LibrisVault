/**
 * The ingestion entry point (SPEC.md §6.2, redesign 2026-08-25 second pass): drag-and-drop a
 * file, browse for one, or paste a URL / note (multi-line, with an optional title).
 *
 * A dropped file WAITS (2026-09-14). It used to go up the moment it landed, which made the
 * drop itself the commitment: a file dropped by accident, or on the wrong one of the two
 * boxes, was already a job. Now it is held in the zone as an icon with an x, one at a time,
 * and the button below sends it - the same button a link or a note uses, so there is one
 * moment of "yes, this one" whatever you are adding. What is held goes up alone rather than
 * as a batch; a batch is what the watch folder is for.
 *
 * It lives in Home's control column now - dropping a file is a control, and it belongs where
 * every other control on every other screen is. That is also why the wide card variant and
 * its collapsed one-row state are gone: at column width there is nothing to collapse, and
 * the surface no longer competes with the activity stream for the top of the screen.
 *
 * The channel dots stay: the watch folder and the Telegram bot are the other two ways in,
 * and they used to be discoverable only through a popover hover.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type EnqueueResult } from '../api/client.ts'
import { Icon, type IconName } from './Icon.tsx'

type Toast = { kind: 'ok' | 'err'; text: string } | null

function summarize(res: EnqueueResult): string {
  const dupes = res.jobs.filter((j) => j.status === 'duplicate' || j.duplicateOf).length
  const fresh = res.jobs.length - dupes
  const parts: string[] = []
  if (fresh > 0) parts.push(`${fresh} queued`)
  if (dupes > 0) parts.push(`${dupes} duplicate${dupes > 1 ? 's' : ''} skipped`)
  if (res.batchId) parts.push('as a batch')
  return parts.join(' · ') || 'Accepted'
}

/** One line that is a URL = a link job; anything else (or multi-line) = a note. */
function looksLikeUrl(value: string): boolean {
  return !value.includes('\n') && /^https?:\/\/\S+$/i.test(value.trim())
}

/** The icon a held file wears: what KIND of thing it is, in one glance, from its name. */
function fileIcon(name: string): IconName {
  const ext = name.toLowerCase().replace(/^.*\./, '')
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'heic'].includes(ext)) return 'image'
  if (['mp3', 'm4a', 'wav', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'play'
  if (['html', 'htm', 'mhtml'].includes(ext)) return 'globe'
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'archive'
  return 'file'
}

const kb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * `when: 'night'` is the same box for the night shift: everything it takes is held until the
 * shift begins and runs ahead of every Fellow (docs/tasks/TASKS-SWEEP-2026-09.md, chunk 7).
 */
export function Dropzone({
  legend = true,
  when,
  destinations = false,
}: { legend?: boolean; when?: 'night'; destinations?: boolean } = {}): React.ReactElement {
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const [toast, setToast] = useState<Toast>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  /** The file in the zone, waiting for the button. One at a time: two would need a queue. */
  const [staged, setStaged] = useState<File | null>(null)
  /*
   * Where this goes, when the box offers the choice. It sits with the button rather than as
   * the section's heading: it is the first half of the sentence the button finishes ("night
   * shift" - "hold this file for tonight"), and the two belong within a glance of each other.
   * Switching clears what is held: a file is held FOR one of them.
   */
  const [dest, setDest] = useState<'now' | 'night'>(when === 'night' ? 'night' : 'now')
  const target: 'night' | undefined = destinations ? (dest === 'night' ? 'night' : undefined) : when
  const fileInput = useRef<HTMLInputElement>(null)

  // Success toasts dismiss themselves; errors stay until the next action replaces them.
  useEffect(() => {
    if (toast?.kind !== 'ok') return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['jobs'] })
    // The night shift's window lists what is held for tonight.
    if (target !== undefined) void qc.invalidateQueries({ queryKey: ['library-scene'] })
  }
  const said = (res: EnqueueResult): string => `${summarize(res)}${target === 'night' ? ' · held for tonight' : ''}`

  const upload = useMutation({
    mutationFn: (files: File[]) => api.uploadFiles(files, target),
    onSuccess: (res) => {
      setToast({ kind: 'ok', text: said(res) })
      setStaged(null)
      invalidate()
    },
    onError: (e: Error) => setToast({ kind: 'err', text: e.message }),
  })

  const submit = useMutation({
    mutationFn: ({ value, noteTitle }: { value: string; noteTitle: string }) =>
      looksLikeUrl(value)
        ? api.submitUrl(value.trim(), target)
        : api.submitText(value, noteTitle.trim() === '' ? undefined : noteTitle.trim(), target),
    onSuccess: (res) => {
      setToast({ kind: 'ok', text: said(res) })
      setText('')
      setTitle('')
      invalidate()
    },
    onError: (e: Error) => setToast({ kind: 'err', text: e.message }),
  })

  // The server's per-file cap, for a pre-check: warning before the upload beats decoding a
  // 413 after streaming 200 MB. The server still enforces the limit either way.
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  const maxBytes = health.data?.limits?.maxUploadBytes

  // The other two intake channels, visible where intake happens.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const telegram = useQuery({ queryKey: ['telegram-status'], queryFn: api.telegramStatus, staleTime: 300_000 })

  /**
   * Take ONE file and hold it. The size check happens here rather than on the button, so a
   * file that could never go up is refused where it landed instead of looking accepted until
   * you press send.
   */
  const takeFiles = (files: File[]): void => {
    const file = files[0]
    if (file === undefined) return
    if (maxBytes !== undefined && file.size > maxBytes) {
      const mb = Math.round(maxBytes / 1024 / 1024)
      setToast({ kind: 'err', text: `${file.name}: over the ${mb} MB limit - not taken` })
      return
    }
    setStaged(file)
    setToast(files.length > 1 ? { kind: 'err', text: `${files.length} files dropped; holding the first. Add them one at a time, or use the watch folder.` } : null)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      takeFiles(files)
      return
    }
    // A dragged link or selection (no file): it lands in the box below rather than going up,
    // for the same reason a file waits - the drop says what, the button says when.
    const dragged = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (dragged.trim()) setText(dragged.trim())
  }

  const busy = upload.isPending || submit.isPending
  const maxMb = maxBytes !== undefined ? Math.round(maxBytes / 1024 / 1024) : undefined
  const isNote = text.trim() !== '' && !looksLikeUrl(text)
  /*
   * One button for every way in, and it names what it is about to send. A file in the zone
   * goes first: it is the thing you can see, and the note stays where it is for the next
   * press. Disabled means there is nothing to send, which is also the answer to "why is it
   * grey" - the zone is empty and the box below it is blank.
   */
  const kind: 'file' | 'link' | 'note' | null = staged !== null ? 'file' : text.trim() === '' ? null : isNote ? 'note' : 'link'
  const noun = kind === 'file' ? 'file' : kind === 'link' ? 'link' : 'note'
  const label =
    kind === null
      ? target === 'night' ? 'Nothing to hold for tonight yet' : 'Nothing to add yet'
      : target === 'night'
        ? `Hold this ${noun} for tonight`
        : `Add this ${noun} to the vault`
  const send = (): void => {
    if (staged !== null) {
      upload.mutate([staged])
      return
    }
    if (text.trim() !== '') submit.mutate({ value: text, noteTitle: title })
  }

  return (
    <div className="intake-panel">
      <div
        className={`dropzone slim${over ? ' over' : ''}`}
        // The window-level GlobalDrop also hears every drop. Without this mark a file dropped
        // HERE was uploaded twice - once by this handler, once by the window's - and the
        // second upload came back as a "duplicate" of the first, 30 ms apart (2026-09-05).
        data-drop-target
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => {
          if (staged === null) fileInput.current?.click()
        }}
        onKeyDown={(e) => {
          // role="button" promises keyboard activation - deliver it (Enter/Space open the picker).
          if ((e.key === 'Enter' || e.key === ' ') && staged === null) {
            e.preventDefault()
            fileInput.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose files or drag them here"
      >
        {staged === null ? (
          <>
            <Icon name="upload" />
            <span className="dz-t">{busy ? 'Uploading…' : 'Drop a file here'}</span>
            <span className="dz-s">or click to choose{maxMb !== undefined ? ` · max ${maxMb} MB` : ''}</span>
          </>
        ) : (
          /* What is in hand: its kind at a glance, its name, and the way to change your mind.
             The x stops the click reaching the zone, which would open the file picker. */
          <span className="dz-held">
            <span className="dz-icon" aria-hidden>
              <Icon name={fileIcon(staged.name)} />
            </span>
            <span className="dz-name" title={staged.name}>
              {staged.name}
            </span>
            <span className="dz-size">{kb(staged.size)}</span>
            <button
              className="dz-drop"
              aria-label={`Take ${staged.name} back out`}
              title="Take it back out"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                setStaged(null)
                setToast(null)
              }}
            >
              <Icon name="x" />
            </button>
          </span>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            takeFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>

      <textarea
        className="intake-note"
        rows={2}
        placeholder="https://… or a quick note"
        aria-label="Paste a link or write a note"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits a URL; notes are multi-line, so they submit via the button
          // (or Ctrl+Enter, the common composer convention).
          if (e.key === 'Enter' && (looksLikeUrl(text) || e.ctrlKey) && text.trim()) {
            e.preventDefault()
            submit.mutate({ value: text, noteTitle: title })
          }
        }}
      />
      {isNote && (
        <input
          type="text"
          className="intake-title"
          placeholder="Title (optional)"
          aria-label="Note title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      )}

      {destinations && (
        <div className="lib-strip ip-strip" role="radiogroup" aria-label="Where this goes">
          <button
            className={`rp${dest === 'now' ? ' on' : ''}`}
            role="radio"
            aria-checked={dest === 'now'}
            title="Into the queue right away; the next free worker files it, and the Activity stream shows it settle."
            onClick={() => {
              setDest('now')
              setStaged(null)
            }}
          >
            Add now
          </button>
          <button
            className={`rp${dest === 'night' ? ' on' : ''}`}
            role="radio"
            aria-checked={dest === 'night'}
            title="Held until the night shift begins. The shift runs these first, ahead of every Fellow, so the Fellows plan on a vault that already holds them. The Night shift window lists what is waiting and lets you take it off again."
            onClick={() => {
              setDest('night')
              setStaged(null)
            }}
          >
            Night shift
          </button>
        </div>
      )}

      <div className="ip-actions">
        <button className="btn primary sm ip-send" disabled={kind === null || busy} onClick={send}>
          {busy ? 'Sending…' : label}
        </button>
      </div>
      <div className="ip-actions">
        <span className="spacer" />
        {legend && (
          <>
            <span className="ch" title={stats.data?.watcher.folder}>
              <span className={`d ${stats.data?.watcher.active === true ? 'ok' : 'warn'}`} />
              watcher
            </span>
            <span className="ch">
              <span className={`d ${telegram.data?.configured === true ? 'ok' : ''}`} />
              bot
            </span>
          </>
        )}
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
