BEGIN;

-- Deleting an account (PO-D12, PO-R14, PO-A20). The signed-in owner erases everything Frontline holds for them, at once
-- and for good. The API derives the person from the fl_auth session only (server/api/post-onboarding/account-deletion.js).
--
-- 1. start_frontline_account_deletion fences in one transaction, before the API answers:
--    - every sign-in session of the person is revoked, and its Google subject is replaced by a marker that names the job,
--      so a repeat of the request after a lost response finds the same job and nothing identifies the person;
--    - every business the person owns alone (scope state `deleting`) stops resolving for every owner, guest and worker
--      path, its open share links are revoked, and every guest capability of its links is denied (a consumed link too);
--    - feedback the person sent stops carrying their one-way reference: each row gets its own unlinkable reference;
--    - a business another member also belongs to is kept for that member: only this person's membership goes, and the
--      one-way reference to this person (sha256 of the subject) is replaced in its rows and its scope JSON;
--    - the person's memberships are deleted, so signing in again with the same Google account starts with nothing.
-- 2. delete_frontline_account_scope removes one fenced business: scope JSON (receptionists, versions, knowledge library,
--    preparations, conversations, transcripts, summaries), demo indexes, room deadlines, voice reservations, research jobs,
--    share links and guest capabilities, claim grants, claimed targets, claim audit and outbox rows. It waits (returns
--    `waiting`) while a call or room is still live, so a live call is never cut off by a cleanup.
-- 3. complete_frontline_account_deletion removes the person's tenants once every business is gone.
-- 4. The retention worker resumes unfinished jobs (list_pending_frontline_account_deletions), retrying a failed job with
--    a growing wait and never giving up, and removes what is left once it is no longer needed
--    (purge_frontline_account_leftovers).
--
-- Kept on purpose: feedback already sent to the Frontline team (frontline_feedback, its events) expires by its own 30 day
-- rule, like a receptionist delete, without anything that identifies the person. Its owner_scope_id references the scope row, so a scope with feedback is kept as an
-- empty `deleted` row with no tenant until that feedback expires. Builder access (frontline_builder_*) is operator
-- managed staff access and is not owner data. voice_daily_budget is an aggregate with no identifier.
--
-- Rollback is migrations/rollback/019_account_deletion.down.sql. It does not restore anything a deletion removed.

ALTER TABLE ownership_scopes DROP CONSTRAINT IF EXISTS ownership_scopes_state_check;
ALTER TABLE ownership_scopes ADD CONSTRAINT ownership_scopes_state_check
  CHECK (state IN ('anonymous', 'claimed', 'expired', 'deleting', 'deleted'));

-- The durable job. Ids and timestamps only: no subject, name, email or content.
CREATE TABLE frontline_account_deletions (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,40}$'),
  scope_ids uuid[] NOT NULL DEFAULT '{}',
  scopes_done uuid[] NOT NULL DEFAULT '{}',
  tenant_ids uuid[] NOT NULL DEFAULT '{}',
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX frontline_account_deletions_open_idx ON frontline_account_deletions (requested_at) WHERE status <> 'completed';
REVOKE ALL ON frontline_account_deletions FROM PUBLIC;

