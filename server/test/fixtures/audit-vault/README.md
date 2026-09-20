# audit-vault fixture

A hand-built vault with one planted instance of every defect class `scripts/vault-audit.mjs`
measures, so the harness can be tested without the real vault (which is private, 1247 pages and
changes under the tests' feet).

Planted, one each: a title the file name cannot carry (colon), a link into a directory that does
not exist (slash), a line-wrap backslash, a genuinely missing page, a page that mirrors its own
type in its tags, a page that mirrors its domain, a page missing from the address map, a map
entry pointing at a deleted page, a map entry that disagrees with the page, a duplicate address,
a `.raw` job directory named in no source, and a `pages_created` entry for a page that is gone.

Every name in here is invented. Nothing from the real vault may be copied into it (hard rule 7).
