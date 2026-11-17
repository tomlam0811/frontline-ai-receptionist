BEGIN;

-- Deleting a receptionist (MR-D6, MR-J5). Everything inside the owner's scope JSON is removed by the runtime role under
-- that owner's row level security (server/api/post-onboarding/receptionist-deletion.js). This migration covers what
-- lives outside the scope JSON and the retention worker's list of unfinished jobs. Feedback already sent to the
-- Frontline team is not touched; it expires by its own 30 day rule.
--
-- 1. delete_receptionist_records removes the share link rows of one receptionist (their guest capabilities go with them)
--    and its claimed target, so the receptionist no longer resolves for its owner. It refuses while a link is still
--    reserved or active, so a live conversation is never cut off by a cleanup, and while the receptionist still exists
--    in the scope JSON without the `deleting` status.
-- 2. list_scopes_with_pending_receptionist_deletions names the scopes with an unfinished delete job (ids only) for the
--    retention worker.
--
-- Rollback is migrations/rollback/018_receptionist_deletion.down.sql. It does not restore anything a delete removed.

-- Runtime role, owner scope only. Returns how many share link rows were removed.
CREATE FUNCTION delete_receptionist_records(p_scope uuid, p_agent uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_status text; v_links integer;
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT s.state->'agentLineages'->(p_agent::text)->>'status' INTO v_status
    FROM public.scoped_workspace_states s
   WHERE s.owner_scope_id = p_scope AND s.state->'agentLineages' ? (p_agent::text);
  IF FOUND AND v_status IS DISTINCT FROM 'deleting' THEN
    RAISE EXCEPTION 'receptionist_not_deleting' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.frontline_share_grants g WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_agent AND g.status IN ('reserved','active')) THEN
    RAISE EXCEPTION 'links_still_live' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.frontline_share_grants g WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_agent;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  DELETE FROM public.frontline_claimed_targets t WHERE t.owner_scope_id = p_scope AND t.target_kind = 'agent' AND t.target_id = p_agent;
  RETURN v_links;
END;
$$;

-- Runtime role. Names the claimed scopes that have a delete job that is pending, or failed with fewer than three
-- attempts. Ids only, read one scope at a time under that scope's own setting, like
-- list_scopes_with_pending_source_erasures in migration 016.
CREATE FUNCTION list_scopes_with_pending_receptionist_deletions(p_limit integer)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_scope uuid; v_found integer := 0; v_saved text := COALESCE(current_setting('app.owner_scope_id', true), '');
BEGIN
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'batch limit must be between 1 and 200';
  END IF;
  FOR v_scope IN SELECT o.id FROM public.ownership_scopes o WHERE o.kind = 'tenant' AND o.state = 'claimed' ORDER BY o.id LOOP
    PERFORM set_config('app.owner_scope_id', v_scope::text, true);
    IF EXISTS (
      SELECT 1 FROM public.scoped_workspace_states s, jsonb_each(COALESCE(s.state->'receptionistDeletions', '{}'::jsonb)) AS job
      WHERE s.owner_scope_id = v_scope
        AND (job.value->>'status' = 'pending'
          OR (job.value->>'status' = 'failed' AND COALESCE((job.value->>'attempts')::integer, 0) < 3))
    ) THEN
      v_found := v_found + 1;
      RETURN NEXT v_scope;
      EXIT WHEN v_found >= p_limit;
    END IF;
  END LOOP;
  PERFORM set_config('app.owner_scope_id', v_saved, true);
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION delete_receptionist_records(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_scopes_with_pending_receptionist_deletions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_receptionist_records(uuid, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION list_scopes_with_pending_receptionist_deletions(integer) TO frontline_app;

COMMIT;
