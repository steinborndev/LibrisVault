/**
 * A new department, started from a free shelf (docs/agents/SPEC.md section 10.7).
 *
 * The same three steps the System screen offers, in the room where the shelf stands: the
 * key and its description go into the vault's domain registry, an optional read-only review
 * run checks the key against the registry and the pages it would claim before anything is
 * written, and an optional backfill files the pages that carry no domain into the new one.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client.ts'
import { Icon } from '../Icon.tsx'

const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function NewDepartment({ slot, roomName, onClose }: { slot: number; roomName: string; onClose: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [review, setReview] = useState(true)
  const [backfill, setBackfill] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [fromCandidate, setFromCandidate] = useState<string | null>(null)

  const candidates = useQuery({ queryKey: ['domain-candidates'], queryFn: api.domainCandidates })
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const taken = new Set((domains.data?.domains ?? []).map((d) => d.key))

  const create = useMutation({
    mutationFn: async (): Promise<string> => {
      await api.createDomain({
        key,
        description,
        tags: tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
        ...(fromCandidate !== null ? { dismissCandidate: fromCandidate } : {}),
      })
      // Both runs are optional and independent: the review reports, the backfill moves pages.
      if (review) await api.domainReview()
      if (backfill) await api.domainBackfill()
      return key
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['domains'] })
      void qc.invalidateQueries({ queryKey: ['domain-candidates'] })
      void qc.invalidateQueries({ queryKey: ['library-scene'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
      setNote(
        review || backfill
          ? `${created} added. ${review ? 'The review run is going; ' : ''}${backfill ? 'the backfill follows.' : 'watch it under Maintenance.'}`
          : `${created} added to the registry. It takes its shelf once a page carries it.`,
      )
      setKey('')
      setDescription('')
      setTags('')
      setFromCandidate(null)
    },
  })

  const valid = KEY_RE.test(key) && !taken.has(key) && description.trim() !== ''
  const proposals = (candidates.data?.candidates ?? []).slice(0, 6)

  return (
    <div className="lib-window" role="dialog" aria-label="New department">
      <div className="box-head">
        <h2 className="box-title">New department</h2>
        <span className="box-sub">
          slot {slot + 1} in {roomName} · a domain in the registry, and a shelf for it
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onClose}>
          Back to the room · Esc
        </button>
      </div>
      <div className="lib-window-body newdep">
        {proposals.length > 0 && (
          <>
            <p className="hint">
              The vault proposes these, from pages that carry no domain yet. Pick one, or write your own.
            </p>
            <div className="newdep-suggest">
              {proposals.map((c) => (
                <button
                  key={c.key}
                  className="chip"
                  onClick={() => {
                    setKey(c.key)
                    setDescription(`Pages about ${c.key.replace(/-/g, ' ')}${c.tags.length > 0 ? `, currently tagged ${c.tags.slice(0, 3).join(', ')}` : ''}.`)
                    setTags(c.tags.slice(0, 4).join(', '))
                    setFromCandidate(c.key)
                  }}
                >
                  {c.key} <span className="n">{c.pageCount}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <label className="newdep-field">
          <span>Key</span>
          <input className="input" value={key} placeholder="lowercase-with-hyphens" onChange={(e) => setKey(e.target.value.toLowerCase())} />
          <span className="hint">
            {key !== '' && !KEY_RE.test(key)
              ? 'Lowercase letters, digits and hyphens only.'
              : taken.has(key)
                ? 'That domain already exists.'
                : "It becomes the shelf's sign and the pages' domain field."}
          </span>
        </label>

        <label className="newdep-field">
          <span>What belongs in it</span>
          <textarea className="input" value={description} placeholder="One or two sentences. The agents read this to file pages." onChange={(e) => setDescription(e.target.value)} />
        </label>

        <label className="newdep-field">
          <span>Tags</span>
          <input className="input" value={tags} placeholder="comma, separated, optional" onChange={(e) => setTags(e.target.value)} />
        </label>

        <div className="newdep-opts">
          <label>
            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
            <span>
              <b>Let a Fellow review it first.</b> A read-only run checks the key against the registry and the pages it
              would claim, and reports before anything moves.
            </span>
          </label>
          <label>
            <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
            <span>
              <b>Backfill afterwards.</b> A maintenance run files the pages that carry no domain into the new one. Costs
              a run.
            </span>
          </label>
        </div>

        <div className="newdep-actions">
          <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            <Icon name="plus" />
            {create.isPending ? 'Creating…' : 'Create department'}
          </button>
          {create.error != null && <span className="toast err">{(create.error as Error).message}</span>}
          {note !== null && <span className="toast ok">{note}</span>}
        </div>
      </div>
    </div>
  )
}
