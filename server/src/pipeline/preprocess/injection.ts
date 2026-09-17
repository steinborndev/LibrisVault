/**
 * The injection tripwire (docs/sources/SPEC.md section 4.3).
 *
 * A short, deliberately dumb pattern list over the text of a document, in English and German:
 * instructions to ignore what came before, a role asserted at an assistant, a request to keep
 * something from the user, and "system prompt" inside an imperative sentence. A hit is a
 * WARNING in the job log and in the manifest, and the job runs on (D8).
 *
 * It is a tripwire, not a classifier. A page ABOUT prompt injection trips it, and that is the
 * right outcome: the reader of the log learns the document contains such text, which is true.
 * What it must never become is a gate that fails a job on a phrase, or a list so long that
 * nobody can say what it matches - the boundary is the sandbox and the hook, not this file.
 *
 * Kept in one module with its tests, so the list and its evidence stay together.
 */

/** How much of a hit is quoted in the warning. Enough to recognise, short enough for a log line. */
const QUOTE_CHARS = 80

/** How far into a document the scan reads. A document that says this says it early and often. */
const SCAN_CHARS = 400_000

interface Rule {
  /** What the pattern is about, in the warning. */
  readonly name: string
  readonly re: RegExp
}

/**
 * The four shapes, each in English and German. Every pattern is global and case-insensitive,
 * and each is written to match one SENTENCE shape rather than a keyword: "instructions" alone
 * is in every methods section, "ignore the instructions above" is not.
 */
const RULES: readonly Rule[] = [
  {
    name: 'overrides earlier instructions',
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|earlier|prior|above|preceding|other)\s+(?:instructions?|prompts?|rules?|directions?)/gi,
  },
  {
    name: 'overrides earlier instructions (German)',
    re: /\b(?:ignorier(?:e|en\s+sie)|vergiss|missachte|überschreib(?:e|en\s+sie))\s+(?:alle\s+|die\s+|deine\s+|ihre\s+)?(?:(?:vorherigen|vorigen|obigen|bisherigen|früheren)\s+)?(?:anweisungen|anleitungen|regeln|vorgaben)/gi,
  },
  {
    name: 'asserts a role at an assistant',
    re: /\b(?:you\s+are|you're|act\s+as|behave\s+as|from\s+now\s+on\s+you\s+are)\s+(?:now\s+)?(?:an?\s+)?(?:ai|a\.i\.|assistant|ai\s+assistant|language\s+model|llm|chat\s?bot|agent)\b/gi,
  },
  {
    name: 'asserts a role at an assistant (German)',
    re: /\b(?:du\s+bist|sie\s+sind|verhalte\s+dich\s+wie|agiere\s+als)\s+(?:jetzt\s+|ab\s+jetzt\s+)?(?:ein(?:e)?\s+)?(?:ki|k\.i\.|assistent(?:in)?|sprachmodell|chat\s?bot|agent)\b/gi,
  },
  {
    name: 'asks to keep something from the user',
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|show|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|human|operator|reader)\b|\bwithout\s+(?:telling|informing)\s+(?:the\s+)?(?:user|human)\b|\bhide\s+this\s+from\s+(?:the\s+)?(?:user|human)\b/gi,
  },
  {
    name: 'asks to keep something from the user (German)',
    re: /\b(?:sag|sage|erzähl|erzähle|zeig|zeige|verrate)\s+(?:es\s+)?(?:dem\s+(?:nutzer|benutzer|anwender|leser)|der\s+nutzerin)\s+nicht\b|\bohne\s+(?:dem\s+)?(?:nutzer|benutzer|anwender)\s+(?:etwas\s+)?zu\s+sagen\b|\bverberge\s+(?:das|dies|es)\s+vor\s+(?:dem\s+)?(?:nutzer|benutzer)\b/gi,
  },
  {
    name: 'commands something about the system prompt',
    re: /\b(?:reveal|print|show|output|repeat|disclose|ignore|replace|forget|dump)\s+(?:your\s+|the\s+|all\s+)?(?:system\s*prompt|system\s+instructions?|initial\s+instructions?)|\b(?:zeig|zeige|gib|nenne|verrate|ignorier(?:e)?|vergiss)\s+(?:mir\s+)?(?:deinen\s+|den\s+|dein\s+)?(?:system[\s-]?prompt|systemanweisung(?:en)?)/gi,
  },
]

export interface InjectionSignal {
  readonly rule: string
  /** The matching text, trimmed and shortened for a log line. */
  readonly match: string
  /** Character offset in the document, so the reader can find it. */
  readonly offset: number
}

/** Every rule that fires, at most once each: the first hit says what kind of text is in there. */
export function injectionSignals(text: string): InjectionSignal[] {
  const scanned = text.slice(0, SCAN_CHARS)
  const out: InjectionSignal[] = []
  for (const rule of RULES) {
    // Fresh state per scan: a module-level global regex keeps `lastIndex` between calls.
    const re = new RegExp(rule.re.source, rule.re.flags)
    const m = re.exec(scanned)
    if (m === null) continue
    out.push({
      rule: rule.name,
      match: m[0].replace(/\s+/g, ' ').trim().slice(0, QUOTE_CHARS),
      offset: m.index,
    })
  }
  return out
}

/** The manifest note and job-log line for each signal, in the wording the spec fixes. */
export function injectionWarnings(text: string): readonly string[] {
  return injectionSignals(text).map(
    (s) => `preprocess: possible prompt injection: ${JSON.stringify(s.match)} near offset ${s.offset} (${s.rule})`,
  )
}
