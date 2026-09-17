# Screenshots

Every image under `docs/img/` is shot from a **synthetic vault**, so nothing private is published
and the set can be re-shot whenever the UI changes.

```bash
# 1. Build a throwaway vault (~900 pages over 18 domains, backdated git history)
node scripts/demo-vault.mjs

# 2. Serve it on a spare port. TELEGRAM_BOT_TOKEN= is REQUIRED: without it this process picks the
#    real token out of the env file and knocks the real bot off it (one poller per token).
#    WATCH_FOLDER matters too: the default is the real inbox, and two services watching one folder
#    race for whatever lands in it. AGENTS_ENABLED=1 because half the screens are the Fellows'.
cd server && VAULT_ROOT=~/.local/share/vault-service/demo-vault \
  DB_PATH=~/.local/share/vault-service/demo-jobs.db PORT=8422 \
  AGENTS_ENABLED=1 WATCH_FOLDER=/tmp/demo-inbox \
  CLAUDE_CODE_OAUTH_TOKEN=demo-not-a-real-token TELEGRAM_BOT_TOKEN= \
  node dist/main.js &

# 3. A headless browser with a debugging port, which the shooter attaches to
~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome --headless --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/shoot-profile about:blank &

# 4. Shoot the screens at 2x into docs/img/ (fourteen; BASE_URL must match the port).
#    ONLY=home.png re-shoots a single one.
BASE_URL=http://127.0.0.1:8422 node --experimental-websocket scripts/shoot-screens.mjs
```

Each shot waits on a `settle` condition in the page rather than on the network, because the
dashboard holds an SSE connection open forever. Those conditions name CSS classes, so they rot when
the markup moves: if a shot warns that it never settled, check the selector before reaching for a
longer hold.

**Without a build.** The Vite dev server serves the same app over the same API without touching
`web/dist` (rebuilding `web/dist` blanks every running service that serves it): run
`node_modules/.bin/vite --config <a config with root: web and a proxy to the demo port>` and point
`BASE_URL` at it. That is how the room images were re-shot on 2026-09-17.

The generator invents everything it writes, with **one deliberate exception**: the research runs are
real. Four were run against this demo vault, cost real money and searched the actual web, and
`scripts/capture-research-run.mjs` froze each into `scripts/demo-research/` so the generator can
restore it. A synthesis page is what the research function produces, and an invented one shows a
shape where the real one shows an argument. Those pages name real papers, patents and companies, all
public, none from anyone's private notes.

The vault is deliberately neither small nor tidy: ~900 pages, ~4,500 links, one domain far deeper
than the rest, stubs and gaps left in, pages dated in reading order rather than build order. Subject
matter lives in `scripts/demo-vault-topics.mjs`. Stop the demo process by PID when you are done - a
`pkill` on the binary name would take the real service with it.

`scripts/probe-screens.mjs` uses the same headless browser to open every screen and report what
came up, which is the check a green build cannot make: a shared component that always returned an
element once blanked every screen while every gate stayed green.
