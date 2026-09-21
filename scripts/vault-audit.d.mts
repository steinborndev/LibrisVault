/**
 * Types for the measurement harness, hand written because the harness itself is dependency-free
 * JavaScript that has to run with a bare `node` against any vault path. Only what the tests and
 * the server-side callers touch is declared; the harness's own output carries more.
 */

export declare const CONTENT_BUCKETS: readonly string[]
export declare const HUB_FILES: readonly string[]
export declare const RUN_PROTOCOL_HEADINGS: ReadonlyArray<readonly [string, RegExp]>

export interface AuditFrontmatter {
  readonly present: boolean
  readonly fields: ReadonlyMap<string, string>
  readonly lists: ReadonlyMap<string, string[]>
}

export interface AuditPage {
  readonly rel: string
  readonly abs: string
  readonly name: string
  readonly bucket: string
  readonly bytes: number
  readonly text: string
  readonly fm: AuditFrontmatter
  readonly isHub: boolean
  readonly isContent: boolean
}

export type DeadLinkCause = 'colon' | 'slash' | 'trailing-backslash' | 'other'

export interface AddressIntegrityInput {
  readonly pages: ReadonlyArray<{ rel: string; address: string }>
  readonly map: Readonly<Record<string, unknown>> | undefined
  readonly sources: Readonly<Record<string, { pages_created?: string[] }>> | undefined
  readonly rawDirs: readonly string[]
  readonly pageExists: (rel: string) => boolean
}

export interface AddressIntegrity {
  readonly pagesWithAddress: number
  readonly mapEntries: number
  readonly missingFromMap: string[]
  readonly staleMapEntries: string[]
  readonly divergent: string[]
  readonly duplicates: Array<[string, string[]]>
  readonly orphanRawDirs: string[]
  readonly danglingPagesCreated: Array<{ source: string; page: string }>
  readonly maxAddress: number | null
}

export interface VaultAuditReport {
  readonly meta: { measuredAt: string; now: string; head: string | null; vaultRoot?: string }
  readonly pages: {
    total: number
    content: number
    byBucket: Record<string, number>
    byType: Record<string, number>
    sourcesByType: Record<string, { total: number; none: number; one: number; many: number; singleSourceShare: number }>
    createdByMonth: Record<string, number>
    updatedByMonth: Record<string, number>
    status: Record<string, number>
    freshness: { now: string; within30Days: number; share: number }
  }
  readonly hubs: Array<{
    path?: string
    bytes: number
    lines: number
    longestLine: number
    sections: number
    datedSections: number
    relatedEntries: number
    relatedDuplicates: number
  }>
  readonly links: {
    total: number
    wrapped: number
    dead: {
      occurrences: number
      distinctTargets: number
      occurrencesOutsideRecords: number
      byCause: Record<string, number>
      byCauseOutsideRecords: Record<string, number>
      asTheServiceResolves: number
      worstPages: Array<{ path?: string; count: number }>
    }
  }
  readonly headings: Record<string, { pages: number; distinctHeadings: number; bestShared: { heading: string; pages: number; share: number } | null; top?: Array<{ heading: string; pages: number; share: number }>; bestSharedShare?: number | null }>
  readonly runProtocol: { pagesCarrying: number; bytes: number; byHeading: Record<string, number>; bytesByHeading: Record<string, number> }
  readonly tags: {
    assignments: number
    distinct: number
    singleUse: number
    singleUseShare: number
    top: Array<{ tag?: string; pages: number }>
    mirroringByMonth: Record<string, { pages: number; type: number; domain: number }>
  }
  readonly style: {
    emDash: { occurrences: number; pages: number }
    enDash: { occurrences: number }
    aliasCollisions: Array<{ alias: string; kind: string; owners: string[] }> | number
    contradictions: { sections: number; withContent: number; callouts: number }
  }
  readonly reachability: { contentPages: number; notInIndex: string[] | number; notInAnyHub: string[] | number; hubsConsidered?: string[] }
  readonly addresses: AddressIntegrity & {
    rawDirs: number
    counter: number | null
    counterDrift: number | null
  }
  readonly history: {
    contentPagesExisting: number
    contentPathsInHistory: number
    oneKnowledgeCommit: number
    multiKnowledgeCommit: number
    noKnowledgeCommit: number
    multiShare: number
    oneShare: number
    byBucket: Record<string, { pages: number; multi: number; multiShare: number }>
  } | null
  readonly git: {
    totalBlobBytes: number
    byClass: Record<string, { bytes: number; blobs: number }>
    hubs: Record<string, { bytes: number; versions: number }>
    hubShareOfWiki: number
    blobsOver50MB: Array<{ bytes: number; class: string }>
  } | null
}

export declare function parseFrontmatter(markdown: string): AuditFrontmatter
export declare function parseWikilinks(text: string): string[]
export declare function findWrappedLinks(markdown: string): string[]
export declare function classifyDeadLink(target: string): DeadLinkCause
export declare function tagMirroring(
  fmType: string | null | undefined,
  fmDomain: string | null | undefined,
  tags: readonly string[],
): { type: boolean; domain: boolean }
export declare function addressIntegrity(input: AddressIntegrityInput): AddressIntegrity
export declare function loadPages(vaultRoot: string): AuditPage[]
export declare function auditVault(vaultRoot: string, options?: { now?: string }): VaultAuditReport
export declare function redactReport(report: VaultAuditReport): VaultAuditReport
