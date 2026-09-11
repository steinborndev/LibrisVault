import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client.ts'
import { useEvents } from './hooks/useEvents.ts'
import { useMaintenanceStatus } from './hooks/useMaintenanceStatus.ts'
import { useActiveRuns } from './hooks/useActiveRuns.ts'
import { StatusPopover } from './components/StatusPopover.tsx'
import { HoverTip } from './components/Tip.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { GlobalDrop } from './components/GlobalDrop.tsx'
import { DemoNotice } from './components/DemoNotice.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { Home } from './tabs/Home.tsx'
import { Chat } from './tabs/Chat.tsx'
import { Recap } from './tabs/Recap.tsx'
import { Icon, type IconName } from './components/Icon.tsx'
import { usePath, navigate, pageFromPath } from './lib/router.ts'
import { RUN_RUNNING_TITLES, isMaintenanceRun } from './lib/runLabels.ts'

/*
 * Code-split. The vault viewer pulls in d3-force and the canvas machinery; System carries the
 * whole maintenance console; the Library carries its isometric room; the Catalog its table.
 * None of them is on the first paint - Home is - and none is where the work happens, which is
 * why Research stays in the main chunk.
 *
 * `lazy` defers the MODULE, not the mount: once a screen has been visited its section stays
 * in the tree and keeps its state, which is the shell's whole contract (see the `hidden`
 * sections below). The cost is that an unvisited screen does not poll, which is a saving.
 */
const Vault = lazy(() => import('./tabs/Vault.tsx').then((m) => ({ default: m.Vault })))
const System = lazy(() => import('./tabs/System.tsx').then((m) => ({ default: m.System })))
const Catalog = lazy(() => import('./tabs/Catalog.tsx').then((m) => ({ default: m.Catalog })))
const LibraryScreen = lazy(() => import('./tabs/LibraryScreen.tsx').then((m) => ({ default: m.LibraryScreen })))

/**
 * Screens of the shell (redesign 2026-08-25, second pass). Five, down from seven: the Inbox
 * folded into Home (same table, plus intake and the filters that drive it), and Health +
 * Settings merged into System. `vault` hosts both the graph and the page view (shared state).
 */
type ScreenId = 'home' | 'research' | 'vault' | 'catalog' | 'library' | 'system'

interface TabItem {
  id: ScreenId
  label: string
  icon: IconName
  route: string
}

/**
 * Navigation lives in the header row now, as browser-style tabs. It used to be a 216px
 * sidebar while the header spent a whole row naming the screen you were already on; five
 * entries fit across the top, and every workspace gets that width back.
 *
 * Order follows the day: what arrived (Home), what you go and find out (Research), then the
 * two ways of browsing what is there, then the machine room.
 */
const TABS: TabItem[] = [
  { id: 'home', label: 'Home', icon: 'home', route: '/' },
  { id: 'research', label: 'Research', icon: 'flask', route: '/research' },
  // The Library sits right after Research and before the two screens it now contains: a
  // shelf opens the graph and the catalog of its department without leaving the room.
  { id: 'library', label: 'Library', icon: 'library', route: '/library' },
  { id: 'vault', label: 'Graph', icon: 'graph', route: '/graph' },
  { id: 'catalog', label: 'Catalog', icon: 'book', route: '/catalog' },
  { id: 'system', label: 'System', icon: 'gear', route: '/system' },
]

/** Which screen a path belongs to (the vault screen owns /graph and /page/…). */
function screenForPath(path: string): ScreenId {
  const pathname = path.split('?')[0]!
  if (pathname.startsWith('/page/') || pathname.startsWith('/graph') || pathname.startsWith('/vault')) return 'vault'
  if (pathname.startsWith('/catalog')) return 'catalog'
  if (pathname.startsWith('/library')) return 'library'
  // `/chat` is the pre-rename route, `/research` the current one.
  if (pathname.startsWith('/research') || pathname.startsWith('/chat')) return 'research'
  if (
    pathname.startsWith('/system') ||
    pathname.startsWith('/health') ||
    pathname.startsWith('/maintenance') ||
    pathname.startsWith('/wartung') ||
    pathname.startsWith('/settings')
  ) {
    return 'system'
  }
  return 'home'
}

/**
 * Old route prefix → its current name; normalized via replaceState so the address bar and
 * history stay clean. Suffixes (page paths, ?filter=) ride along - `/inbox?filter=failed`
 * becomes `/?filter=failed`, which Home applies exactly as the Inbox did.
 */
const LEGACY_ROUTES: Array<[string, string]> = [
  ['/vault/page/', '/page/'],
  ['/vault', '/graph'],
  ['/ingestion', '/'],
  ['/inbox', '/'],
  ['/wartung', '/system'],
  ['/maintenance', '/system'],
  ['/health', '/system'],
  ['/settings', '/system'],
  ['/chat', '/research'],
]

