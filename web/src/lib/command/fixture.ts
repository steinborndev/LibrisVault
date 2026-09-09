/**
 * Fixture data for the Fellow command centre (docs/tasks/TASKS-A7.md).
 *
 * The window is built as real components so that what you look at IS the final render; only
 * the data is invented. The shapes below are therefore not free-form: each one is what an
 * endpoint will have to return, and the three fields the service does not have yet are marked
 * as such. When the features land (A7 section 3.3), this module is replaced by queries and
 * nothing else moves.
 *
 * Numbers are the vault's own measurements, not guesses (A7 section 2): a `research-step`
 * takes 318 s and costs $2.13, a `research-expand` 311 s and $2.23, a planning run 86 s and
 * $0.55. A task therefore costs its run plus its own plan.
 */

import type { TaskKind } from '../../api/types.ts'

/** The service's three modes; `AgentRecord.autonomy` is a bare string on the client side. */
export type CcAutonomy = 'manual' | 'veto' | 'auto'
/** The run kinds a proposal can carry (`fellows.ts` `StepKind`). */
export type CcProposalKind = 'research' | 'research-step' | 'research-expand'

/** MISSING IN THE SERVICE: one art per Fellow, with its own cap. A7 section 3.3 item 2. */
export type FellowArt = TaskKind | 'custom'
/** MISSING IN THE SERVICE: whether a night works every standing task or one in turn. Item 1. */
export type SweepMode = 'sweep' | 'rotate'

export interface CcTask {
  readonly kind: TaskKind
  readonly text: string
  /** An explore task the planner reported covered; it no longer takes a turn. */
  readonly resting?: boolean
}

export interface CcOption {
  readonly id: string
  readonly kind: CcProposalKind
  /** The art of the task this was planned for - `provenance.task` on the real record. */
  readonly art: TaskKind
  readonly topic: string
  readonly rationale: string
  readonly lens: string
  /** Token overlap with the intent. Below 0.2 the service calls it drift and will not run it. */
  readonly scope: number
  readonly minutes: number
  readonly costUsd: number
  /** For a deepening: the pages it may touch, at most four. */
  readonly pageSet?: readonly string[]
  /** `provenance`: which candidate the idea came from, its text, and where it was read. */
  readonly from: { readonly candidate: string; readonly text: string; readonly page: string }
  readonly status: 'proposed' | 'approved'
}

export interface CcFellow {
  readonly id: string
  readonly name: string
  readonly intent: string
  readonly art: FellowArt
  readonly cap: number
  readonly mode: SweepMode
  readonly autonomy: CcAutonomy
  readonly state: 'asleep' | 'working' | 'paused' | 'quiet'
  readonly lens: string
  readonly model: string
  readonly effort: string
  readonly depth: string
  readonly weekPct: number
  readonly tasks: readonly CcTask[]
  readonly options: readonly CcOption[]
  readonly notebook: ReadonlyArray<{ readonly head: string; readonly body: string }>
  readonly ledger: ReadonlyArray<{ readonly when: string; readonly topic: string; readonly kind: string; readonly out: string; readonly cost: string }>
  readonly pages: readonly string[]
  readonly recap: {
    readonly date: string
    readonly ran: boolean
    readonly reason?: string
    readonly cost?: string
    readonly pages?: number
    readonly found: readonly string[]
    readonly questions: readonly string[]
    readonly proposals: ReadonlyArray<{ readonly status: string; readonly topic: string }>
    readonly opens: number
  }
  readonly week: { readonly runs: number; readonly usd: number; readonly points: number }
}

export interface CcDomain {
  readonly key: string
  readonly pages: number
  /** Open questions and never-written link targets on this shelf; the staffing argument. */
  readonly questions: number
  readonly gaps: number
  /** Handoffs routed here that no Fellow has taken (A7 D11). */
  readonly handoffs: readonly string[]
  readonly fellows: readonly CcFellow[]
}

