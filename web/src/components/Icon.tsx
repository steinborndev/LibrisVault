/** Inline SVG icon set - no icon-font dependency, theme-inheriting via `currentColor`. */

export type IconName =
  | 'logo'
  | 'grid'
  | 'inbox'
  | 'chat'
  | 'wrench'
  | 'file'
  | 'link'
  | 'copy'
  | 'retry'
  | 'x'
  | 'trash'
  | 'check'
  | 'search'
  | 'library'
  | 'moon'
  | 'sun'
  | 'graph'
  | 'gap'
  | 'cluster'
  | 'network'
  | 'spotlight'
  | 'back'
  | 'upload'
  | 'edit'
  | 'palette'
  | 'home'
  | 'book'
  | 'gear'
  | 'health'
  | 'flask'
  | 'play'
  | 'commit'
  | 'chevron'
  | 'plus'
  | 'clock'
  | 'keyboard'
  | 'bolt'
  | 'expand'
  | 'shrink'
  | 'globe'
  | 'image'
  | 'archive'
  | 'lens-broad'
  | 'lens-sota'
  | 'lens-patents'
  | 'lens-startups'

const PATHS: Record<Exclude<IconName, 'logo'>, React.ReactNode> = {
  expand: (
    <>
      <path d="M12 3.5h4.5V8" />
      <path d="M8 16.5H3.5V12" />
      <path d="M16.5 3.5 11.5 8.5" />
      <path d="M3.5 16.5l5-5" />
    </>
  ),
  shrink: (
    <>
      <path d="M16.5 8H12V3.5" />
      <path d="M3.5 12H8v4.5" />
      <path d="M11.5 8.5l5-5" />
      <path d="M8.5 11.5l-5 5" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.9-4.6A8 8 0 1 1 21 12z" />,
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.3-.6-.6-2.3z" />
  ),
  file: (
    <>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </>
  ),
  // An ingested photo or scan, in the Library's source column.
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17 4.7-4.3 3.4 3.1 3-2.6 3.9 3.4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  retry: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </>
  ),
  // Web egress, on the research console's capability chip.
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.4-3.6-8.5S9.6 6 12 3.5z" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.2 7l7.4 0.7M7 8.2l1.4 7.4M16.4 10l-5.8 6.3" />
    </>
  ),
  // A real page linking into a dashed, not-yet-written one - the ghost-node treatment itself.
  gap: (
    <>
      <circle cx="6.5" cy="6.5" r="2.5" />
      <path d="M8.5 8.5l3.2 3.2" />
      <circle cx="15" cy="15" r="5" strokeDasharray="2.6 2.6" />
    </>
  ),
  // Member dots inside a tinted hull outline - the cluster overlay in miniature.
  cluster: (
    <>
      <ellipse cx="12" cy="12" rx="8.5" ry="6" />
      <circle cx="8.5" cy="11" r="1.4" />
      <circle cx="13.5" cy="14.2" r="1.4" />
      <circle cx="15" cy="9.5" r="1.4" />
    </>
  ),
  // Two nodes with the directed bridge between them - the network lens's arrowed edge.
  network: (
    <>
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="5.5" r="2.5" />
      <path d="M7.4 16.6L15 9M15 9h-3.4M15 9v3.4" />
    </>
  ),
  // A radiating node: the hover glow that lights a community up.
  spotlight: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.7 1.7M16.3 16.3L18 18M18 6l-1.7 1.7M7.7 16.3L6 18" />
    </>
  ),
  back: <path d="M15 4l-8 8 8 8" />,
  /*
   * One mark per research lens. They stand where the run count used to in the picker, and
   * they lead every row of the run list - so the picker doubles as the legend, and a list of
   * mixed lenses reads as groups without a column of its own. Each is that lens's own
   * instrument rather than a generic glyph.
   */
  // A sweep: the full circle with the hand mid-turn.
  'lens-broad': (
    <>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 12l6.4-4.6" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  // The frontier: a line of work rising to the point it has reached.
  'lens-sota': (
    <>
      <path d="M3 17.5l5.2-5.2 3.4 2.6L18 7" />
      <circle cx="18.6" cy="6.6" r="2.1" />
    </>
  ),
  // A filing with a seal on it.
  'lens-patents': (
    <>
      <path d="M6.5 3h7l4 4v14h-11z" />
      <path d="M13.5 3v4h4" />
      <circle cx="12" cy="13.6" r="2.3" />
      <path d="M10.7 15.6V19l1.3-1 1.3 1v-3.4" />
    </>
  ),
  // Funding: a stack that grows.
  'lens-startups': (
    <>
      <ellipse cx="12" cy="6.5" rx="6.3" ry="2.5" />
      <path d="M5.7 6.5v5c0 1.4 2.8 2.5 6.3 2.5s6.3-1.1 6.3-2.5v-5" />
      <path d="M5.7 11.5v5c0 1.4 2.8 2.5 6.3 2.5s6.3-1.1 6.3-2.5v-5" />
    </>
  ),
  // A lidded box: put away, not thrown away.
  archive: (
    <>
      <path d="M3 7h18v3H3z" />
      <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" />
      <path d="M10 14h4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20l4-1L20 7l-3-3L5 16z" />
      <path d="M14 6l3 3" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 1.5-3.6 2.1 2.1 0 0 1 1.5-3.6H19a3 3 0 0 0 3-3.2C21.7 6.3 17.3 3 12 3z" />
      <circle cx="7.5" cy="11.5" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  home: (
    <>
      <path d="M3 10.5L12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
  // A hall with columns: the Library screen's rooms.
  library: (
    <>
      <path d="M3 21h18" />
      <path d="M4 21V9M9 21V9M15 21V9M20 21V9" />
      <path d="M2 9l10-6 10 6" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  // Two facing book halves - the library's paired shelves.
  book: (
    <>
      <path d="M4 4h7v16H4z" />
      <path d="M13 4h7v16h-7z" />
      <path d="M6.5 8h2M6.5 11h2M15.5 8h2M15.5 11h2" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" />
    </>
  ),
  // A pulse line - the vault's vitals, not a wrench.
  health: <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />,
  flask: (
    <>
      <path d="M10 3v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3" />
      <path d="M8 3h8" />
      <path d="M7.5 15h9" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" />,
  // A commit on its line - one revertable point in history.
  commit: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v6M12 15.5v6" />
    </>
  ),
  chevron: <path d="M7 10l5 5 5-5" />,
  plus: <path d="M12 6v12M6 12h12" />,
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.5l3.5 2" />
    </>
  ),
  bolt: <path d="M13 2L4 14h6l-1 8 9-12h-6z" />,
}

export function Icon({ name }: { name: IconName }): React.ReactElement {
  if (name === 'logo') {
    return (
      // The mark: two facing brackets (the [[wikilink]] hemispheres) enclosing the knowledge
      // graph the service builds. Strokes are tuned for ~28px in the topbar; the small-size
      // cut with heavier strokes lives in public/favicon.svg.
      // Redesign: the mark wears the brand gold; the graph inside inks in the ground color.
      <svg viewBox="0 0 64 64" width="1em" height="1em" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="var(--gold)" />
        <g fill="none" stroke="var(--bg)" strokeWidth="3.8" strokeLinecap="round">
          <path d="M28 18A14 14 0 0 0 28 46" />
          <path d="M36 18A14 14 0 0 1 36 46" />
        </g>
        <g fill="none" stroke="var(--bg)" strokeWidth="2.8" strokeLinecap="round">
          <path d="M32 32.5 27.5 27M32 32.5 37 26.8M32 32.5 27 38M32 32.5 37 37.6" />
        </g>
        <g fill="var(--bg)">
          <circle cx="32" cy="32.5" r="3.9" />
          <circle cx="27.5" cy="27" r="2.8" />
          <circle cx="37" cy="26.8" r="2.8" />
          <circle cx="27" cy="38" r="2.8" />
          <circle cx="37" cy="37.6" r="2.8" />
        </g>
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.file}
    </svg>
  )
}
