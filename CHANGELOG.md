# Changelog

What changed between merges, for a reader asking "did something I relied on move?".

This project is not versioned: the packages are private, nothing reads the version field, and the
install is a clone of `main`. Work lands as one merge per body of work, each tagged by what it
was and the day it landed. The entries below are those merges, newest first. The engineering
journals under `docs/tasks/` carry the detail, findings and dead ends included; this file carries
only what a reader outside the work needs to know.

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
