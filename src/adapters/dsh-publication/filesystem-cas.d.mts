import type { RootBindingV1 } from '../../domain/review/index.js'

export type PublicationKind = 'CREATE' | 'MERGE'

export interface PublicationResult {
  readonly status: 'written' | 'conflict' | 'finalized'
  readonly code?: string
  readonly txid: string
  readonly target?: string
  readonly backup?: string | null
}

export interface PublicationHooks {
  readonly beforeInstall?: (record: Readonly<Record<string, unknown>>) => Promise<void>
  readonly beforeBackupMove?: (record: Readonly<Record<string, unknown>>) => Promise<void>
  readonly beforeBackupRename?: (record: Readonly<Record<string, unknown>>) => Promise<void>
  readonly afterInstall?: (record: Readonly<Record<string, unknown>>) => Promise<void>
}

export interface RootPreparation {
  readonly root: string
  readonly createdSegments: readonly string[]
  readonly rootIdentityDigest: string
}

export class PublicationConflict extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

export function sha256(value: string | Uint8Array): string
export function observePublicationRoot(path: string): Promise<
  | { readonly status: 'EXISTING'; readonly canonicalRootPath: string; readonly rootIdentityDigest: string }
  | { readonly status: 'ABSENT'; readonly canonicalExistingAncestorPath: string; readonly ancestorIdentityDigest: string; readonly missingSegments: readonly string[] }
  | { readonly status: 'UNAVAILABLE' }
>
export function observePublicationEntry(path: string): Promise<{
  readonly status: 'ABSENT' | 'FILE' | 'DIRECTORY' | 'LINK' | 'OTHER'
}>
export function readPublicationText(path: string, maxBytes: number): Promise<
  | { readonly status: 'AVAILABLE'; readonly text: string }
  | { readonly status: 'UNAVAILABLE' }
>
export function verifyPublicationDirectoryIdentity(path: string, expectedIdentityDigest: string): Promise<boolean>
export function verifyFinalizedTransaction(input: {
  readonly root: string
  readonly name: string
  readonly txid: string
  readonly expectedHash: string
  readonly expectedRootIdentityDigest: string
}): Promise<boolean>
export function preparePublicationRoot(input: {
  readonly binding: RootBindingV1
  readonly verifyIdentity: (canonicalPath: string, identityDigest: string) => Promise<boolean>
  readonly verifyParity: (binding: RootBindingV1, canonicalRoot: string) => Promise<boolean>
  readonly crashAt?: string
}): Promise<RootPreparation>
export function createBundle(input: {
  readonly root: string
  readonly name: string
  readonly txid: string
  readonly nextBytes: string | Uint8Array
  readonly rootPreparation?: RootPreparation
  readonly crashAt?: string
  readonly hooks?: PublicationHooks
}): Promise<PublicationResult>
export function mergeBundle(input: {
  readonly root: string
  readonly name: string
  readonly txid: string
  readonly expectedHash: string
  readonly nextBytes: string | Uint8Array
  readonly rootPreparation?: RootPreparation
  readonly crashAt?: string
  readonly hooks?: PublicationHooks
}): Promise<PublicationResult>
export function recoverTransaction(input: {
  readonly root: string
  readonly txid: string
}): Promise<PublicationResult>
export function finalizeTransaction(input: {
  readonly root: string
  readonly txid: string
  readonly confirmedExactReadback: true
}): Promise<PublicationResult>

export const probeInternals: {
  readonly JOURNAL_DIR: string
  readonly MAX_JOURNAL_RECORDS: number
  readonly targetPaths: (
    root: string,
    name: string,
    txid: string,
  ) => Readonly<Record<'targetDir' | 'target' | 'stage' | 'backup' | 'claim', string>>
}
