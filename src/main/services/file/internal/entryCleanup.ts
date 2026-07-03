/**
 * Scan-based cleanup pass for delete_when_unreferenced file entries.
 * Spec: docs/references/file/file-entry-cleanup.md §5.
 *
 * No queue, no triggers: candidates are derived from current DB state, so the
 * pass is idempotent and crash-safe by construction. Discovery uses the
 * registry-driven anti-join (fileRelations.persistentRefAbsenceConditions);
 * each candidate is re-verified inside a serialized write tx before deletion;
 * FS cleanup happens after commit via lifecycle.cleanupDeletedEntry.
 */
import { loggerService } from '@logger'
import type { FileEntry } from '@shared/data/types/file'
import type { EntryCleanupSummary } from '@shared/types/file/sweep'

import type { FileManagerDeps } from './deps'
import { cleanupDeletedEntry } from './entry/lifecycle'

const logger = loggerService.withContext('FileManager:entryCleanup')

function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`)
}

export const ENTRY_CLEANUP_GRACE_MS = 60 * 60 * 1000
export const ENTRY_CLEANUP_BATCH_LIMIT = 100
const ABORT_MIN_CANDIDATES = 20
const ABORT_FRACTION = 0.5

export interface EntryCleanupOptions {
  readonly confirmed?: boolean
}

export interface EntryCleanupReport {
  readonly outcome: 'completed' | 'aborted' | 'failed'
  readonly confirmed: boolean
  readonly candidates: number
  readonly deleted: number
  readonly skippedTempRefs: number
  readonly skippedRefsReappeared: number
  readonly unlinkFailures: number
  readonly durationMs: number
  readonly abortReason?: 'count-fraction'
  readonly errorMessage?: string
}

type CandidateOutcome = { kind: 'deleted'; entry: FileEntry } | { kind: 'refs-reappeared' } | { kind: 'gone-or-pinned' }

export async function runEntryCleanup(
  deps: FileManagerDeps,
  opts: EntryCleanupOptions = {}
): Promise<EntryCleanupReport> {
  const startedAt = Date.now()
  const confirmed = opts.confirmed ?? false
  try {
    const candidates = deps.fileEntryService.countCleanupCandidates(ENTRY_CLEANUP_GRACE_MS)
    if (candidates === 0) {
      return finish({
        outcome: 'completed',
        confirmed,
        candidates,
        deleted: 0,
        skippedTempRefs: 0,
        skippedRefsReappeared: 0,
        unlinkFailures: 0,
        durationMs: Date.now() - startedAt
      })
    }

    // Safety threshold (spec §5.3): guards classification bugs; a legitimate
    // mass-delete unblocks via the user-confirmed drain.
    const totalEntries = deps.fileEntryService.countAll()
    if (!confirmed && candidates >= ABORT_MIN_CANDIDATES && candidates > totalEntries * ABORT_FRACTION) {
      return finish({
        outcome: 'aborted',
        abortReason: 'count-fraction',
        confirmed,
        candidates,
        deleted: 0,
        skippedTempRefs: 0,
        skippedRefsReappeared: 0,
        unlinkFailures: 0,
        durationMs: Date.now() - startedAt
      })
    }

    const batch = deps.fileEntryService.findCleanupCandidates({
      graceMs: ENTRY_CLEANUP_GRACE_MS,
      limit: ENTRY_CLEANUP_BATCH_LIMIT
    })
    let deleted = 0
    let skippedTempRefs = 0
    let skippedRefsReappeared = 0
    let unlinkFailures = 0

    for (const candidate of batch) {
      try {
        // Temp-session refs live in main-process cache memory and are not
        // transactional — checked outside the tx; a ref appearing mid-tx is
        // tolerated (spec §6: pruned later, FK fails on persist).
        const hasTempRef = deps.fileRefService
          .findByEntryId(candidate.id)
          .some((ref) => ref.sourceType === 'temp_session')
        if (hasTempRef) {
          skippedTempRefs++
          continue
        }

        const outcome = deps.fileEntryService.withWriteTx((tx): CandidateOutcome => {
          const row = deps.fileEntryService.findByIdTx(tx, candidate.id)
          if (row === null || row.cleanupPolicy !== 'delete_when_unreferenced') {
            return { kind: 'gone-or-pinned' }
          }
          if (deps.fileRefService.countPersistentRefsByEntryIdTx(tx, candidate.id) > 0) {
            return { kind: 'refs-reappeared' }
          }
          deps.fileEntryService.deleteTx(tx, candidate.id)
          return { kind: 'deleted', entry: row }
        })

        switch (outcome.kind) {
          case 'deleted': {
            deleted++
            const { unlinkFailed } = await cleanupDeletedEntry(deps, outcome.entry)
            if (unlinkFailed) unlinkFailures++
            break
          }
          case 'refs-reappeared':
            skippedRefsReappeared++
            break
          case 'gone-or-pinned':
            break
          default:
            assertNever(outcome)
        }
      } catch (err) {
        // Stateless retry (spec §5.6): the next pass re-derives this candidate.
        logger.warn('file-entry-cleanup: candidate failed, retried next pass', { id: candidate.id, err })
      }
    }

    return finish({
      outcome: 'completed',
      confirmed,
      candidates,
      deleted,
      skippedTempRefs,
      skippedRefsReappeared,
      unlinkFailures,
      durationMs: Date.now() - startedAt
    })
  } catch (err) {
    return finish({
      outcome: 'failed',
      errorMessage: (err as Error).message,
      confirmed,
      candidates: 0,
      deleted: 0,
      skippedTempRefs: 0,
      skippedRefsReappeared: 0,
      unlinkFailures: 0,
      durationMs: Date.now() - startedAt
    })
  }
}

function finish(report: EntryCleanupReport): EntryCleanupReport {
  const payload = { event: 'file-entry-cleanup', ...report }
  switch (report.outcome) {
    case 'completed':
      logger.info('file-entry-cleanup', payload)
      break
    case 'aborted':
      logger.warn('file-entry-cleanup', payload)
      break
    case 'failed':
      logger.error('file-entry-cleanup', payload)
      break
    default:
      assertNever(report.outcome)
  }
  return report
}

export function summariseEntryCleanup(report: EntryCleanupReport): EntryCleanupSummary {
  return {
    outcome: report.outcome,
    candidates: report.candidates,
    deleted: report.deleted,
    ...(report.abortReason !== undefined ? { abortReason: report.abortReason } : {})
  }
}