/** Measured medians; a task is its run plus its own planning run. */
export const PLAN_MIN = 1.4
export const RUN_MIN: Record<TaskKind, number> = { watch: 5.3, explore: 5.3, deepen: 5.2 }
export const RUN_USD: Record<TaskKind, number> = { watch: 2.68, explore: 2.68, deepen: 2.78 }
export const MODEL_FACTOR: Record<string, number> = { sonnet: 1, opus: 2.5, fable: 5 }

export const taskMinutes = (kind: TaskKind): number => PLAN_MIN + RUN_MIN[kind]
export const taskUsd = (kind: TaskKind, model: string): number =>
  RUN_USD[kind] * (MODEL_FACTOR[model.toLowerCase()] ?? 1)

/** What a Fellow works tonight: every standing task, or the one whose turn it is. */
export function tonightTasks(f: CcFellow): readonly CcTask[] {
  const active = f.tasks.filter((t) => t.resting !== true)
  if (f.state === 'paused' || active.length === 0) return []
  return f.mode === 'sweep' ? active : active.slice(0, 1)
}

const fellow = (over: Partial<CcFellow> & Pick<CcFellow, 'id' | 'name' | 'intent' | 'art'>): CcFellow => ({
  cap: 3,
  mode: 'sweep',
  autonomy: 'veto',
  state: 'asleep',
  lens: 'broad',
  model: 'Sonnet',
  effort: 'High',
  depth: 'Standard',
  weekPct: 5,
  tasks: [],
  options: [],
  notebook: [],
  ledger: [],
  pages: [],
  recap: { date: '2026-09-09', ran: false, found: [], questions: [], proposals: [], opens: 0 },
  week: { runs: 0, usd: 0, points: 0 },
  ...over,
})

