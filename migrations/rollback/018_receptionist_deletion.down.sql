BEGIN;

-- Rollback for 018_receptionist_deletion.sql. Applied by the migration owner by hand, never by scripts/migrate.mjs.
--
-- It drops the two functions the migration added and nothing else. Feedback, share link rows and owner scope records are
-- left as they are. A receptionist that was already deleted stays deleted: a schema rollback cannot restore it.

DROP FUNCTION IF EXISTS list_scopes_with_pending_receptionist_deletions(integer);
DROP FUNCTION IF EXISTS delete_receptionist_records(uuid, uuid);

COMMIT;
