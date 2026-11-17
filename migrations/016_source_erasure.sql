BEGIN;

-- Removing a business knowledge source (PO-A16, PO-E27). Content that lives in an owner's scope JSON is redacted by
-- the runtime role under that owner's row level security (server/api/post-onboarding/source-erasure.js). This
-- migration covers what lives outside the scope JSON and must change when a source is removed: share links.
-- Past conversations and feedback are retained, so nothing here touches them.
--
-- 1. Share links pinned to a fenced version are revoked and their unused or live guest capabilities denied, so a
--    link cannot start or continue a conversation on removed knowledge. The capabilities of finished links stay.
-- 2. A listing function names the scopes with unfinished erasure jobs (ids only) for the retention worker.
--
-- Rollback is migrations/rollback/016_source_erasure.down.sql. It does not restore removed content.

-- Runtime role, owner scope only. Returns the links that were live, so the caller ends those conversations.
CREATE FUNCTION share_fence_versions(p_scope uuid, p_version_ids uuid[])
RETURNS TABLE(id uuid, was_live boolean, demo_id uuid, session_id uuid, reservation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE public.frontline_guest_capabilities c SET kind = 'denied'
   WHERE c.kind IN ('preview','session')
     AND c.grant_id IN (SELECT g.id FROM public.frontline_share_grants g
                         WHERE g.owner_scope_id = p_scope AND g.agent_version_id = ANY(COALESCE(p_version_ids, ARRAY[]::uuid[]))
                           AND g.status IN ('unused','reserved','active'));
  RETURN QUERY
  WITH hit AS (
    SELECT g.id AS grant_id, g.status AS prior FROM public.frontline_share_grants g
     WHERE g.owner_scope_id = p_scope AND g.agent_version_id = ANY(COALESCE(p_version_ids, ARRAY[]::uuid[]))
       AND g.status IN ('unused','reserved','active')
     FOR UPDATE
  ), changed AS (
    UPDATE public.frontline_share_grants g SET status = 'revoked', revoked_at = now(), version = g.version + 1, terminal_reason = 'source_erased'
      FROM hit WHERE g.id = hit.grant_id
      RETURNING g.id, hit.prior, g.demo_id, g.session_id, g.reservation_id
  )
  SELECT changed.id, changed.prior IN ('reserved','active'), changed.demo_id, changed.session_id, changed.reservation_id FROM changed;
END;
$$;

-- Runtime role. Names the claimed scopes that have an erasure job that is pending, or failed with fewer than
-- three attempts. Ids only, read one scope at a time under that scope's own setting, like
-- list_scopes_with_expired_post_onboarding_demos in migration 014.
CREATE FUNCTION list_scopes_with_pending_source_erasures(p_limit integer)
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
      SELECT 1 FROM public.scoped_workspace_states s, jsonb_each(COALESCE(s.state->'sourceErasures', '{}'::jsonb)) AS job
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

REVOKE ALL ON FUNCTION share_fence_versions(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_scopes_with_pending_source_erasures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION share_fence_versions(uuid, uuid[]) TO frontline_app;
GRANT EXECUTE ON FUNCTION list_scopes_with_pending_source_erasures(integer) TO frontline_app;

COMMIT;