export const DOMAINS: readonly CcDomain[] = [
  {
    key: 'biomedicine',
    pages: 433,
    questions: 14,
    gaps: 3,
    handoffs: [],
    fellows: [
      fellow({
        id: 'clara',
        name: 'Clara',
        intent: 'newly approved biologics and mRNA/LNP therapeutics',
        art: 'custom',
        weekPct: 7,
        tasks: [
          { kind: 'watch', text: 'newly approved biologics and mRNA/LNP therapeutics' },
          { kind: 'explore', text: 'Which self-amplifying mRNA vaccines reached approval in 2026, and on what evidence?' },
          { kind: 'deepen', text: 'lipid nanoparticle formulation and manufacturing' },
        ],
        options: [
          {
            id: 'c1',
            kind: 'research',
            art: 'explore',
            topic: 'Which self-amplifying mRNA vaccines reached approval in 2026, and on what evidence?',
            rationale:
              'Two source pages state approvals in 2026 but neither says on what evidence the regulators decided. ' +
              'The vault holds the products and the trials as separate pages with nothing between them, so the question ' +
              'cannot be answered from the wiki at all today.',
            lens: 'broad',
            scope: 0.82,
            minutes: 13,
            costUsd: 2.68,
            from: {
              candidate: 'open-question',
              text: '"On what evidence were the 2026 sa-mRNA approvals granted?"',
              page: 'Self-Amplifying RNA and Circular RNA',
            },
            status: 'proposed',
          },
          {
            id: 'c2',
            kind: 'research',
            art: 'explore',
            topic: 'How do the EU and US differ in what they require as evidence for self-amplifying mRNA?',
            rationale:
              'The two assessment reports the vault holds reach the same conclusion by different routes. Naming the ' +
              'difference would make them readable as a pair rather than as two isolated summaries.',
            lens: 'broad',
            scope: 0.71,
            minutes: 15,
            costUsd: 2.68,
            from: {
              candidate: 'gap',
              text: 'Regulatory Evidence Standards — linked from 4 pages, never written',
              page: 'Assessment Report - Kostaive (EMA-CHMP, 2024)',
            },
            status: 'proposed',
          },
          {
            id: 'c3',
            kind: 'research-expand',
            art: 'deepen',
            topic: 'Build out the product pages with the indications they are approved for',
            rationale:
              'The theme matches six product pages; the four thinnest carry 19 backlinks between them and none says ' +
              'what the product is approved to treat — the second half of the standing intent. Filling in, not new ground.',
            lens: 'broad',
            scope: 0.9,
            minutes: 19,
            costUsd: 2.78,
            pageSet: ['mRNA-1273', 'Liposome', 'DOTAP', 'Apolipoprotein E (ApoE) Membrane Binding'],
            from: {
              candidate: 'stub',
              text: '6 pages matched the theme; the 4 thinnest were taken',
              page: 'mRNA-1273',
            },
            status: 'proposed',
          },
        ],
        notebook: [
          {
            head: '2026-09-08',
            body:
              'Filed seven pages on self-amplifying mRNA durability. The two source figures do not contradict each ' +
              'other; they measure different things, and I said so on both pages rather than picking one.',
          },
          {
            head: 'Open question',
            body:
              'The regulatory report states an accession the vault now records, so the reading-list entry that asked ' +
              'for it can close. I did not close it myself — the list is append-only for me.',
          },
          {
            head: 'What I am avoiding',
            body:
              'Three nights running I proposed questions out of my own notebook. That is a loop, and the sweep ' +
              'candidate exists to break it — this week I take a topic from the vault’s own gaps instead.',
          },
        ],
        ledger: [
          { when: '09-08 01:12', topic: 'Self-amplifying mRNA durability', kind: 'research', out: '7 pages', cost: '$2.58' },
          { when: '09-06 01:04', topic: 'FDA antibody approvals, reconciled', kind: 'research-step', out: '3 pages', cost: '$2.61' },
          { when: '09-04 01:09', topic: 'LNP manufacturing literature', kind: 'research-expand', out: '4 pages', cost: '$2.74' },
          { when: '09-03 01:02', topic: 'Planning run', kind: 'plan', out: '—', cost: '$0.54' },
        ],
        pages: [
          'Lipid Nanoparticle',
          'LNP Formulation Design Parameters',
          'Endosomal Escape',
          'Selective Organ Targeting',
          'Apolipoprotein E (ApoE) Membrane Binding',
          'mRNA-1273',
          'Good Manufacturing Practice',
          'Stability Testing of New Drugs',
        ],
        recap: {
          date: '2026-09-09',
          ran: true,
          cost: '$2.58',
          pages: 7,
          found: [
            'Seven pages on self-amplifying mRNA durability, cross-linked to the two assessment reports the vault already held.',
            'The day-181 and day-361 figures measure different things; both pages now say which.',
            'One reading-list entry can close: the document it asked for is filed with its address.',
          ],
          questions: ['On what evidence were the 2026 approvals granted?', 'Do the EU and US differ in what they require?'],
          proposals: [
            { status: 'approved', topic: 'Self-amplifying mRNA durability' },
            { status: 'standing', topic: 'EU vs US evidence requirements' },
            { status: 'vetoed', topic: 'Manufacturer press coverage' },
          ],
          opens: 6,
        },
        week: { runs: 4, usd: 8.47, points: 1.1 },
      }),
      fellow({
        id: 'beatrice',
        name: 'Beatrice',
        intent: 'LNP manufacturing and process control',
        art: 'deepen',
        state: 'working',
        lens: 'sota',
        effort: 'Medium',
        weekPct: 7,
        tasks: [{ kind: 'deepen', text: 'LNP manufacturing and process control' }],
        options: [
          {
            id: 'b1',
            kind: 'research-expand',
            art: 'deepen',
            topic: 'Build out the LNP manufacturing pages with the 2026 process literature',
            rationale:
              'Four concept pages match this theme and all four are thin against how much links to them: LNP ' +
              'Manufacturing and Characterisation is 0.8 KB with 11 pages pointing at it. This adds no new ground, ' +
              'it thickens what the vault already leans on.',
            lens: 'sota',
            scope: 0.88,
            minutes: 24,
            costUsd: 2.78,
            pageSet: [
              'LNP Manufacturing and Characterisation',
              'Good Manufacturing Practice',
              'Quality by Design Core Concepts',
              'Stability Testing of New Drugs',
            ],
            from: {
              candidate: 'stub',
              text: '4 concept pages under 1 KB with 24 backlinks between them',
              page: 'LNP Manufacturing and Characterisation',
            },
            status: 'proposed',
          },
        ],
        notebook: [
          {
            head: '2026-09-09',
            body: 'A run was interrupted when the machine shut down at 01:00. Nothing lost; the round was closed on restart.',
          },
          {
            head: '2026-09-07',
            body: 'The EPAR and the trial paper answer different questions. Filed both, cross-linked, with the difference named.',
          },
        ],
        ledger: [
          { when: '09-07 01:20', topic: 'EU assessment reports, 2026', kind: 'research-expand', out: '4 pages', cost: '$2.66' },
          { when: '09-05 01:15', topic: 'Process control literature', kind: 'research-expand', out: '4 pages', cost: '$2.71' },
        ],
        pages: ['Assessment Report - Kostaive', 'European Medicines Agency', 'Self-Amplifying RNA'],
        recap: {
          date: '2026-09-09',
          ran: false,
          reason: 'a run was interrupted when the machine shut down at 01:00; the round was closed on restart',
          found: [],
          questions: [],
          proposals: [{ status: 'standing', topic: 'LNP manufacturing literature' }],
          opens: 1,
        },
        week: { runs: 2, usd: 5.37, points: 0.7 },
      }),
      fellow({
        id: 'hedy',
        name: 'Hedy',
        intent: 'antibody-drug conjugates',
        art: 'explore',
        state: 'quiet',
        tasks: [
          { kind: 'explore', text: 'How do ADC payload classes differ in off-target toxicity?', resting: true },
          { kind: 'explore', text: 'Which linker chemistries reached approval in 2025?', resting: true },
        ],
        notebook: [
          { head: '2026-09-06', body: 'Both questions answered as far as the library can take them. Nothing left to pursue.' },
        ],
        ledger: [{ when: '09-06 01:11', topic: 'Linker chemistries, approved 2025', kind: 'research', out: '5 pages', cost: '$2.90' }],
        pages: ['Antibody-Drug Conjugate'],
        recap: {
          date: '2026-09-09',
          ran: false,
          reason: 'every standing task is answered as far as the library can take it',
          found: [],
          questions: [],
          proposals: [],
          opens: 0,
        },
        week: { runs: 1, usd: 2.9, points: 0.4 },
      }),
    ],
  },
  {
    key: 'machine-learning',
    pages: 80,
    questions: 6,
    gaps: 2,
    handoffs: [],
    fellows: [
      fellow({
        id: 'ada',
        name: 'Ada',
        intent: 'training-time compute scaling and its published results',
        art: 'explore',
        autonomy: 'manual',
        lens: 'sota',
        model: 'Opus',
        depth: 'Deep',
        weekPct: 12,
        tasks: [
          { kind: 'explore', text: 'What replaced attention in the 2026 long-context architectures?' },
          { kind: 'explore', text: 'How is long-context performance actually measured?' },
        ],
        options: [
          {
            id: 'a1',
            kind: 'research',
            art: 'explore',
            topic: 'What has replaced attention in the 2026 long-context architectures?',
            rationale:
              'The standing task asks about architectures; the vault has the 2025 generation and nothing since. ' +
              'The straightforward continuation.',
            lens: 'sota',
            scope: 0.79,
            minutes: 16,
            costUsd: 6.7,
            from: { candidate: 'open-question', text: '"What replaced attention in 2026?"', page: 'Training Deep Neural Networks' },
            status: 'proposed',
          },
          {
            id: 'a2',
            kind: 'research',
            art: 'explore',
            topic: 'How is long-context performance actually measured, and what do the benchmarks miss?',
            rationale:
              'A methodology question rather than a results question. It scores 0.14 against the intent, below the ' +
              'drift threshold, so it will not run unless you say so — but the architecture pages keep citing ' +
              'benchmarks the vault never explains, and every one of them rests on something unwritten.',
            lens: 'sota',
            scope: 0.14,
            minutes: 18,
            costUsd: 6.7,
            from: { candidate: 'sweep', text: 'the vault’s own gaps, not this notebook', page: 'Scikit-Learn' },
            status: 'proposed',
          },
        ],
        notebook: [
          {
            head: '2026-09-08',
            body: 'The vault had the architecture pages but nothing on the evaluation methodology. That is the gap worth closing.',
          },
        ],
        ledger: [{ when: '09-08 01:30', topic: 'Long-context evaluation methods', kind: 'research', out: '4 pages', cost: '$6.45' }],
        pages: ['Scikit-Learn', 'Training Deep Neural Networks', 'PyTorch'],
        recap: {
          date: '2026-09-09',
          ran: true,
          cost: '$6.45',
          pages: 4,
          found: ['Four pages on long-context evaluation. The architecture pages cited benchmarks the vault never described; they do now.'],
          questions: ['What do the standard long-context benchmarks fail to measure?'],
          proposals: [{ status: 'standing', topic: 'What replaced attention in 2026' }],
          opens: 3,
        },
        week: { runs: 1, usd: 6.45, points: 0.8 },
      }),
    ],
  },
  {
    key: 'finance',
    pages: 71,
    questions: 4,
    gaps: 1,
    handoffs: [],
    fellows: [
      fellow({
        id: 'vera',
        name: 'Vera',
        intent: 'sovereign debt and reserve-currency mechanics',
        art: 'watch',
        lens: 'startups',
        tasks: [{ kind: 'watch', text: 'reserve-currency mechanics' }],
        notebook: [{ head: '2026-09-05', body: 'Filed the Bretton Woods page. The vault treats this as history; the live mechanics are the gap.' }],
        ledger: [{ when: '09-05 01:08', topic: 'Bretton Woods dollar system', kind: 'research-step', out: '3 pages', cost: '$2.49' }],
        pages: ['Bretton Woods Dollar System', 'Financial Repression'],
        recap: {
          date: '2026-09-09',
          ran: false,
          reason: 'nothing worth a run in its domains',
          found: [],
          questions: [],
          proposals: [],
          opens: 0,
        },
        week: { runs: 1, usd: 2.49, points: 0.3 },
      }),
    ],
  },
  {
    key: 'ai-tooling',
    pages: 123,
    questions: 8,
    gaps: 2,
    handoffs: [],
    fellows: [
      fellow({
        id: 'grace',
        name: 'Grace',
        intent: 'agent frameworks and how teams actually use them',
        art: 'watch',
        weekPct: 7,
        tasks: [
          { kind: 'watch', text: 'agent frameworks in production' },
          { kind: 'watch', text: 'how teams adopt them in production' },
        ],
        notebook: [{ head: '2026-09-08', body: 'Wrote the skills tutorial synthesis. It is long; the next pass should split it.' }],
        ledger: [{ when: '09-08 21:45', topic: 'Claude Code skills tutorial', kind: 'research', out: '23 pages', cost: '$6.45' }],
        pages: ['Agentic Loop', 'Claude SEO', 'Vibe Coding'],
        recap: {
          date: '2026-09-09',
          ran: true,
          cost: '$6.45',
          pages: 23,
          found: ['A synthesis of the skills documentation, filed as 23 pages.'],
          questions: [],
          proposals: [],
          opens: 2,
        },
        week: { runs: 1, usd: 6.45, points: 0.8 },
      }),
    ],
  },
  /* Shelves nobody looks after. `handoffs` are questions routed here that found no Fellow. */
  { key: 'materials-science', pages: 55, questions: 9, gaps: 4, handoffs: ['How do MOF linker choices change thermal stability?'], fellows: [] },
  { key: 'brain-computer-interface', pages: 40, questions: 7, gaps: 3, handoffs: [], fellows: [] },
  { key: 'battery-technology', pages: 25, questions: 4, gaps: 1, handoffs: [], fellows: [] },
  { key: 'general-relativity', pages: 23, questions: 2, gaps: 2, handoffs: [], fellows: [] },
  { key: 'fusion-energy', pages: 22, questions: 3, gaps: 1, handoffs: [], fellows: [] },
  { key: 'quantum-computing', pages: 14, questions: 2, gaps: 0, handoffs: [], fellows: [] },
  { key: 'carbon-fiber', pages: 13, questions: 1, gaps: 1, handoffs: [], fellows: [] },
]

