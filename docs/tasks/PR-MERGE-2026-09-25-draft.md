# Pull request draft (TASKS-MERGE-2026-09-25 section 8)

The text below is what the third merge into LibrisVault opens with. It describes mechanisms,
never a vault subject (hard rule 7), and it is scanned with `vault-name-scan.mjs --file` in its
exact posted form before it is posted. Paste it rather than paraphrasing at the last minute: this
is the text most likely to leak, because it is the one written last. The numbers marked `<n>` are
filled in from the final gate run.

**Title:** A way out of the defect list, domains that split into peers, and a graph that says what a domain is built around

**Body:**

<n> commits since the last merge, in three pieces of work and a round on the Graph and System
screens that grew out of using them.

**A way out of the standing defect list.** The last merge turned the validator's findings into one
counted, dated row per defect. It also left them with nowhere to go: a row disappeared only when a
run happened to re-read its page. Every rule now says what can be done about it, and three paths
exist. A deterministic repair is planned as a per-page diff, applied only to pages whose content
still matches what was approved, and committed once. A bound agent run may touch exactly the pages
of the chosen findings - a second permission policy beside the expand lock, enforced by the same
hook - and one click reverts it. An accept records a reason for a defect that may stay, and can be
taken back.

**A domain that outgrows a shelf is split into peers.** On a vault where one domain holds two
fifths of the knowledge pages, filtering by it narrows nothing. A free, deterministic proposal - a
consensus of forty seeded community runs over the domain's own links - names the shelves it falls
into, with their evidence; the user decides per shelf; one commit writes the registry, the
`domain:` field of exactly the approved pages and the index, and one revert undoes it. The domain
that is split keeps its key, narrowed.

**A graph that says what a domain is built around.** The Landmarks overlay draws only a domain's
most-linked pages, named in full, with a reading order beside them: a walk through the ones linked
to what was already read, in chapters where nothing links on. The community overlay became
legible on a whole vault: captions that keep clear of the dots, a stepper through the areas, and
tags that name a kind of page (a person, a video) no longer passing for a subject - measured, they
made up most of the "related by tag" entries that crossed domains.

**What a reviewer should know first.**

- **Nothing is behind a new flag.** All of this corrects or extends the existing product; the
  research agents stay behind `AGENTS_ENABLED`, and the test asserting their routes 404 without it
  still passes.
- **Zero new runtime dependencies**, in either workspace. The manifests differ by npm scripts only.
- **Two new vault writers**, both user-initiated and both in the writer table of hard rule 1: the
  defect repair (a page half and a manifest half) and the domain split. The split refuses while an
  agent run writes the vault; the repair takes the vault's per-file lock and writes only the pages
  whose content still matches what was approved, reporting the busy and the changed ones.
- **One permission policy is new**, so the permission probe was run by hand before opening, not
  only the unit tests.
- **The queue now runs jobs in insertion order** rather than by timestamp: the wall clock steps back
  under load on the host this was measured on, and a later drop could run first.
- **No route is removed.** The System screen's old section links resolve to their new places.

**Specified, not just shipped.** `SPEC.md` gains the domain split as stage 4 of the meta
categories, the repair paths of the standing defect list, the Graph's four overlays with the rules
behind them, a correction for the System screen, and the queue's order. `docs/API.md` was diffed
against every route and closes carried-forward gaps as well as this merge's own.

**Measured before opening.** `npm test` (<n>), typecheck, lint and build all exit 0 and CI is
green. The permission probe <result>; the preprocessing jail holds across fourteen checks; the
vault contract probe reports all four texts the service parses still read as parsed. A stress loop
over the git-heavy test suites found three flaky tests before this merge and none after it.

**The private-content audit is in the task file**, including three wordings that were generalised
because they mirrored the private vault the screenshots are kept away from.

**Size.** <n> commits, <n> files, about <n> lines added and <n> removed. The commit messages are the
design record, so this is a merge commit rather than a squash.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