/** Legacy `/library?domain=` (the table view before the rename) is a Catalog filter. */
const LEGACY_LIBRARY_FILTER = /^\/library\?domain=/

export function App(): React.ReactElement {
  const path = usePath()
  const screen = screenForPath(path)
  // One SSE connection for the whole app; drives live invalidation + the connection dot.
  const { connected } = useEvents()

  // Outstanding work for the Home badge - a running ingest is otherwise invisible from
  // every other screen. Rides the shared ['stats'] query (SSE keeps it fresh).
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const queued = (stats.data?.queue.active ?? 0) + (stats.data?.queue.queued ?? 0)
  const vaultName = stats.data?.vaultName ?? 'vault'

  // Agent runs in flight, server-side truth. Ingests are only half the work the service
  // does; a research run was previously invisible from every screen but the one that
  // started it, and vanished from that one on reload.
  const runs = useActiveRuns()
  const researchRunning = runs.countOf('research')

  // Home counts everything in flight, the same way its own "In flight" tile does - the tile
  // counted agent runs while the badge beside it counted only the ingest queue, so a running
  // backfill made the two disagree on the same screen.
  const outstanding = queued + runs.running.length
  const running = (stats.data?.queue.active ?? 0) > 0 || runs.running.length > 0

  // The machine room's runs - see `isMaintenanceRun` for why the split is exhaustive.
  const maintenanceRuns = runs.running.filter((r) => isMaintenanceRun(r.kind))

  // System badge: due/recommended from the deterministic status model (shared queries).
  const maint = useMaintenanceStatus()
  const healthDue = maint.data?.status.due ?? 0
  const healthRec = maint.data?.status.recommended ?? 0

  // First-run setup mode: the server runs without a credential and every agent feature is
  // off - surface that on every screen, with the path to fix it (System → Integrations).
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 })
  // The third intake channel. It only earns a pill while it is actually connected - "no
  // bot" is a settings fact, not a header one.
  const telegram = useQuery({ queryKey: ['telegram-status'], queryFn: api.telegramStatus, staleTime: 300_000 })
  const demoMode = health.data?.demoMode === true
  // A demo instance intentionally runs without a credential - that is its normal state,
  // not an onboarding gap, so demo wins over the setup banner.
  const setupMode = !demoMode && (health.data ? !health.data.credentialConfigured : false)
  // Both header chips show their channel's state rather than hiding when it is off: a
  // Telegram chip that vanishes when no bot is configured cannot tell you that none is.
  const watcherActive = stats.data?.watcher.active === true
  const telegramOn = telegram.data?.configured === true

  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Screens stay MOUNTED and are hidden via [hidden] - unmounting threw away the graph
  // camera, the active chat session, filters and scroll positions on every switch.
  // The vault screen keeps its last inner route while other screens own the URL; null
  // until first visited, so the lazy chunk still loads on demand.
  const [vaultPath, setVaultPath] = useState<string | null>(() => (screen === 'vault' ? path : null))
  useEffect(() => {
    if (screen === 'vault') setVaultPath(path)
  }, [screen, path])

  // Normalize legacy routes so the address bar and history show the current ones.
  useEffect(() => {
    const pathname = path.split('?')[0]!
    if (LEGACY_LIBRARY_FILTER.test(path)) {
      navigate(`/catalog${path.slice('/library'.length)}`, { replace: true })
      return
    }
    const legacy = LEGACY_ROUTES.find(([old]) => pathname.startsWith(old))
    if (legacy) {
      const [oldPrefix, newPrefix] = legacy
      navigate(newPrefix + path.slice(oldPrefix.length), { replace: true })
    }
  }, [path])

  const openPage = pageFromPath(path.split('?')[0]!)
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  /*
   * Leaving the Library for the Graph keeps the department you were looking at. A shelf is a
   * domain, and the graph reads `?domain=` as its filter, so the tab carries the shelf across
   * rather than dropping you into the whole vault and making you find it again.
   */
  const openShelf = screen === 'library' ? (query.get('shelf') ?? '') : ''
  const routeFor = (tab: TabItem): string => (tab.id === 'vault' && openShelf !== '' ? `/graph?domain=${encodeURIComponent(openShelf)}` : tab.route)

  // The recap lives under Home (`/recap`, `/recap/<date>`); Home stays mounted behind it.
  const pathname = path.split('?')[0]!
  const recapOpen = pathname === '/recap' || pathname.startsWith('/recap/')
  const recapDate = recapOpen ? decodeURIComponent(pathname.slice('/recap/'.length)) : ''
  const [recapMounted, setRecapMounted] = useState(recapOpen)
  useEffect(() => {
    if (recapOpen) setRecapMounted(true)
  }, [recapOpen])
  /*
   * The code-split screens mount on their FIRST visit and stay mounted after it. Both halves
   * matter: without the gate a lazy screen's module is fetched during the first render and
   * the split buys nothing, and without the staying-mounted half a screen would lose its
   * state on every switch, which is the shell's contract (the sections are `hidden`, not
   * unmounted). The Library also polls the scene while mounted, so not mounting it until it
   * is wanted is a saving of its own.
   */
  const [visited, setVisited] = useState<ReadonlySet<ScreenId>>(() => new Set([screen]))
  useEffect(() => {
    setVisited((seen) => (seen.has(screen) ? seen : new Set([...seen, screen])))
  }, [screen])
  const libraryMounted = visited.has('library')

  // The value signal (docs/agents/SPEC.md section 9.6): a page opened counts for the Fellow
  // that wrote it. Only on an instance with Fellows; the server attributes the page.
  const fellowsOn = health.data?.fellows === true
  useEffect(() => {
    if (openPage !== null && fellowsOn) api.valueEvent({ kind: 'page_open', page: openPage })
  }, [openPage, fellowsOn])

  const badgeFor = (id: ScreenId): React.ReactElement | null => {
    if (id === 'home' && outstanding > 0) {
      return (
        <span className="tab-badge" aria-label={`${outstanding} in flight`}>
          {running && <span className="pulse" aria-hidden />}
          {outstanding}
        </span>
      )
    }
    if (id === 'research' && researchRunning > 0) {
      return (
        <span
          className="tab-badge research"
          aria-label={`${researchRunning} research run${researchRunning > 1 ? 's' : ''} active`}
        >
          <span className="pulse" aria-hidden />
          {researchRunning}
        </span>
      )
    }
    // A run in flight outranks the due count: one badge says one thing at a time, and what
    // is happening now is the more urgent of the two. The due items are still due afterwards.
    if (id === 'system' && maintenanceRuns.length > 0) {
      const names = maintenanceRuns.map((r) => RUN_RUNNING_TITLES[r.kind] ?? r.kind)
      return (
        <span className="tab-badge" aria-label={names.join(', ')} title={names.join(' · ')}>
          <span className="pulse" aria-hidden />
          {maintenanceRuns.length}
        </span>
      )
    }
    if (id === 'system' && healthDue + healthRec > 0) {
      return (
        <span
          className={`tab-badge${healthDue > 0 ? ' due' : ''}`}
          aria-label={`${healthDue + healthRec} maintenance items open`}
        >
          {healthDue > 0 ? healthDue : healthRec}
        </span>
      )
    }
    return null
  }

  return (
    <div className="app">
      <div className="main">
        <header className="topbar">
          {/* No brand mark here for now - a rebranding is pending, and the Home tab is the
              way home in the meantime. */}
          {/* Navigation, not a tab widget: each entry is a route, and the screens are not
              tabpanels - so `aria-current`, the same contract the sidebar had. */}
          <nav className="tabs" aria-label="Primary">
            {TABS.filter((tab) => tab.id !== 'library' || fellowsOn).map((tab) => (
              <button
                key={tab.id}
                className="tab"
                aria-current={screen === tab.id ? 'page' : undefined}
                onClick={() => navigate(routeFor(tab))}
              >
                <Icon name={tab.icon} />
                {tab.label}
                {badgeFor(tab.id)}
              </button>
            ))}
          </nav>
          {/* Three status chips of one shape (2026-08-26): a dot that carries the state and
              a noun that names the channel. "Watcher active" said its state twice - once in
              the dot, once in the word - and the page count was not a status at all, just a
              figure that already leads the Home screen. What each chip means is one hover
              away, which is where the detail belongs. */}
          <div className="topright">
            <HoverTip
              className="tstat"
              label={`Watch folder ${watcherActive ? 'active' : 'inactive'}`}
              text={
                stats.data === undefined ? (
                  'Waiting for the service to report on the watch folder.'
                ) : watcherActive ? (
                  <>
                    Watching <code>{stats.data.watcher.folder}</code>. Anything dropped in there is
                    ingested on its own, with nothing else to do.
                  </>
                ) : (
                  <>
                    Not watching. Files left in <code>{stats.data.watcher.folder}</code> stay where
                    they are until the watcher runs again.
                  </>
                )
              }
            >
              <span className={`d ${watcherActive ? 'ok' : 'warn'}`} />
              Watcher
            </HoverTip>
            <HoverTip
              className="tstat"
              label={`Telegram ${telegramOn ? 'connected' : 'not configured'}`}
              text={
                telegramOn
                  ? 'The bot is connected and accepting messages. Anything you send it - a link, a file, a note - is queued for ingest like a drop.'
                  : 'No bot configured, so nothing arrives this way. Set one up under System → Integrations.'
              }
            >
              <span className={`d ${telegramOn ? 'ok' : ''}`} />
              Telegram
            </HoverTip>
            <StatusPopover connected={connected} />
          </div>
        </header>

        {setupMode && (
          <div className="setup-banner" role="status">
            <strong>Almost there:</strong>&nbsp;no Anthropic credential configured yet - ingestion,
            research and maintenance are paused.
            <button className="btn primary" onClick={() => navigate('/system?section=integrations')}>
              Set up now
            </button>
          </div>
        )}
        {demoMode && (
          <div className="setup-banner" role="status">
            <strong>Read-only demo:</strong>&nbsp;browse the vault freely - ingestion, research and
            system actions are switched off in this hosted instance.
          </div>
        )}

        <div className="screens">
          {/* Every screen is the same workspace shape now: one control column, one content
              box, no bar spanning both - so switching screens never shifts the edges. */}
          <section className="screen flush" hidden={screen !== 'home' || recapOpen} aria-label="Home">
            <div className="lane wide">
              <ErrorBoundary label="Home">
                <Home statusFilter={screen === 'home' ? (query.get('filter') ?? '') : ''} active={screen === 'home' && !recapOpen} />
              </ErrorBoundary>
            </div>
          </section>
          <section className="screen" hidden={!recapOpen} aria-label="Recap">
            <div className="lane wide">
              {recapMounted && (
                <ErrorBoundary label="Recap">
                  <Recap date={recapDate} />
                </ErrorBoundary>
              )}
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'research'} aria-label="Research">
            <div className="lane wide">
              <ErrorBoundary label="Research">
                {demoMode ? (
                  <DemoNotice
                    title="Research is switched off here"
                    text="Research drives live agent sessions over the vault and the web - answering questions with citations, saving sessions as pages."
                  />
                ) : (
                  <Chat researchPrefill={screen === 'research' ? (query.get('prefill') ?? '') : ''} />
                )}
              </ErrorBoundary>
            </div>
          </section>
          {/* The vault screen hosts two very different things. The graph is a workspace: it
              fills the viewport and scrolls inside its own panels, so it takes `flush`. An
              article is a document and scrolls normally, so it does not. */}
          <section
            /*
             * `flush` for the graph, `reading` for an open page: the reader bounds itself to
             * the viewport like the Library's drawing area and scrolls inside its own two
             * columns, so the screen must not scroll underneath it as well.
             */
            className={`screen${screen === 'vault' ? (openPage === null ? ' flush' : ' reading') : ''}`}
            hidden={screen !== 'vault'}
            aria-label="Vault"
          >
            <div className="lane wide">
              {/* The boundary sits ABOVE the Suspense on purpose: the lazy chunk failing to
                  load throws during render, and Suspense only ever handles pending. */}
              {vaultPath !== null && (
                <ErrorBoundary label="Graph">
                  <Suspense fallback={<div className="empty">Loading vault view…</div>}>
                    <Vault path={vaultPath} active={screen === 'vault'} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'catalog'} aria-label="Catalog">
            <div className="lane wide">
              {visited.has('catalog') && (
                <ErrorBoundary label="Catalog">
                  <Suspense fallback={<div className="empty">Loading catalog…</div>}>
                    <Catalog
                      vaultName={vaultName}
                      domainParam={screen === 'catalog' ? (query.get('domain') ?? '') : ''}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'library'} aria-label="Library">
            <div className="lane wide">
              {libraryMounted && (
                <ErrorBoundary label="Library">
                  <Suspense fallback={<div className="empty">Loading library…</div>}>
                  <LibraryScreen vaultName={vaultName} active={screen === 'library'} agentParam={screen === 'library' ? (query.get('agent') ?? '') : ''} roomParam={screen === 'library' ? (query.get('room') ?? '') : ''} spawnParam={screen === 'library' ? (query.get('spawn') ?? '') : ''} shelfParam={screen === 'library' ? (query.get('shelf') ?? '') : ''} paneParam={screen === 'library' ? (query.get('pane') ?? '') : ''} pageParam={screen === 'library' ? (query.get('page') ?? '') : ''} boardParam={screen === 'library' ? (query.get('board') ?? '') : ''} ccParam={screen === 'library' ? (query.get('cc') ?? '') : ''} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          </section>
          <section className="screen flush" hidden={screen !== 'system'} aria-label="System">
            <div className="lane wide">
              {visited.has('system') && (
                <ErrorBoundary label="System">
                  {demoMode ? (
                    <DemoNotice
                      title="System is switched off here"
                      text="System hosts operations: the ingest queue, maintenance runs, integrations, and settings."
                    />
                  ) : (
                    <Suspense fallback={<div className="empty">Loading system…</div>}>
                      <System section={screen === 'system' ? (query.get('section') ?? '') : ''} />
                    </Suspense>
                  )}
                </ErrorBoundary>
              )}
            </div>
          </section>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {!demoMode && <GlobalDrop />}
    </div>
  )
}