/** The four shapes a new Fellow can start from (A7 D7): worked examples, not types. */
export interface CcShape {
  readonly key: string
  readonly name: string
  readonly art: FellowArt
  readonly cap: number
  readonly want: string
  readonly what: string
  readonly autonomy: CcAutonomy
  readonly model: string
  readonly effort: string
  readonly depth: string
  readonly lens: string
  readonly weekPct: number
}

export const SHAPES: readonly CcShape[] = [
  {
    key: 'observer',
    name: 'The observer',
    art: 'watch',
    cap: 3,
    want: 'Keep me current.',
    what:
      'Searches the web for what is new in a subject and writes it into the vault. A watch task never finishes — it ' +
      'comes round for as long as there is something to find.',
    autonomy: 'veto',
    model: 'Sonnet',
    effort: 'High',
    depth: 'Standard',
    lens: 'broad',
    weekPct: 5,
  },
  {
    key: 'researcher',
    name: 'The researcher',
    art: 'explore',
    cap: 3,
    want: 'Answer my questions.',
    what:
      'Searches the web to answer one question, reads the sources it finds and writes the synthesis into the vault. ' +
      'The question rests once the planner judges the vault has it covered; when the last one rests the Fellow goes ' +
      'quiet and waits for a new question from you.',
    autonomy: 'manual',
    model: 'Opus',
    effort: 'High',
    depth: 'Deep',
    lens: 'sota',
    weekPct: 12,
  },
  {
    key: 'librarian',
    name: 'The librarian',
    art: 'deepen',
    cap: 3,
    want: 'Expand what we already have.',
    what:
      'Ranks the concept and entity pages of this shelf against a theme — backlinks per kilobyte — and extends the ' +
      'four thinnest with what it finds on the web. It writes no new pages.',
    autonomy: 'veto',
    model: 'Sonnet',
    effort: 'Medium',
    depth: 'Standard',
    lens: 'broad',
    weekPct: 7,
  },
  {
    key: 'custom',
    name: 'Custom',
    art: 'custom',
    cap: 3,
    want: 'Something of my own.',
    what:
      'Any mix of the three arts, up to three tasks, and every setting yours from the start. The shape with no ' +
      'opinion about what a Fellow should be.',
    autonomy: 'auto',
    model: 'Sonnet',
    effort: 'High',
    depth: 'Standard',
    lens: 'broad',
    weekPct: 7,
  },
]

