/**
 * Job file reference variant
 *
 * Links a FileEntry to a `job` row (the generic job system). Its sole use
 * today is the async image-generation job (`imageGenerationJobHandler`):
 * input images and the edit mask are persisted as `delete_when_unreferenced`
 * FileEntries at enqueue time and referenced by id inside the job payload.
 *
 * ## Why a persistent ref (not just the payload id)
 *
 * The payload id lives in `job.input` JSON, which the cleanup anti-join cannot
 * see. Without a real ref row, a non-terminal job whose inputs age past the
 * grace window could have those inputs reclaimed before startup recovery
 * resumes it, breaking `read(inputFileIds)`. Backing the relationship with an
 * FK-constrained association table makes the job a first-class holder: the
 * anti-join sees it, and deleting the job row (terminal-row pruning) cascades
 * the ref so the inputs become reclaimable exactly when the job record is gone.
 *
 * ## sourceId format
 *
 * `job.id` is `uuidPrimaryKeyOrdered()` — UUID **v7**. `z.uuid()` accepts it
 * (version-agnostic), matching the forgiving stance the chat_message variant
 * takes for its own ids.
 */

import * as z from 'zod'

import { createRefSchema } from './essential'

export const jobSourceType = 'job' as const

export const jobRoles = ['input', 'mask'] as const
export const jobRoleSchema = z.enum(jobRoles)

export const jobRefFields = {
  sourceType: z.literal(jobSourceType),
  sourceId: z.uuid(),
  role: jobRoleSchema
}

export const jobFileRefSchema = createRefSchema(jobRefFields)
