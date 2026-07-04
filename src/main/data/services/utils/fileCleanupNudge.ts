import { application } from '@application'
import { loggerService } from '@logger'

const logger = loggerService.withContext('fileCleanupNudge')

/**
 * Best-effort GC nudge for business delete flows that may have dropped the
 * last persistent ref to a file entry (file-entry-cleanup.md §5.5).
 *
 * Cleanup is owned by FileManager's idle-gated interval — the nudge only
 * shortens latency, so an unavailable FileManager (tests, shutdown) must
 * never fail the caller's delete. The skip is logged for observability;
 * the interval pass covers whatever the nudge missed.
 */
export function nudgeFileEntryCleanup(): void {
  try {
    application.get('FileManager').scheduleCleanup()
  } catch (error) {
    logger.warn('File-entry cleanup nudge skipped — FileManager unavailable; the interval pass will cover it', {
      error
    })
  }
}