/** What each art is, in the words the app already uses (lib/library/tasks.ts, planner.ts). */
export const ART_TEXT: Record<TaskKind, string> = {
  watch: 'Searches the web for what is new in a subject. Never finished.',
  explore: 'Searches the web to answer one question. The only art that can be put to rest.',
  deepen: 'Extends the pages the vault already has on a theme, at most four a night. Writes no new pages.',
}

/** What each autonomy mode means, from `fellows.ts` `runnable()`. */
export const AUTONOMY_TEXT: Record<CcAutonomy, { readonly label: string; readonly short: string; readonly long: string }> = {
  manual: {
    label: 'Ask me every time',
    short: 'asks first',
    long: 'Nothing runs unless you approve it. A night with no approval is a night with no result.',
  },
  veto: {
    label: 'Run unless I stop it',
    short: 'runs unless stopped',
    long:
      'Tonight it plans; tomorrow night the top proposal runs, unless you veto it during the day. A proposal that ' +
      'drifts too far from the intent still waits for you.',
  },
  auto: {
    label: 'Run the same night',
    short: 'runs the same night',
    long: 'Plans and carries out its top proposal in one night. Drifting proposals are dropped rather than shown to you.',
  },
}

/** Below this overlap the service calls a proposal drift and will not run it unasked. */
export const DRIFT_THRESHOLD = 0.2
