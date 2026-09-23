# Changelog

What changed between merges, for a reader asking "did something I relied on move?".

This project is not versioned: the packages are private, nothing reads the version field, and the
install is a clone of `main`. Work lands as one merge per body of work, each tagged by what it
was and the day it landed. The entries below are those merges, newest first. The engineering
journals under `docs/tasks/` carry the detail, findings and dead ends included; this file carries
only what a reader outside the work needs to know.

## 2026-09-xx - splitting an oversized domain into peers

The domain registry knew how a domain is born from pages that fit nothing, and nothing about a
domain that has outgrown being a shelf. On a vault where one domain holds two fifths of the
knowledge pages, filtering by it narrows nothing. This adds the other direction: a deterministic
proposal of the shelves such a domain falls into, a view of them, and a user-approved write that
turns chosen shelves into peer domains and re-files their pages in ONE commit that one revert
undoes. The domain that is split keeps its key, narrowed so it no longer claims what left it.

### Added

- **`GET /api/v1/domains/:key/split`**, the proposal. A consensus of forty seeded Louvain runs
  over the domain's knowledge pages and the links among them, not one run: a single run moves a
  few per cent of the pages to another shelf on node order alone, the consensus a fraction of one.
  A shelf is a stable group of 25 pages or more; smaller groups stay with the domain. Each shelf
  carries its evidence - how many of its links leave it, how reliably the runs agree on it, how
  well tags alone tell it from its siblings, the pages it is built around, its distinctive tags
  and what one of them would cost as a key - and the shelves are ranked by how cleanly they stand
  apart, not by size. Free, read-only, the same for the same vault.
- **The Shelves overlay on the Graph screen**, beside Landmarks and under the same condition (one
  domain on show). The hulls are the proposal's shelves rather than the communities of the
  drawing, and a chip per shelf narrows the view to it. The Catalog carries the same chips when
  one domain is selected.
- **The decision surface in System's Domains card**, and as a step of the guided maintenance run:
  per shelf promote, merge with another, leave or defer; per new domain a key checked while it is
  typed (including how many pages already carry it as a tag), a description and tags; the domain
  being split as a diff of its entry. An optional read-only agent pass drafts the names. Preview
  shows the registry diff, the pages per new domain, what would be skipped and why, and the
  warnings; Apply writes after a second click.
- **The write**: the narrowed registry section and the new sections directly after it, the
  `domain:` line of exactly the approved pages, identified by address and each only while it still
  carries the old key, and `wiki/index.md`, in one commit. `updated:` is stamped and
  `content_updated:` is not: the pages say what they said. It refuses while an agent run writes the
  vault and while auto-commit is off, and it registers as a writer while it writes.
- **The applied splits**, each with its live remainder (pages that did not move, or were moved
  back) and a re-file for it, and a revert that takes the split's commits back newest first and
  refuses, naming them, while pages outside the split carry one of its keys.
- **`npm run splitprobe -- <domain> [--stability]`**, the proposal for a domain of a real vault,
  read-only, with the drift under other seeds and the vault some days back.
- **Migration 37**: applied splits and the leave and defer decisions. Operational state only.

### Changed

- The registry is no longer append-only for one writer: a split replaces the section of the domain
  it splits. The seed's conventions say when that is right: altitude is judged against the vault's
  volume, and a domain that outgrows a shelf is split into peers.
- `louvainCommunities` has a server copy with a resolution parameter; both copies are pinned by
  one shared fixture asserted in each suite.
- A read-only maintenance run says so in its own log.

### Fixed

- **A page whose path the vault's lock script refuses was busy forever for every batch writer.**
  The script answers a path containing `..` (a title ending in a full stop) with a refusal, which
  the single-page lock has always treated as "write unlocked" and the batch lock reported as
  "busy". The batch lock now does what the single one does.
- The Research screen asked for the plan windows without the Fellows wired, one 404 per visit
  with the flag off.

## 2026-09-21 - a path out of the standing defect list

The standing defect list ended one failure and stopped there: it replaced 406 advisory lines in
job logs nobody read with 57 rows on the System screen, and every row was a `<span>`. No link to
the page, no evidence, no statement of who was supposed to do anything. Six of the nine standing
rules need a judgement, which means a person decides - and the person had been given a list and
nothing else. This gives every defect a path: fixable, acceptable, or explained and linked.

### Added

- **A row opens.** It shows where its subject is - the page, or the job its `.raw/` directory
  names - the evidence the finding is based on, and one line saying what the repair is, who
  performs it and what it costs. For a quotation the evidence is written down when the finding is
  made, because the check compares the page against the document the job read and nothing
  afterwards holds that document. `npm run backfill-quote-evidence` fills it in for findings that
  predate the column.
- **Three blocks instead of one list**: fixable, your decision, accepted. The rule chips stay as
  a filter. "What's due" names the defects, which it never did - it said *Everything healthy*
  above 57 of them.
- **Accept, permanently and with a reason.** A list that cannot be emptied becomes the job-log
  lines again one layer up. Accepted findings leave the list, the rule counts and the lint-fix
  prompt, and can be taken back.
