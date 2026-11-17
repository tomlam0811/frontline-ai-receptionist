BEGIN;

-- Rollback for 019_account_deletion.sql. Applied by the migration owner by hand, never by scripts/migrate.mjs.
--
-- It drops the functions and the job table the migration added and restores the scope state check of migration 001.
-- Nothing a deletion removed comes back. It refuses while any deletion is unfinished: without 019 nothing would resume
-- it, and its businesses would stay fenced and half removed. Let the retention worker finish them first. Scope rows kept
-- as `deleted` for unexpired feedback stay. The restored check is NOT VALID for that reason, so those rows are kept and
-- every new write is checked.

DO $$
BEGIN
  IF to_regclass('public.frontline_account_deletions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.frontline_account_deletions j WHERE j.status <> 'completed') THEN
      RAISE EXCEPTION 'account deletions are still running; let them finish before rolling back 019';
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS purge_frontline_account_leftovers(integer);
DROP FUNCTION IF EXISTS list_pending_frontline_account_deletions(integer);
DROP FUNCTION IF EXISTS fail_frontline_account_deletion(uuid, text);
DROP FUNCTION IF EXISTS complete_frontline_account_deletion(uuid);
DROP FUNCTION IF EXISTS delete_frontline_account_scope(uuid, uuid);
DROP FUNCTION IF EXISTS read_frontline_account_deletion(uuid);
DROP FUNCTION IF EXISTS start_frontline_account_deletion(text, uuid);
DROP TABLE IF EXISTS frontline_account_deletions;

ALTER TABLE ownership_scopes DROP CONSTRAINT IF EXISTS ownership_scopes_state_check;
ALTER TABLE ownership_scopes ADD CONSTRAINT ownership_scopes_state_check
  CHECK (state IN ('anonymous', 'claimed', 'expired')) NOT VALID;

COMMIT;