-- Runtime role. Errors: 'sign_in_required' (28000) for a missing, expired or revoked session that no deletion ended.
-- A session that a deletion ended returns that job (created = false); a failed job is set back to pending.
CREATE FUNCTION start_frontline_account_deletion(p_auth_session_hash text, p_job_id uuid)
RETURNS TABLE(job_id uuid, status text, created boolean, scope_ids uuid[], scopes_done uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_session public.frontline_auth_sessions%ROWTYPE;
  v_subject text; v_ref text; v_marker text; v_job uuid; v_tenant uuid; v_scope uuid;
  v_scopes uuid[] := '{}'; v_tenants uuid[] := '{}'; v_shared uuid[] := '{}';
  v_saved text := COALESCE(current_setting('app.owner_scope_id', true), '');
  -- Replaces the person's one-way reference wherever a kept row carried it. It is the same for everyone, so it links nothing.
  v_scrubbed CONSTANT text := encode(sha256(convert_to('frontline:account-deleted', 'UTF8')), 'hex');
BEGIN
  IF p_auth_session_hash IS NULL OR length(p_auth_session_hash) <> 64 OR p_job_id IS NULL THEN
    RAISE EXCEPTION 'sign_in_required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_session FROM public.frontline_auth_sessions s WHERE s.secret_hash = p_auth_session_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sign_in_required' USING ERRCODE = '28000'; END IF;
  IF v_session.provider_subject LIKE 'account-deleted:%' THEN
    v_job := substr(v_session.provider_subject, length('account-deleted:') + 1)::uuid;
    UPDATE public.frontline_account_deletions j SET status = 'pending', updated_at = now()
     WHERE j.id = v_job AND j.status = 'failed';
    RETURN QUERY SELECT j.id, j.status, false, j.scope_ids, j.scopes_done FROM public.frontline_account_deletions j WHERE j.id = v_job;
    RETURN;
  END IF;
  IF v_session.revoked_at IS NOT NULL OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'sign_in_required' USING ERRCODE = '28000';
  END IF;
  v_subject := v_session.provider_subject;
  v_ref := encode(sha256(convert_to(v_subject, 'UTF8')), 'hex');
  v_marker := 'account-deleted:' || p_job_id::text;

  -- Sessions first: a claim with another session of this person locks its session row too, so the two serialize and a
  -- business claimed just before this point is found below.
  UPDATE public.frontline_auth_sessions s SET revoked_at = COALESCE(s.revoked_at, now()), provider_subject = v_marker
   WHERE s.provider_subject = v_subject;

  FOR v_tenant IN SELECT m.tenant_id FROM public.frontline_memberships m WHERE m.provider_subject = v_subject ORDER BY m.tenant_id LOOP
    IF EXISTS (SELECT 1 FROM public.frontline_memberships m WHERE m.tenant_id = v_tenant AND m.provider_subject <> v_subject) THEN
      v_shared := v_shared || ARRAY(SELECT o.id FROM public.ownership_scopes o WHERE o.tenant_id = v_tenant ORDER BY o.id);
    ELSE
      v_tenants := v_tenants || v_tenant;
      v_scopes := v_scopes || ARRAY(SELECT o.id FROM public.ownership_scopes o WHERE o.tenant_id = v_tenant AND o.kind = 'tenant' ORDER BY o.id);
    END IF;
  END LOOP;

  -- The fence. Every resolver requires state 'claimed', so from here on nothing reaches these businesses.
  PERFORM 1 FROM public.ownership_scopes o WHERE o.id = ANY(v_scopes) ORDER BY o.id FOR UPDATE;
  UPDATE public.ownership_scopes o SET state = 'deleting' WHERE o.id = ANY(v_scopes) AND o.state = 'claimed';
  -- Every link status: a consumed link still resolves for its guest (result, feedback) until the capability expires.
  UPDATE public.frontline_guest_capabilities c SET kind = 'denied'
   WHERE c.kind IN ('preview', 'session')
     AND c.grant_id IN (SELECT g.id FROM public.frontline_share_grants g WHERE g.owner_scope_id = ANY(v_scopes));
  UPDATE public.frontline_share_grants g SET status = 'revoked', revoked_at = now(), version = g.version + 1, terminal_reason = 'account_deleted'
   WHERE g.owner_scope_id = ANY(v_scopes) AND g.status IN ('unused', 'reserved', 'active');

  -- Rows that stay (claim history of a shared business, a consumed claim grant) stop naming the person.
  UPDATE public.frontline_claim_audit a SET provider_subject = 'account-deleted' WHERE a.provider_subject = v_subject;
  UPDATE public.frontline_claim_grants g SET consumed_subject = 'account-deleted' WHERE g.consumed_subject = v_subject;
  -- Feedback already sent stays until it expires, in any business. Each row gets a reference of its own (the unique key
  -- includes it), derived from the row id, so the rows link neither to the person nor to each other.
  UPDATE public.frontline_feedback_events e SET actor_ref = v_scrubbed WHERE e.actor_kind = 'owner' AND e.actor_ref = v_ref;
  UPDATE public.frontline_feedback f SET creator_ref = encode(sha256(convert_to('frontline:account-deleted:' || f.id::text, 'UTF8')), 'hex')
   WHERE f.creator_kind = 'owner' AND f.creator_ref = v_ref;
  IF cardinality(v_shared) > 0 THEN
    UPDATE public.frontline_share_grants g SET created_by_ref = v_scrubbed WHERE g.owner_scope_id = ANY(v_shared) AND g.created_by_ref = v_ref;
    FOREACH v_scope IN ARRAY v_shared LOOP
      PERFORM set_config('app.owner_scope_id', v_scope::text, true);
      UPDATE public.scoped_workspace_states s SET state = replace(s.state::text, v_ref, v_scrubbed)::jsonb, version = s.version + 1, updated_at = now()
       WHERE s.owner_scope_id = v_scope AND strpos(s.state::text, v_ref) > 0;
    END LOOP;
    PERFORM set_config('app.owner_scope_id', v_saved, true);
  END IF;

  DELETE FROM public.frontline_memberships m WHERE m.provider_subject = v_subject;
  INSERT INTO public.frontline_account_deletions(id, scope_ids, tenant_ids) VALUES (p_job_id, v_scopes, v_tenants);
  RETURN QUERY SELECT p_job_id, 'pending'::text, true, v_scopes, '{}'::uuid[];
END;
$$;

-- Runtime role. One job, ids and counts only.
CREATE FUNCTION read_frontline_account_deletion(p_job uuid)
RETURNS TABLE(job_id uuid, status text, attempts integer, failure_code text, scope_ids uuid[], scopes_done uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT j.id, j.status, j.attempts, j.failure_code, j.scope_ids, j.scopes_done FROM public.frontline_account_deletions j WHERE j.id = p_job;
$$;

-- Runtime role, under the scope's own setting. Returns 'removed', 'done' (already removed) or 'waiting' (a call, room or
-- reservation is still live; nothing was removed). Errors: 'owner scope mismatch' (42501), 'not_found' (P0002),
-- 'scope_not_deleting' (55000).
CREATE FUNCTION delete_frontline_account_scope(p_job uuid, p_scope uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.frontline_account_deletions%ROWTYPE; v_state jsonb;
BEGIN
  IF p_scope IS NULL OR p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job FROM public.frontline_account_deletions j WHERE j.id = p_job FOR UPDATE;
  IF NOT FOUND OR NOT (p_scope = ANY(v_job.scope_ids)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF p_scope = ANY(v_job.scopes_done) THEN RETURN 'done'; END IF;
  -- The voice start gate's lock, as in the anonymous cleanup, so no reservation appears between the check and the delete.
  PERFORM pg_advisory_xact_lock(46298131838);
  PERFORM 1 FROM public.ownership_scopes o WHERE o.id = p_scope AND o.state = 'deleting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_not_deleting' USING ERRCODE = '55000'; END IF;
  SELECT s.state INTO v_state FROM public.scoped_workspace_states s WHERE s.owner_scope_id = p_scope FOR UPDATE;
  -- A missing deadline record must never make a live room deletable, so the scope JSON is checked as well.
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(v_state->'demos', '{}'::jsonb)) AS demo
              WHERE demo.value->>'state' IS DISTINCT FROM 'ended' AND demo.value->>'state' IS DISTINCT FROM 'failed')
     OR EXISTS (SELECT 1 FROM public.demo_deadline_ledger d WHERE d.owner_scope_id = p_scope AND d.state <> 'ended')
     OR EXISTS (SELECT 1 FROM public.voice_start_reservations r WHERE r.owner_scope_id = p_scope AND r.state = 'reserved' AND r.expires_at > now())
     OR EXISTS (SELECT 1 FROM public.frontline_share_grants g WHERE g.owner_scope_id = p_scope AND g.status IN ('reserved', 'active')) THEN
    RETURN 'waiting';
  END IF;
  DELETE FROM public.demo_deadline_ledger d WHERE d.owner_scope_id = p_scope;
  DELETE FROM public.internal_demo_scopes i WHERE i.owner_scope_id = p_scope;
  DELETE FROM public.voice_start_reservations r WHERE r.owner_scope_id = p_scope;
  DELETE FROM public.preparation_jobs p WHERE p.owner_scope_id = p_scope;
  DELETE FROM public.frontline_share_grants g WHERE g.owner_scope_id = p_scope;
  DELETE FROM public.frontline_claim_grants g WHERE g.owner_scope_id = p_scope;
  DELETE FROM public.frontline_claimed_targets t WHERE t.owner_scope_id = p_scope;
  DELETE FROM public.frontline_claim_audit a WHERE a.owner_scope_id = p_scope;
  DELETE FROM public.frontline_claim_outbox o WHERE o.owner_scope_id = p_scope;
  DELETE FROM public.scoped_workspace_states s WHERE s.owner_scope_id = p_scope;
  IF EXISTS (SELECT 1 FROM public.frontline_feedback f WHERE f.owner_scope_id = p_scope) THEN
    UPDATE public.ownership_scopes o SET state = 'deleted', tenant_id = NULL WHERE o.id = p_scope;
  ELSE
    DELETE FROM public.ownership_scopes o WHERE o.id = p_scope;
  END IF;
  UPDATE public.frontline_account_deletions j SET scopes_done = j.scopes_done || p_scope, updated_at = now() WHERE j.id = p_job;
  RETURN 'removed';
END;
$$;

-- Runtime role. Finishes a job once every business is gone: removes the person's tenants and marks it completed.
-- Returns the job status. Errors: 'not_found' (P0002).
CREATE FUNCTION complete_frontline_account_deletion(p_job uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.frontline_account_deletions%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.frontline_account_deletions j WHERE j.id = p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.status = 'completed' THEN RETURN 'completed'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_job.scope_ids) AS s(id) WHERE NOT (s.id = ANY(v_job.scopes_done))) THEN RETURN v_job.status; END IF;
  DELETE FROM public.frontline_tenants t
   WHERE t.id = ANY(v_job.tenant_ids)
     AND NOT EXISTS (SELECT 1 FROM public.frontline_memberships m WHERE m.tenant_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.frontline_claimed_targets c WHERE c.tenant_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.frontline_claim_grants g WHERE g.claimed_tenant_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM public.ownership_scopes o WHERE o.tenant_id = t.id);
  UPDATE public.frontline_account_deletions j SET status = 'completed', failure_code = NULL, completed_at = now(), updated_at = now() WHERE j.id = p_job;
  RETURN 'completed';