- **The deterministic repair passes are reachable from the dashboard**: plan, read the diff per
  page, uncheck what you disagree with, apply - one commit, revertable. The plan is filtered to
  the pages the list actually showed; the vault-wide sweep stays `npm run vaultrepair`.
- **A bound agent run** for the two rules whose repair needs reading and where a run was measured
  to deliver it: a quotation checked against the document the job read, and a missing section
  filled from what the page and the graph already hold. One page per finding, at most ten, no
  other page and no new page - enforced at tool time and by a commit check that reverts.

### Changed

- **The list pages.** It asked for 50 rows and had no way past them, so 7 of 57 were unreachable
  from the screen entirely.
- **The defect card moved** from the foot of System → Checks into the maintenance card set, so
  the status head can name it and jump to it like every other tool. It is one click further away
  and mentioned where it never was.
- **`SPEC.md` §12.15 no longer says open questions are repaired one at a time only.** Pipeline
  code still rewrites nothing; a bound agent run over one page is the writer the hard rule
  allows. A reformulated question is a NEW question - the text is its identity - so research a
  Fellow planned from the old wording is vetoed, and the confirmation says so before the run.
- **`npm run vaultrepair` commits through the service's own writer.** It used to take the vault's
  per-file locks and commit with no commit mutex at all, which is acceptable for a hand-run
  one-off and not for the same code called from a service.

### Known limits, measured rather than assumed

- **A run for the open-question rule exists and is not offered.** Against a bar agreed before it
  ran - every bullet asks something, at most 2 of 10 pages still referring to the run that wrote
  them - one run over 10 pages left 2 of 68 bullets asking nothing and 5 of 10 pages still
  referring. A large improvement on where those pages started (17 of 61 bullets asked anything)
  and short of what was asked for, so the rule stays a decision.
- **Two rules reach no button at all**, and their rows say why: the title-drift pass repairs the
  pages that LINK to a drifted title and never the page the finding stands on, and the address
  map cannot invent what a job directory held.
- **A quote finding is one per PAGE, not one per quotation.** Repairing one bad quotation on a
  page that has two leaves the row standing, and the count is what moves.

## 2026-09-21 - the vault layer made correct, and an open question that survives leaving its page

Tag `vault-layer-2026-09-21`. 96 commits, 222 files.

### Removed

- **A chat answer never becomes vault content.** A "Save session to vault" button used to start a
  write-enabled run that resumed the chat's session and ran the vault's own save flow. The
  button, the route `POST /api/v1/sessions/:id/save` and the runner behind it are gone, and a
  test asserts the route is unreachable. Reading the vault and writing it are separate paths now,
  and only a run writes. This is the only breaking change in this merge.

### Changed

- **The service owns the hub layer.** `wiki/index.md` and a run's `wiki/log.md` entry are
  generated from page frontmatter and written inside that run's own commit rather than asked of
  the agent. `wiki/hot.md` deliberately stays with the agent.
- **A page records when its content changed**, separately from when it was touched, so a
  mechanical pass over the vault no longer reads as a vault-wide update. The graph's recency lens
  and the catalog's freshness column both read it.
- **Derived payloads and oversized originals stay out of vault git.** Existing history is not
  rewritten; the growth is stopped.
- **The queue runs one ingest at a time by default.** The vault's own skill was built for a
  single writer and says so. The setting still accepts more, and the UI says what would have to
  be true first.
- **Validator findings are a standing list**, one row per defect with how often it has been seen
  and how long it has stood, instead of one advisory line per run in a job log. Findings remain
  advisory: nothing is rewritten for you.
- **An open question is written to survive leaving its page.** Every vault-writing run is told
  how, the board shows one card per question however many pages carry it, and starting research
  reformulates the bullet into a topic first.

### Fixed

- **The repository can be cloned on Windows.** Four tracked files carried a character a file name
  cannot hold there.
- **The dashboard recognises a synthesis page filed after 2026-09-19.** The web workspace kept
  its own copy of a title prefix the server had changed, so a current page was not recognised as
  one and the composer previewed a name the run would not use.

### For an existing vault

Pages written before this merge keep whatever names and titles they were given. `npm run
vaultrepair` is a hand-run one-off that repairs them by rule, a dry run by default, and it
deletes, renames and merges nothing on its own.

## 2026-09-17 - research agents behind a flag, source integrity, and the Library as a room

Tag `research-agents-2026-09-17`, merged as steinborndev/LibrisVault#13. 401 commits, 436 files.

### Added

- **Research agents ("Fellows"), behind `AGENTS_ENABLED`** and off by default. Standing agents
  that plan from the vault's own open questions and work at night. With the flag unset nothing of
  them is constructed and their routes do not exist, which a test asserts.
- **The Library screen**: the vault as a room, domains as shelves, Fellows at desks.
- **Source integrity, deliberately not behind a flag**, because each part corrects the existing
  pipeline rather than adding a subsystem beside it.

### Changed

- **The tabular view is called Catalog.** Nothing behaves differently; the name went to the room
  screen.
