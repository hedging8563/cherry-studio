---
title: Deleting a chat, topic, or painting now reclaims its files
category: changed
severity: notice
introduced_in_pr: TBD
date: 2026-07-04
---

## What changed

Deleting a chat topic, message, or painting now reclaims the files that were exclusively created for it (chat attachments, AI-generated images, painting inputs/outputs) once they have no other references — the file record and its physical blob are deleted, not just the owning business row. The Files page no longer accumulates every historical upload forever: files reclaimed this way disappear from the list along with their owner. Pinning a file ("save to library", tracked internally as the `manual` retention policy) is the mechanism that keeps a file around after its originating chat/topic/painting is deleted; files created outside of chat/painting flows (for example, uploaded directly via the Files page) already default to this retained behavior. Files migrated from a v1 install keep today's "kept forever" behavior unless they were referenced by a migrated chat message or painting, in which case they follow the same reclaim-on-delete lifecycle as newly created files.

## Why this matters to the user

Users who relied on the Files page as a permanent archive of every file ever uploaded or generated will see some files disappear after deleting the chat, topic, or painting that used them — this is expected space reclamation, not data loss of anything still referenced elsewhere. Reclamation is not instant: it runs on a background pass (on app start, every 30 minutes when idle, and shortly after a delete) with roughly a one-hour grace window, so a file is not removed the instant its owner is deleted.

## What the user should do

Nothing in the normal case — this is default, automatic behavior. To keep a file beyond its originating conversation, avoid deleting the chat/topic/painting that owns it, or use the "pin to library" action once it ships in the UI (see notes below). v1 users upgrading: files already referenced by a migrated chat or painting follow the new lifecycle; unreferenced legacy library files are left untouched.

## Notes for release manager

- The FilesPage "pin / save to library" **button** is a follow-up and does not ship in this PR series — only the underlying retention-policy flip (main-process endpoint) ships. Until the button lands, users have no in-app way to move a file from the auto-reclaim policy to the pinned/manual policy after the fact.
- Design/spec: `docs/references/file/file-entry-cleanup.md`.