END;
$$;

-- Runtime role. Records a failed attempt; the job stays fenced and the sweep retries it after a wait.
CREATE FUNCTION fail_frontline_account_deletion(p_job uuid, p_code text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.frontline_account_deletions j SET status = 'failed', failure_code = p_code, attempts = j.attempts + 1, updated_at = now()
   WHERE j.id = p_job AND j.status <> 'completed';
$$;

-- Runtime role. Jobs that are pending, or failed and due a retry, oldest first. Ids only. A failed job waits 2^attempts
-- minutes after its last attempt, at most six hours, and is retried for as long as it fails.
CREATE FUNCTION list_pending_frontline_account_deletions(p_limit integer)
RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'batch limit must be between 1 and 200';
  END IF;
  RETURN QUERY SELECT j.id FROM public.frontline_account_deletions j
   WHERE j.status = 'pending'
      OR (j.status = 'failed' AND j.updated_at <= now() - least(interval '1 minute' * power(2, least(j.attempts, 10)), interval '6 hours'))
   ORDER BY j.requested_at, j.id LIMIT p_limit;
END;
$$;

-- Runtime role. Removes what a finished deletion no longer needs, counts only:
-- ended sessions of deleted accounts once expired (the browser has dropped their cookie by then), `deleted` scope rows
-- whose feedback has expired, and completed jobs that no session points at any more.
CREATE FUNCTION purge_frontline_account_leftovers(p_limit integer)
RETURNS TABLE(sessions integer, scopes integer, jobs integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_sessions integer; v_scopes integer; v_jobs integer;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'batch limit must be between 1 and 500';
  END IF;
  WITH doomed AS (
    SELECT s.secret_hash FROM public.frontline_auth_sessions s
     WHERE s.provider_subject LIKE 'account-deleted:%' AND s.expires_at <= now() ORDER BY s.expires_at LIMIT p_limit)
  DELETE FROM public.frontline_auth_sessions s USING doomed WHERE s.secret_hash = doomed.secret_hash;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  WITH doomed AS (
    SELECT o.id FROM public.ownership_scopes o
     WHERE o.state = 'deleted' AND NOT EXISTS (SELECT 1 FROM public.frontline_feedback f WHERE f.owner_scope_id = o.id)
     ORDER BY o.id LIMIT p_limit)
  DELETE FROM public.ownership_scopes o USING doomed WHERE o.id = doomed.id;
  GET DIAGNOSTICS v_scopes = ROW_COUNT;
  WITH doomed AS (
    SELECT j.id FROM public.frontline_account_deletions j
     WHERE j.status = 'completed'
       AND NOT EXISTS (SELECT 1 FROM public.frontline_auth_sessions s WHERE s.provider_subject = 'account-deleted:' || j.id::text)
     ORDER BY j.completed_at LIMIT p_limit)
  DELETE FROM public.frontline_account_deletions j USING doomed WHERE j.id = doomed.id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  RETURN QUERY SELECT v_sessions, v_scopes, v_jobs;
END;
$$;

REVOKE ALL ON FUNCTION start_frontline_account_deletion(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_frontline_account_deletion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_frontline_account_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_frontline_account_deletion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_frontline_account_deletion(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_pending_frontline_account_deletions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_frontline_account_leftovers(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_frontline_account_deletion(text, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION read_frontline_account_deletion(uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION delete_frontline_account_scope(uuid, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION complete_frontline_account_deletion(uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION fail_frontline_account_deletion(uuid, text) TO frontline_app;
GRANT EXECUTE ON FUNCTION list_pending_frontline_account_deletions(integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION purge_frontline_account_leftovers(integer) TO frontline_app;

COMMIT;
