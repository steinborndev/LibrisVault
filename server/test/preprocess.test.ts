import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { preprocess, PreprocessError, type ToolAvailability } from '../src/pipeline/preprocess/index.js'
import { assertNotExecutable, isPdf, isZip, isPng } from '../src/pipeline/preprocess/detect.js'
import { exceedsOcrLimits, ocrTimeoutMs } from '../src/pipeline/preprocess/plugins/pdf.js'
import { bwrapArgs, toolPrefix, sandboxRequired } from '../src/pipeline/preprocess/sandbox.js'

const NO_TOOLS: ToolAvailability = {
  pdftotext: false,
  pdfinfo: false,
  ocrmypdf: false,
  pandoc: false,
  python3: false,
  exiftool: false,
  defuddle: false,
  ytDlp: false,
  deno: false,
}

let vaultRoot: string

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
})
afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true })
})

/** Writes a source file into .raw/<jobId>/ and returns the preprocess input. */
function stage(jobId: string, name: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const jobDir = path.join(vaultRoot, '.raw', jobId)
  fs.mkdirSync(jobDir, { recursive: true })
  const sourcePath = path.join(jobDir, name)
  fs.writeFileSync(sourcePath, bytes)
  return {
    jobId,
    source: 'drop' as const,
    sourcePath,
    originalName: name,
    vaultRoot,
    jobDir,
    tools: NO_TOOLS,
    ...overrides,
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PDF_MAGIC = Buffer.from('%PDF-1.7\n')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])

describe('detect predicates', () => {
  it('recognises magic bytes', () => {
    expect(isPdf(PDF_MAGIC)).toBe(true)
    expect(isZip(ZIP_MAGIC)).toBe(true)
    expect(isPng(PNG_MAGIC)).toBe(true)
    expect(isPdf(PNG_MAGIC)).toBe(false)
  })

  it('refuses executables regardless of extension', () => {
    expect(() => assertNotExecutable(ELF_MAGIC, 'report.pdf')).toThrow(PreprocessError)
    expect(() => assertNotExecutable(Buffer.from([0x4d, 0x5a]), 'invoice.docx')).toThrow(/executable/i)
    expect(() => assertNotExecutable(PDF_MAGIC, 'x.pdf')).not.toThrow()
  })
})

