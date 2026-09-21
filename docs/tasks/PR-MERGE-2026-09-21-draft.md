# Pull request draft (TASKS-MERGE-2026-09-21 section 6)

The text below is what the second merge into LibrisVault opens with. It describes mechanisms,
never a vault subject (hard rule 7), and it was scanned with `vault-name-scan.mjs --file` before
being posted. Paste it rather than paraphrasing at the last minute: this is the text most likely
to leak, because it is the one written last.

**Title:** The vault layer made correct, and an open question written so it survives leaving its page

**Body:**

Ninety-six commits since the last merge. Two pieces of work, and a tail of corrections that only
appeared once the finished machinery was pointed at a real vault of 1,247 pages.

**The vault layer.** A measurement harness first, then the repairs it justified. The service now
owns the hub layer: `wiki/index.md` and the run's log entry are generated from page frontmatter
and written inside that run's own commit, which is what keeps "one run, one commit" true, after
the prompt-driven version had grown the index to 514 kB. A page says when its CONTENT last
changed as distinct from when it was touched, so a mass pass no longer reads as a vault-wide
update. Derived payloads and oversized originals leave vault git, which had reached 1.4 GB
carrying 16 MB of knowledge. Crash recovery keys on a marker the run writes rather than on
parsing a log. And the validator stopped being advisory noise: 406 findings went into job logs
where the same dead link was reported 109 times, and they are one row per defect now, counted and
dated, with a fix showing up as a row that stops being seen.

**An open question, written so it survives leaving its page.** A bullet under that heading is
read by somebody who is not looking at the page it stands on: off a board, or by a research run
given it as its whole brief. Measured over 355 of them, 29 asked something and 152 pointed back
at the run that wrote them. A rule now reaches every vault-writing run through the system-prompt
extension, the board shows one card per question however many pages carry it, and starting
research reformulates the bullet into a topic first, with its origin page as context.

**The honest half of that result is in the spec**, because it is the useful half. The prompt rule
took "asks something" from 8 per cent to all of them and did NOT remove the back-references: the
vault contains that phrasing hundreds of times, so a run is copying the documented house style of
the place it writes for, and one line of prompt argues against every worked example. What removes
them is the reformulation in front of a run, which is also the only place they do harm. The spec
says not to sharpen the wording a third time.

**What a reviewer should know first.**

- **Nothing is behind a new flag.** Both of the above correct the existing pipeline rather than
  adding a subsystem beside it, which is the same reasoning source integrity was not gated on.
  The research agents stay behind `AGENTS_ENABLED`, and the test that asserts their routes 404
  with it unset still passes.
- **Zero new runtime dependencies**, in either workspace. The three manifests differ from the
  base by npm scripts only.
- **One behaviour is removed**, and it is the only breaking change: a chat answer can no longer
  be saved into the vault. Reading the vault and writing it are separate paths now, and only a
  run writes. The button, the route and the runner behind it are gone, and a test asserts the
  route is unreachable so the older wording cannot bring it back.
- **Four tracked files were renamed so the repo can be cloned on Windows.** They carried a
  character a file name cannot hold there. The rename follows the code: the prefix that minted
  them lost its colon for the same reason.

**Specified, not just shipped.** `SPEC.md` gains five sections: the service-owned hub layer, page
freshness, what `.raw/` puts into vault git, the form of an open question, and the standing defect
list. Hard rule 1 gains the tenth writer of vault content, and a column saying which writers take
the per-file lock themselves and which ride a caller's, because the grep the rule cited proved
less than it claimed.

**Measured before opening.** `npm test` (2,569), typecheck, lint and build all exit 0 and CI is
green. All three probes were run by hand: the permission probe reports both canaries blocked, and
by two different mechanisms, which is what the hard rules claim and only a live run can show; the
preprocessing jail holds across fourteen checks; and the vault contract probe, new here, reports
that all four texts the service parses and the vault owns still read as parsed.

**The private-content audit is in the task file, decisions included.** The scanner gained the
ability to see percent-encoded text, which had been hiding a page name in plain sight, and one
design record was reformulated to state a finding rather than quote the page it was about.

**Size.** 96 commits, 222 files, about 23.5k lines added and 600 removed. The commit messages are
the design record, so this is a merge commit rather than a squash.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
