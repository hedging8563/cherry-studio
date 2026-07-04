# File Entry Cleanup (GC) Design

> Status: implemented (PR #16727) — the `cleanup_policy` column, the scan-based cleanup pass, and the contract updates below shipped together; this document is the design record and behavioral reference for that implementation.
>
> The binding contract in [`file-manager-architecture.md`](./file-manager-architecture.md) §7 was updated in the same series: zero-reference `manual` entries remain report-only, while `delete_when_unreferenced` entries are reclaimed by the cleanup pass described here.
>
> This document replaces the earlier outbox-queue proposal (`file-entry-cleanup-queue.md`); the queue design is preserved in [§10 Rejected Designs](#10-rejected-designs) with the rationale for its rejection.

## 1. Problem

Some business entities own file references through dedicated association tables (`chat_message_file_ref`, `painting_file_ref`). Those tables are FK-constrained on both sides: deleting a `file_entry` cascades and removes association rows, and deleting the owning business entity cascades and removes association rows.

The second path leaves permanent garbage today:

```text
business entity deleted
  -> xxx_file_ref rows cascade-delete
  -> file_entry row remains          (DB sweep only reports, never deletes)
  -> internal physical blob remains  (FS sweep only unlinks files with NO DB row)
```

Because the row survives, neither existing sweep surface can ever reclaim the blob. Deleting a topic, message, or painting leaks every attached/generated file forever.

A second leak exists that the FK-cascade framing misses: **entries that never acquire a persistent ref**. The chat send pipeline creates the `file_entry` first (`buildFileParts.ts`) and writes `chat_message_file_ref` rows only when the message is persisted; a crash or failure in between leaves a zero-ref entry that no cascade event will ever touch. The ad-hoc `permanentDelete` in `imageGenerationJobHandler` is this same demand leaking into imperative business code.

For some files, zero refs is nevertheless the correct end state: a user-visible library entry may have zero references and still be intentionally retained. The file module cannot infer that intent from ref count alone — both cases look like `active file_entry + zero refs`. Business intent must be stored as data.

## 2. Design Goals

- Keep business delete operations free of immediate filesystem side effects.
- Store cleanup intent as per-entry data (`cleanup_policy`), evaluated by FileManager — never by SQL triggers, never inferred from ref count globally.
- Reclaim both leak classes: refs-lost-via-cascade **and** never-referenced entries.
- Preserve user-owned / manually retained library entries even at zero refs.
- Make cleanup crash-recoverable and idempotent **by construction** (derived state, no bookkeeping).
- Reuse FileManager deletion semantics (`permanentDelete` internals) for physical cleanup and cache invalidation.

## 3. Non-goals

- Do not make `ref_count = 0` globally imply deletion.
- Do not add SQL triggers or an event/outbox queue (see [§10](#10-rejected-designs)).
- Do not add per-business `onSourceDeleted` hooks to `FileRefService`.
- Do not make `FileRefService` own persistent relationship writes; source domains still own their association tables.
- Do not ship the FilesPage "pin / save to library" **button** in this scope (the flip endpoint ships; the UI is a follow-up).

## 4. Business Intent: `cleanup_policy`

New `file_entry` column:

```sql
cleanup_policy TEXT NOT NULL DEFAULT 'manual'
  CHECK (cleanup_policy IN ('manual', 'delete_when_unreferenced'))
```

| Value | Meaning |
|---|---|
| `manual` | Keep the entry even at zero refs. Cleanup requires an explicit user/caller action. |
| `delete_when_unreferenced` | FileManager may delete the entry once it has zero persistent refs, no temp-session refs, and is older than the grace window. |

### 4.1 Assignment at creation — all current paths are `delete_when_unreferenced`

Files strictly follow their owning business object's lifecycle. Chat attachments are **copies** (the user's original stays on disk), so automatic reclamation loses nothing irreplaceable; "pin to library" is the retention escape hatch.

| Creation path | Policy |
|---|---|
| Chat attachments (`src/renderer/utils/file/buildFileParts.ts`) | `delete_when_unreferenced` |
| AI-generated images (`src/main/ai/AiService.ts`) | `delete_when_unreferenced` |
| Painting inputs / outputs (`downloadImages.ts`, `runPainting.ts`, composer input hook) | `delete_when_unreferenced` |
| Image-generation transient inputs (`imageGenerationJobHandler.ts`) | `delete_when_unreferenced` — its current ad-hoc post-job `permanentDelete` is **removed**; the cleanup pass takes over (worst-case residency ≈ grace + interval, acceptable for a transient input) |
| Future user-facing "add to library" flows | `manual` |

**Type rule**: `cleanupPolicy` is **required** in the TS creation surfaces (`CreateFileEntryRowSchema`, `CreateInternalEntryParams` / `EnsureExternalEntryParams` IPC schemas) so every caller makes an explicit choice at compile time. The DB default `'manual'` exists only as the safe backstop for migration and raw-SQL paths — a forgotten assignment leaks (recoverable) instead of deleting (unrecoverable).

### 4.2 Policy transitions

- **`ensureExternalEntry` reuse branch — upgrade-only**: when upserting hits an existing row, the call may upgrade `delete_when_unreferenced` → `manual` (caller passes manual intent) but must never downgrade `manual` → `delete_when_unreferenced`. A library file that gets `@`-mentioned in a chat must not silently become a cleanup candidate.
- **Explicit flip**: `PATCH /files/entries/:id` (DataApi, body `{ cleanupPolicy }`) exposes the flip — it is the one FileEntry mutation with no FS side effect, so it lives on DataApi as a pure SQL column update; every other entry write stays on File IPC. Explicit user/caller action may set either direction. This backs the future FilesPage "pin / save to library" action.
- `cleanup_policy` applies to **both origins**. Deleting an external entry is DB-only (the user's file is never touched), per existing `permanentDelete` semantics.

### 4.3 Renderer visibility

FilesPage keeps listing **all** entries (preserving the v1 habit of browsing historical uploads); `cleanupPolicy` is exposed in the DataApi read shape so the UI can badge auto entries and later offer "pin". Files disappearing after their owning chat/painting is deleted is the intended lifecycle, and is recorded in the breaking-changes log (§7.3).

## 5. Cleanup Pass (Reaper)

FileManager owns the pass because it already owns entry deletion semantics, physical cleanup, and file-module caches. It lives as a private module alongside `orphanSweep.ts` (`src/main/services/file/internal/entryCleanup.ts`), exposed as `FileManager.runEntryCleanup()`.

There is **no queue and no trigger**: the candidate set is fully derivable from current DB state, so discovery is a query, and idempotence/crash-safety follow by construction.

### 5.1 Candidate query

Reuses the anti-join skeleton of `FileEntryService.findManualUnreferenced`:

```sql
SELECT id FROM file_entry
WHERE cleanup_policy = 'delete_when_unreferenced'
  AND created_at < :now - :grace
  AND NOT EXISTS (SELECT 1 FROM chat_message_file_ref r WHERE r.file_entry_id = file_entry.id)
  AND NOT EXISTS (SELECT 1 FROM painting_file_ref  r WHERE r.file_entry_id = file_entry.id)
  AND NOT EXISTS (SELECT 1 FROM job_file_ref        r WHERE r.file_entry_id = file_entry.id)
ORDER BY created_at
LIMIT :batch   -- default 100 per pass
```

The `job_file_ref` clause is what keeps async image-generation job inputs alive: those input images / mask are `delete_when_unreferenced` entries whose ids live only in `job.input` JSON (invisible to the anti-join), so a live job holds them through a real ref row instead. Without it, a non-terminal job whose inputs aged past the grace window could have them reclaimed by a startup / interval pass before recovery resumes it, breaking `read(inputFileIds)`. Deleting the job row (terminal-row pruning) cascades the ref, releasing the inputs for reclaim.

- `deleted_at` is **not** filtered: a trashed zero-ref auto entry is reclaimed too (the user already discarded it, and trash auto-expiry is deferred).
- The unique index `(file_entry_id, source_id, role)` on each ref table backs the `NOT EXISTS` probes; at desktop scale the query is single-digit ms. A partial index on `cleanup_policy = 'delete_when_unreferenced'` is the first cheap lever if it ever measures slow (§11).
- The `NOT EXISTS` clauses MUST be generated from the `persistentFileRefTablesBySourceType` registry (`schemas/fileRelations.ts`), never hand-enumerated. A ref table missing from the anti-join makes its entire source's files look unreferenced — a catastrophe the fraction threshold (§5.3) cannot reliably catch (a source holding <50% of entries slips under it). Registry-driven generation plus a test asserting coverage of every registered table makes the omission structurally impossible.

### 5.2 Grace window

`GRACE = 1h` on `created_at`. This protects the entry-before-ref send window (§1) and any similar create-then-reference flow, without per-event bookkeeping. Crash leftovers inside the window are simply collected on a later pass. Single-transaction ref replacement (`replaceChatMessageFileRefsTx`, painting update) needs no grace at all — the pass runs under `withWriteTx` serialization and can never observe a transaction's intermediate state.

### 5.3 Safety threshold

Same philosophy as the FS sweep's abort (`file-manager-architecture.md` §10.4), defending against classification/migration bugs:

- candidates < 20 → always proceed;
- otherwise, if candidates > 50% of all `file_entry` rows → the **automatic** pass (init / interval, and unconfirmed `runSweep`) aborts, deletes nothing, and `warn`-logs with counts.

Unlike the FS sweep — where half the disk suddenly lacking DB rows is almost certainly an upstream bug — this guard has a **legitimate trigger**: a user clearing most of their chats at once can push the candidate fraction past 50%, and since neither the numerator nor the denominator then moves, a bare abort would latch forever. The abort therefore must not be a dead end:

- `runSweep()`'s report includes the pending auto-reclaim count so the cleanup UI can surface "N files pending cleanup".
- An explicitly user-confirmed cleanup invocation (`confirmed` flag on the sweep/cleanup IPC surface) bypasses the fraction check; the per-candidate re-verification (§5.4) and batch limit still apply in full. The user already expressed deletion intent once (deleting the business objects) — this second confirmation is required only in the >50% tail.
- Automatic passes keep re-evaluating every interval; once a confirmed drain (or library growth) brings the fraction back under threshold, automatic reclamation resumes on its own.

The fraction threshold is thus the guard against *classification* bugs (migration mis-tagging, policy mis-assignment); the *coverage* bug class (a ref table missing from the anti-join) is handled structurally by registry-driven query generation (§5.1).

### 5.4 Per-candidate protocol

For each candidate id, one serialized `DbService.withWriteTx` (callback is synchronous):

1. Re-fetch the entry; missing → skip.
2. `cleanup_policy != 'delete_when_unreferenced'` → skip (policy flipped since the query).
3. Count persistent refs **inside the transaction** (new tx-scoped method on `FileRefService`); > 0 → skip.
4. Delete the `file_entry` row.

Temp-session refs are checked **before** the transaction (they live in main-process `CacheService` memory and are not transactional; a temp ref appearing mid-transaction is tolerated — see §6). Any temp-session ref → skip the candidate this pass.

After commit, run the existing `cleanupDeletedEntry` from `permanentDelete`'s implementation: invalidate `versionCache`, remove from `DanglingCache`, best-effort unlink the internal blob (external: DB-only, user's file untouched). If unlink fails, the DB state is already converged and the FS orphan sweep reclaims the blob later.

### 5.5 Triggering

- Once on FileManager init, after `danglingCache.initFromDb()`.
- `BaseService.registerInterval()`, every 30 min, **idle-gated** (below).
- Inside `runSweep()` — the cleanup UI's DB pass becomes "report `manual` zero-ref entries / reclaim `delete_when_unreferenced` ones" over the same anti-join.

**No DB trigger is involved anywhere**, and — deliberately — no per-delete-flow nudge either. Business delete paths drop refs via FK cascade, so a JS-level nudge can only be sprinkled imperatively across every ref-dropping delete site: it multiplies with each new path, and a forgotten call degrades silently. An earlier revision shipped a debounced `scheduleCleanup()` nudge from the topic/message/painting deletes; it was removed because the latency it bought (reclaim in ~5s instead of ≤30min idle / ≤2h active / next init pass) is invisible for a background hygiene process whose grace window already accepts hours. If sub-interval reclamation ever becomes a product requirement, reintroduce it as a domain event FileManager subscribes to — not as scattered imperative calls.

**Idle gate on interval ticks.** At each tick, run only if `PowerService.getSystemIdleTime() ≥ 60s` (`core/power/PowerService.ts`; FileManager declares `@DependsOn(['PowerService'])` — same WhenReady phase) **or** the last completed pass is > 2h old (reliability floor for always-active sessions); otherwise skip and let the next tick re-check. This keeps background deletions out of moments the user is actively working, at the cost of one native call per tick.

The gate applies to interval ticks **only**. The init pass (previous-session backlog) and `runSweep` / confirmed drains (explicit user actions) run ungated. Note this is still timer-driven: `powerMonitor` pushes no "became idle" event for arbitrary thresholds, so idleness can only be sampled — an idle gate refines the interval, it cannot replace it.

### 5.6 Failure handling & observability

A failed candidate is logged and simply retried on the next pass — no attempt counters, no backoff state, no error columns. Each pass emits one structured log record via `loggerService` (mirroring `orphan-sweep`):

```typescript
{
  event: 'file-entry-cleanup',
  outcome: 'completed' | 'aborted' | 'failed',
  confirmed: boolean,          // true for a user-confirmed drain (§5.3)
  candidates: number,
  deleted: number,
  skippedTempRefs: number,
  skippedRefsReappeared: number,
  unlinkFailures: number,
  durationMs: number,
  // 'aborted': abortReason: 'count-fraction'
  // 'failed':  errorMessage: string
}
```

## 6. Race and Failure Analysis

| Scenario | Outcome |
|---|---|
| Business delete cascades ref rows; pass runs later | Candidate appears in the next query; reclaimed. |
| Entry has another persistent ref | Anti-join excludes it; if the ref appears between query and per-candidate tx, step 3 re-check skips. |
| Single-tx ref replacement (delete + re-insert) | Never observable: `withWriteTx` serialization means the pass sees pre- or post-state only. |
| New persistent ref races the delete | Serialized writes decide order. Ref insert commits first → step 3 sees it. Delete commits first → ref insert fails FK validation (same failure mode the business flow already has against explicit `permanentDelete`). |
| Send pipeline: entry created, refs not yet written | Protected by the 1h `created_at` grace window; a crashed send's orphan is collected after the window. |
| Temp-session ref exists | Candidate skipped this pass; temp refs are restart-scoped, so the entry is collected once the session ends. |
| Temp-session ref created between check and commit | Tolerated: the temp ref points at a deleted entry, is pruned by the existing sweep, and persisting it fails FK validation. Temp refs are advisory, not a correctness boundary. |
| Policy flipped to `manual` between query and tx | Step 2 re-check skips. |
| Crash after row delete, before unlink | Blob becomes an FS orphan; existing `runFileSweep` reclaims it. |
| Crash mid-pass | No state to recover; the next pass re-derives candidates. |
| Classification/migration bug creates a huge candidate set | §5.3 threshold aborts the pass and warns. |

## 7. Migration & Rollout

### 7.1 Schema migration

Standard Drizzle column addition (dev-stage migrations are throwaway per repo policy; regenerate as usual). DB default `'manual'`.

### 7.2 v1 migrator classification — by reference state

- Migrators that backfill persistent refs (`ChatMigrator`, `PaintingMigrator`) set `cleanup_policy = 'delete_when_unreferenced'` on the file ids they reference — migrated files follow the same lifecycle rule as newly created ones.
- Entries with zero refs after all backfills keep the default `'manual'`.

Rationale: a blanket `delete_when_unreferenced` would let the **first cleanup pass mass-delete every v1 library file that happens to be unreferenced** — unacceptable data loss. Zero-ref survivors stay report-only, exactly like today.

### 7.3 Breaking-changes log

Entry: `v2-refactor-temp/docs/breaking-changes/2026-07-04-automatic-file-cleanup-on-deletion.md` — deleting a chat/topic/painting now reclaims its exclusively-owned files; the Files page no longer accumulates every historical upload forever; "pin to library" (manual policy) is the retention mechanism.

## 8. Contract & Documentation Updates

Shipped in the same PR series:

- [`file-manager-architecture.md`](./file-manager-architecture.md) §7: the no-reference policy matrix gains the `cleanup_policy` axis; §7.1 "there are no automatic deletion exceptions" and §7.2 "no automatic dangling-external cleanup" are **narrowed to `manual` entries**; §10's DB pass description becomes "report manual / reclaim auto".
- [`architecture.md`](./architecture.md) §5.2 "adding a new sourceType" checklist: **no new step** — a new persistent ref table already had to join `FileRefService` aggregation and the unreferenced/count queries (steps 3/5); the cleanup pass rides those same queries. (Contrast: the rejected queue design added a per-table trigger step that would fail silently when forgotten.)
- This document replaces `file-entry-cleanup-queue.md`.

## 9. Test Plan

- **Schema**: column default + CHECK; `CreateFileEntryRowSchema` requires an explicit policy.
- **Cleanup pass unit tests** (`setupTestDatabase()`):
  - `manual` zero-ref entry → preserved;
  - `delete_when_unreferenced` zero-ref past grace → row deleted, internal blob unlinked;
  - entry with a persistent ref → preserved;
  - temp-session ref → skipped this pass;
  - entry younger than grace → skipped;
  - trashed (`deleted_at` set) auto entry → reclaimed;
  - external auto entry → row deleted, no FS touch;
  - safety threshold → automatic pass aborts, nothing deleted;
  - over-threshold candidate set + `confirmed` invocation → drains (batched, per-candidate re-verified); automatic passes resume once under threshold;
  - candidate query covers every table in `persistentFileRefTablesBySourceType` (coverage test);
  - idle gate: active user (< 60s idle) → tick skipped; idle → runs; > 2h since last completed pass → runs despite activity; init/confirmed paths unaffected by the gate;
  - batch limit respected; failed candidate retried next pass (idempotence).
- **Policy lifecycle**: `ensureExternalEntry` reuse upgrades auto→manual and never downgrades; the DataApi entry PATCH sets both directions.
- **Migrators**: ref-backfilled files → auto; zero-ref survivors → manual.
- **Integration**: deleting a topic eventually reclaims its attachments; a pinned (`manual`) file survives its business owner's deletion.

## 10. Rejected Designs

### 10.1 Outbox queue + ref-table `AFTER DELETE` triggers (the original proposal)

Each persistent ref table got an `AFTER DELETE` trigger inserting `OLD.file_entry_id` into a `file_entry_cleanup_queue` table (`file_entry_id` PK, `first_seen_at` / `last_seen_at` / `next_attempt_at` / `event_count` / `attempt_count` / `last_error`); a FileManager worker drained due rows on an interval, re-validated policy + ref counts, and deleted entries. The queue deliberately carried no FK to `file_entry` (an outbox row may legitimately outlive its target).

Rejected because every load-bearing property turned out to be equaled or beaten by the derived scan:

- **Latency is identical.** SQLite triggers cannot wake JS (better-sqlite3 exposes no update hook), so the worker had to poll the queue on an interval — the design itself named the periodic path "the reliability mechanism". Polling a queue table and polling the derived anti-join have the same reclamation latency. The queue's only remaining edge is O(events) vs O(scan) discovery cost, which at desktop scale (indexed anti-join, single-digit ms, already run today by `runSweep`) is no edge at all.
- **Blind spot: never-referenced entries.** The queue only captures the *had refs → lost refs* transition. Entries that never acquire a ref (crashed sends, abandoned transient inputs — §1's second leak class) never enqueue and leak forever. The scan covers both classes with one `created_at` grace condition.
- **Write amplification inside business transactions.** The trigger fires per deleted ref row — deleting a topic with hundreds of attachments runs hundreds of queue upserts inside the business tx, including for `manual` files whose rows the worker would only discard.
- **Per-table maintenance step.** Every new persistent ref table needed its own trigger wired through `CUSTOM_SQL_STATEMENTS`; forgetting it fails silently as missing cleanup. The scan adds no step beyond the queries a new ref table must already join.
- **Bookkeeping and edge analysis.** Retry columns, capped backoff, `ON CONFLICT` coalescing (which as drafted also reset backoff and never implemented the promised grace window — `next_attempt_at` was set to `now`), plus a page of no-FK justification for queue rows pointing at deleted entries. The scan needs none of it: state is re-derived every pass, so idempotence and crash-safety hold by construction, and roughly half the original test plan (queue mechanics) disappears.

### 10.2 Trigger-as-signal variant (dirty flag)

A slimmed hybrid was considered: keep the triggers but reduce them to a "needs scan" signal the periodic pass checks before running the anti-join. Rejected: it optimizes a cost that does not exist (skipping a <5ms query every 30 min) while retaining most trigger costs — per-table trigger maintenance, business-tx write amplification, signal-row lifecycle choreography (cleared too early → lost signal; too late → redundant scans). It cannot improve latency either, because the signal is still only visible when JS polls. Per-entry signals additionally reintroduce the never-referenced blind spot unless creation also signals or a full scan runs as backstop — at which point the signal pays for nothing. If low latency is ever wanted, a JS-level nudge from delete flows achieves it without touching the DB (see §5.5 for why the shipped revision dropped even that).

### 10.3 Per-business `onSourceDeleted` hooks

Coupling every business delete flow (message, topic, assistant-cascade, painting, replacement flows) to file cleanup inverts the ownership model and misses cascade-driven deletions entirely unless every path is hand-enumerated. The decoupled pass catches all of them, including crash leftovers no hook would ever see.

### 10.4 Global `ref_count == 0` implies deletion

Cannot distinguish an intentionally retained library file from business-owned residue; violates the library-preservation stance of `file-manager-architecture.md` §7. Intent must be data (`cleanup_policy`), not inference.

## 11. Evolution Criteria

Revisit the discovery mechanism only when measurement demands it, in this order:

1. **Partial index** on `cleanup_policy = 'delete_when_unreferenced'` — first lever if the candidate query measures slow (it shrinks the anti-join's driving set to auto entries only).
2. **Queue/outbox upgrade** — justified only if (a) observed pass duration materially blocks the main process at real user scale (recall better-sqlite3 is synchronous) despite the partial index, or (b) a product requirement emerges for sub-interval reclamation that an event-driven JS nudge (§5.5) cannot satisfy, or (c) `file_entry` grows by orders of magnitude (≫100k rows). If that day comes, §10.1's blind-spot and grace-window fixes are mandatory parts of any queue implementation.

## 12. Adding a New Persistent File Ref Source

Unchanged from the existing checklist (`architecture.md` §5.2b): add the FK-constrained association table, register it in `persistentFileRefTablesBySourceType`, join `FileRefService` aggregation and the unreferenced/persistent-count queries, add tests. Because the candidate query is generated from that registry (§5.1), the cleanup pass automatically covers any registered table — there is no cleanup-specific registration step, and the coverage test fails if registration is forgotten.