describe('preprocess chain', () => {
  it('passes markdown through and writes a manifest', async () => {
    const r = await preprocess(stage('j1', 'note.md', Buffer.from('# Hello\nbody')))
    expect(r.type).toBe('text')
    expect(r.deferred).toBe(false)
    expect(r.primaryArtifact).toBe('.raw/j1/note.md')
    expect(r.manifest.normalized).toBeUndefined()
    const written = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'))
    expect(written.type).toBe('text')
    expect(written.original).toBe('note.md')
    expect(written.notes.join(' ')).toMatch(/passthrough/)
  })

  it('extracts a saved web page to markdown and names the address the page gives itself', async () => {
    // The way through a site that refuses automated fetches: the page saved from the browser
    // is the HTML a URL job would have fetched, so it gets the same extraction (here the
    // built-in fallback, defuddle being absent) instead of passing through as text.
    const body = 'Harnesses matter more than models. '.repeat(12)
    const html = `<!doctype html><html><head><title>An article</title>
      <link href="https://publisher.example/posts/an-article" rel="canonical">
      <meta property="og:url" content="https://publisher.example/posts/an-article?utm=x">
      <script>window.app = {}</script><style>.x{}</style></head>
      <body><nav>menu</nav><article><h1>An article</h1><p>${body}</p></article></body></html>`
    const r = await preprocess(stage('j1', 'An article _ Publisher.htm', Buffer.from(html)))
    expect(r.type).toBe('text')
    expect(r.primaryArtifact).toBe('.raw/j1/normalized.md')
    expect(r.manifest.normalized).toBe('normalized.md')
    expect(r.manifest.url).toBe('https://publisher.example/posts/an-article')
    expect(r.manifest.notes.join(' ')).toMatch(/saved web page/)
    const normalized = fs.readFileSync(path.join(vaultRoot, r.primaryArtifact), 'utf8')
    expect(normalized).toContain('Saved from: https://publisher.example/posts/an-article')
    expect(normalized).toContain('Harnesses matter more than models.')
    expect(normalized).not.toMatch(/<(div|script|style|nav)\b/)
  })

  it('passes a saved page through when its extraction is junk, rather than failing it', async () => {
    const r = await preprocess(stage('j1', 'shell.html', Buffer.from('<html><body><div id="app"></div></body></html>')))
    expect(r.type).toBe('text')
    expect(r.primaryArtifact).toBe('.raw/j1/shell.html')
    expect(r.manifest.normalized).toBeUndefined()
    expect(r.manifest.notes.join(' ')).toMatch(/junk/)
  })

  it('defers audio/video', async () => {
    const r = await preprocess(stage('j2', 'talk.mp3', Buffer.from('ID3 fake')))
    expect(r.type).toBe('av')
    expect(r.deferred).toBe(true)
    expect(r.manifest.deferred).toBe(true)
  })

  it('defers archives without extracting them', async () => {
    const r = await preprocess(stage('j3', 'bundle.zip', ZIP_MAGIC))
    expect(r.type).toBe('other')
    expect(r.deferred).toBe(true)
    expect(r.manifest.notes.join(' ')).toMatch(/not auto-extracted/)
  })

  it('routes images to the agent with no local OCR', async () => {
    const r = await preprocess(stage('j4', 'shot.png', PNG_MAGIC))
    expect(r.type).toBe('image')
    expect(r.manifest.passImageToAgent).toBe(true)
    expect(r.primaryArtifact).toBe('.raw/j4/shot.png') // original, not a text extraction
    expect(r.manifest.notes.join(' ')).toMatch(/exiftool not installed/)
  })

  it('refuses a disguised executable before any plugin runs', async () => {
    await expect(preprocess(stage('j5', 'report.pdf', ELF_MAGIC))).rejects.toThrow(/hard rule 6/)
  })

  it('fails a PDF when pdftotext is missing (required tool, not passthrough)', async () => {
    await expect(preprocess(stage('j6', 'paper.pdf', PDF_MAGIC))).rejects.toThrow(/pdftotext/)
  })

  it('fails an xlsx when python3 is missing', async () => {
    await expect(preprocess(stage('j7', 'data.xlsx', ZIP_MAGIC))).rejects.toThrow(/python3/)
  })

  it('carries sha256 and source into the manifest', async () => {
    const r = await preprocess(stage('j8', 'note.txt', Buffer.from('x'), { sha256: 'abc123' }))
    expect(r.manifest.sha256).toBe('abc123')
    expect(r.manifest.source).toBe('drop')
  })

  it('routes a docx (zip magic + extension) to office, failing without pandoc', async () => {
    await expect(preprocess(stage('j9', 'letter.docx', ZIP_MAGIC))).rejects.toThrow(/pandoc/)
  })

  /*
   * EPub is a ZIP like the other containers and pandoc has always read it; only this set did
   * not name it. RTF is not a container, so it is gated on its own magic - which keeps the
   * rule "extension AND magic" and lets a misnamed file fall through to the passthrough.
   */
  it('routes an epub to office, like the other zip containers', async () => {
    await expect(preprocess(stage('j10', 'book.epub', ZIP_MAGIC))).rejects.toThrow(/pandoc/)
  })

  it('converts an rtf instead of handing an agent its control codes', async () => {
    const rtf = Buffer.from('{\\rtf1\\ansi\\deff0 hello}')
    await expect(preprocess(stage('j11', 'letter.rtf', rtf))).rejects.toThrow(/pandoc/)
  })

  it('leaves a file that only claims to be rtf to the text passthrough', async () => {
    const r = await preprocess(stage('j12', 'notes.rtf', Buffer.from('just prose, no magic')))
    expect(r.manifest.type).toBe('text')
  })
})

