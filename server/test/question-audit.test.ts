import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asksAQuestion,
  classifyQuestion,
  hasPassDeixis,
  passDeixisIn,
  readsAsLimitation,
  PASS_DEIXIS,
} from '../src/pipeline/question-form.js'
import {
  auditQuestions,
  bucketOf,
  clusterQuestions,
  collectBullets,
  listWikiPages,
  redact,
  CLUSTER_THRESHOLD,
} from '../src/cli/questionaudit.js'

/**
 * The audit harness (docs/tasks/TASKS-QUESTIONS.md, task 0.1), over a hand-built vault
 * carrying one planted instance of every class the audit counts.
 *
 * Every question in the fixture is invented (hard rule 7). The subject is a tidal turbine,
 * which this vault does not hold and which the other prompt tests already use.
 */
const FIXTURE = path.resolve(fileURLToPath(new URL('./fixtures/questions-vault', import.meta.url)))

describe('question form', () => {
  it('reads a question mark as the thing that asks', () => {
    expect(asksAQuestion('What is the capacity factor?')).toBe(true)
    expect(asksAQuestion('What is the capacity factor?  ')).toBe(true)
    expect(asksAQuestion('The capacity factor was not measured.')).toBe(false)
    // A question mark mid-sentence is not a question: the bullet goes on to report something.
    expect(asksAQuestion('Is it viable? The pass did not establish it.')).toBe(false)
  })

  it('reads a limitation note by how it reports the absence', () => {
    expect(readsAsLimitation('No source in this pass gives an installed-cost figure.')).toBe(true)
    expect(readsAsLimitation('Blade fatigue was not measured by either source.')).toBe(true)
    expect(readsAsLimitation('The maintenance interval remains unverified.')).toBe(true)
    expect(readsAsLimitation('This would need a dedicated engineering pass.')).toBe(true)
    expect(readsAsLimitation('Sediment loading shortens bearing life.')).toBe(false)
  })

  it('classifies in one order: a question first, then a limitation, then a statement', () => {
    // A bullet that asks has done its job however it explains itself.
    expect(classifyQuestion('What figure exists, given that no source in this pass gave one?')).toBe('question')
    expect(classifyQuestion('No source in this pass gave a figure.')).toBe('limitation')
    expect(classifyQuestion('Sediment loading shortens bearing life.')).toBe('statement')
  })

  it('names the deixis it found, one entry per phrase', () => {
    expect(passDeixisIn('Not measured in this pass by either source.')).toEqual(['this pass', 'either source'])
    expect(hasPassDeixis('Which coating reduces abrasion?')).toBe(false)
    // Every phrase in the list is reachable: a typo in one would otherwise never be noticed.
    for (const d of PASS_DEIXIS) expect(d.re.test(`text ${d.name.replace('N', 'two')} text`)).toBe(true)
  })
})

