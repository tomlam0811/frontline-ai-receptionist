BEGIN;

-- Rollback for 016_source_erasure.sql. Applied by the migration owner by hand, never by scripts/migrate.mjs.
--
-- It drops the two functions the migration added and nothing else. Feedback, conversations, share links, receipts and
-- owner scope records are left as they are. Share links revoked by a source removal stay revoked, and content already
-- removed from an owner's scope is not restored: a removal cannot be undone by a schema rollback.

DROP FUNCTION IF EXISTS list_scopes_with_pending_source_erasures(integer);
DROP FUNCTION IF EXISTS share_fence_versions(uuid, uuid[]);

COMMIT;