describe('OCR ceilings and timeout', () => {
  const MB = 1024 * 1024

  it('OCRs a mid-size textless PDF (within both limits)', () => {
    expect(exceedsOcrLimits(50, 20 * MB)).toBe(false)
    expect(exceedsOcrLimits(300, 100 * MB)).toBe(false) // exactly at the limits, still allowed
  })

  it('defers when either the page count OR the byte size is over the limit', () => {
    expect(exceedsOcrLimits(301, 1 * MB)).toBe(true) // too many pages
    expect(exceedsOcrLimits(10, 101 * MB)).toBe(true) // too large on disk
    expect(exceedsOcrLimits(851, 179 * MB)).toBe(true) // the job that motivated this
  })

  it('scales the OCR timeout with page count and clamps to the ceiling', () => {
    expect(ocrTimeoutMs(0)).toBe(60_000) // base only
    expect(ocrTimeoutMs(100)).toBe(60_000 + 100 * 3_000) // base + per-page
    expect(ocrTimeoutMs(300)).toBe(960_000) // full-size job, under the ceiling
    expect(ocrTimeoutMs(100_000)).toBe(20 * 60_000) // clamped
  })
})

/**
 * Containment for the converters (docs/agents/ideas.md, proposal 2026-09-07).
 *
 * The policy is read off the argument list rather than by spawning: what a jail binds, and what
 * it deliberately does not, is the whole of the guarantee, and a test that only checked "the
 * command ran" would pass with every bind removed.
 */
describe('the converter jail', () => {
  const spec = { reads: ['/tmp/in.pdf'], writes: '/tmp/job' }
  const args = bwrapArgs(spec, 'pdftotext', ['/tmp/in.pdf', '/tmp/job/out.txt'])
  const pairs = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []))

  it('gives the tool its input and its output directory, and nothing else of ours', () => {
    expect(pairs('--ro-bind')).toContain('/tmp/in.pdf')
    expect(pairs('--bind')).toEqual(['/tmp/job'])
    // The three things the old, uncontained call could reach.
    const bound = [...pairs('--ro-bind'), ...pairs('--bind')].join(' ')
    expect(bound).not.toContain('.config')
    expect(bound).not.toContain('vault')
    expect(bound).not.toContain(process.env['HOME'] ?? '~')
  })

  it('takes the network away, which is what puts our own API out of reach', () => {
    expect(args).toContain('--unshare-net')
    // A fetcher may ask for it; nothing else does, and it has to be explicit.
    expect(bwrapArgs({ ...spec, net: true }, 'yt-dlp', [])).not.toContain('--unshare-net')
  })

  it('clears the environment, so a credential in one does not ride along', () => {
    expect(args).toContain('--clearenv')
    expect(args).toContain('--die-with-parent')
    expect(args).toContain('--new-session')
  })

  it('separates its own flags from the tool, so an input named like a flag stays an input', () => {
    const at = args.indexOf('--')
    expect(at).toBeGreaterThan(0)
    expect(args.slice(at + 1)).toEqual(['pdftotext', '/tmp/in.pdf', '/tmp/job/out.txt'])
  })

  it('binds the runtime prefix of a tool that lives outside /usr, and only that', () => {
    // A pyenv shim or an npm global needs its interpreter; binding $HOME to reach it would
    // hand back exactly what the jail exists to remove.
    expect(toolPrefix('/usr/bin/pandoc')).toEqual([])
    expect(toolPrefix('/home/u/.pyenv/shims/python3')).toEqual(['/home/u/.pyenv'])
    // A symlinked npm bin needs the link AND its target; both live under the node version.
    expect(toolPrefix('/home/u/.nvm/versions/node/v20/bin/x')).toEqual(['/home/u/.nvm/versions/node/v20'])
  })

  it('refuses to convert uncontained unless that is asked for in so many words', () => {
    expect(sandboxRequired({})).toBe(true)
    expect(sandboxRequired({ PREPROCESS_SANDBOX: 'off' })).toBe(false)
    expect(sandboxRequired({ PREPROCESS_SANDBOX: 'require' })).toBe(true)
  })
})