describe('collecting bullets', () => {
  it('reads every open-questions section and nothing else', () => {
    const pages = listWikiPages(FIXTURE)
    expect(pages).toContain('wiki/index.md')
    expect(pages.every((p) => p.endsWith('.md'))).toBe(true)
    const bullets = collectBullets(FIXTURE)
    // Five pages, four with a section; `wiki/index.md` is the control and contributes none.
    expect(new Set(bullets.map((b) => b.page)).size).toBe(4)
    expect(bullets.some((b) => b.page === 'wiki/index.md')).toBe(false)
  })

  it('skips the placeholder and the answered bullet, and marks the struck one archived', () => {
    const bullets = collectBullets(FIXTURE)
    expect(bullets.some((b) => /^\(none/i.test(b.text))).toBe(false)
    expect(bullets.some((b) => /\(answered/i.test(b.text))).toBe(false)
    const archived = bullets.filter((b) => b.archived)
    expect(archived).toHaveLength(1)
    expect(archived[0]!.text).toMatch(/^Whether composite layup/)
    expect(archived[0]!.text).not.toContain('~~')
  })

  it('joins a bullet that wraps onto continuation lines', () => {
    const wrapped = collectBullets(FIXTURE).find((b) => b.text.startsWith('The maintenance interval'))
    expect(wrapped).toBeDefined()
    expect(wrapped!.text).toContain('vendor claim')
    expect(wrapped!.text).not.toContain('\n')
  })

  it('names the bucket a page sits in', () => {
    expect(bucketOf('wiki/concepts/Tidal Turbine.md')).toBe('concepts')
    expect(bucketOf('wiki/meta/agents/fixture.md')).toBe('meta')
    expect(bucketOf('wiki/index.md')).toBe('root')
  })
})

describe('clustering', () => {
  const sameQuestion = [
    'Tidal turbine blade fatigue under continuous sediment loading was not measured by either source in this pass.',
    'Whether continuous sediment loading causes measurable blade fatigue in tidal turbines was not established.',
    'Blade fatigue from sediment loading in tidal turbines remains unquantified.',
  ]

  it('groups three wordings of one question written on three pages', () => {
    const clusters = clusterQuestions(sameQuestion)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual([0, 1, 2])
  })

  it('leaves a narrower follow-up on the same subject alone', () => {
    // The expensive error (`dedupe-judge.ts`): merging away the most valuable kind of question.
    const clusters = clusterQuestions([sameQuestion[2]!, 'Which coating materials reduce sediment abrasion on tidal turbine blades?'])
    expect(clusters).toHaveLength(0)
  })

  it('leaves two different questions on one page alone', () => {
    const clusters = clusterQuestions([
      'What is the measured capacity factor of a rack-mounted tidal turbine over a full spring-neap cycle?',
      'How long does a pitch bearing last in continuous submerged service?',
    ])
    expect(clusters).toHaveLength(0)
  })

  it('reports a question that stands alone as no cluster at all', () => {
    expect(clusterQuestions(['Only one question here.'])).toEqual([])
    expect(clusterQuestions([])).toEqual([])
  })

  it('orders clusters largest first and members in input order', () => {
    const texts = [...sameQuestion, 'A wholly different question about grid connection charges?']
    const clusters = clusterQuestions(texts)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual([0, 1, 2])
  })

  it('takes the threshold as an argument, so it can be re-argued', () => {
    expect(clusterQuestions(sameQuestion, 0.99)).toHaveLength(0)
    expect(CLUSTER_THRESHOLD).toBe(0.7)
  })
})

describe('the report', () => {
  const report = auditQuestions(FIXTURE, new Date('2026-09-20T10:00:00Z'))

  it('counts what the fixture plants', () => {
    expect(report.takenAt).toBe('2026-09-20')
    expect(report.pagesScanned).toBe(5)
    expect(report.pagesWithQuestions).toBe(4)
    expect(report.bullets).toEqual({ total: 9, open: 8, archived: 1 })
    expect(report.form).toEqual({ question: 3, limitation: 3, statement: 2 })
  })

  it('counts deixis per phrase over the open bullets only', () => {
    expect(report.deixis.total).toBe(3)
    expect(report.deixis.byPhrase['this pass']).toBe(2)
    expect(report.deixis.byPhrase['either source']).toBe(1)
    expect(report.deixis.byPhrase['both sources']).toBe(0)
  })

  it('measures length against the two caps it does not own', () => {
    expect(report.length.titleCap).toBe(120)
    expect(report.length.topicCap).toBe(500)
    expect(report.length.overTitleCap).toBe(1)
    expect(report.length.overTopicCap).toBe(0)
    expect(report.length.min).toBeLessThan(report.length.max)
  })

  it('reports the cluster and what is left after it', () => {
    expect(report.clusters.count).toBe(1)
    expect(report.clusters.questionsCovered).toBe(3)
    expect(report.clusters.crossPage).toBe(1)
    expect(report.clusters.distinctAfterClustering).toBe(6)
  })

  it('groups by bucket', () => {
    expect(report.byBucket).toEqual({ concepts: 6, meta: 1, questions: 1 })
  })
})

describe('the committable form', () => {
  it('carries no question text and no page path', () => {
    const full = auditQuestions(FIXTURE)
    expect(full.clusterMembers?.[0]?.[0]?.text).toBeTypeOf('string')
    const safe = redact({ ...full, vaultRoot: FIXTURE })
    const json = JSON.stringify(safe)
    expect(json).not.toContain('tidal')
    expect(json).not.toContain('Tidal')
    expect(json).not.toContain('wiki/')
    expect(json).not.toContain(FIXTURE)
    // The counts survive: the redaction drops text, never numbers.
    expect(safe.bullets.open).toBe(full.bullets.open)
    expect(safe.clusters.count).toBe(full.clusters.count)
  })
})

describe('read-only', () => {
  it('writes nothing under the vault it audits', () => {
    const snapshot = (): string =>
      listWikiPages(FIXTURE)
        .map((rel) => {
          const st = fs.statSync(path.join(FIXTURE, rel))
          return `${rel}:${st.size}:${st.mtimeMs}`
        })
        .join('\n')
    const before = snapshot()
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    const filesBefore = walk(FIXTURE).sort()
    auditQuestions(FIXTURE)
    collectBullets(FIXTURE)
    expect(snapshot()).toBe(before)
    expect(walk(FIXTURE).sort()).toEqual(filesBefore)
  })
})
