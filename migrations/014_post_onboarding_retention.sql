BEGIN;

-- Retention for post-onboarding data (PO-OQ5: 30 days). Two parts, because the data lives in two places.
--
-- 1. Global tables (feedback, guest capabilities, share grants): cleanup_expired_post_onboarding runs as
--    frontline_cleanup and returns counts only.
-- 2. Conversations inside an owner's scope JSON: the runtime role prunes them under that owner's row level
--    security. list_scopes_with_expired_post_onboarding_demos only names the scopes that have something to
--    prune (ids, never content); the pruning itself is server/api/post-onboarding/retention.js.

CREATE FUNCTION cleanup_expired_post_onboarding(p_limit integer)
RETURNS TABLE(feedback integer, guest_capabilities integer, share_grants integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_feedback integer; v_capabilities integer; v_grants integer;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'cleanup batch limit must be between 1 and 500';
  END IF;
  WITH doomed AS (SELECT f.id FROM public.frontline_feedback f WHERE f.expires_at <= now() ORDER BY f.expires_at, f.id LIMIT p_limit)
  DELETE FROM public.frontline_feedback f USING doomed WHERE f.id = doomed.id;
  GET DIAGNOSTICS v_feedback = ROW_COUNT;
  WITH doomed AS (SELECT c.capability_hash FROM public.frontline_guest_capabilities c WHERE c.expires_at <= now() ORDER BY c.expires_at LIMIT p_limit)
  DELETE FROM public.frontline_guest_capabilities c USING doomed WHERE c.capability_hash = doomed.capability_hash;
  GET DIAGNOSTICS v_capabilities = ROW_COUNT;
  -- A grant is kept 30 days after it ended (or expired), so the owner still sees it in their list.
  WITH doomed AS (
    SELECT g.id FROM public.frontline_share_grants g
    WHERE COALESCE(g.consumed_at, g.revoked_at, g.expires_at) <= now() - interval '30 days'
      AND (g.status IN ('consumed', 'revoked', 'expired') OR (g.status = 'unused' AND g.expires_at <= now() - interval '30 days'))
    ORDER BY g.created_at, g.id LIMIT p_limit)
  DELETE FROM public.frontline_share_grants g USING doomed WHERE g.id = doomed.id;
  GET DIAGNOSTICS v_grants = ROW_COUNT;
  RETURN QUERY SELECT v_feedback, v_capabilities, v_grants;
END;
$$;

CREATE FUNCTION list_scopes_with_expired_post_onboarding_demos(p_limit integer)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_scope uuid; v_found integer := 0; v_saved text := COALESCE(current_setting('app.owner_scope_id', true), '');
BEGIN
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'batch limit must be between 1 and 200';
  END IF;
  FOR v_scope IN SELECT o.id FROM public.ownership_scopes o WHERE o.kind = 'tenant' AND o.state = 'claimed' ORDER BY o.id LOOP
    -- Same boundary as the anonymous cleanup: read each owner's row only under that owner's scope.
    PERFORM set_config('app.owner_scope_id', v_scope::text, true);
    IF EXISTS (
      SELECT 1 FROM public.scoped_workspace_states s, jsonb_each(COALESCE(s.state->'demos', '{}'::jsonb)) AS demo
      WHERE s.owner_scope_id = v_scope
        AND demo.value->>'expiresAt' IS NOT NULL AND (demo.value->>'expiresAt')::timestamptz <= now()
        AND demo.value->>'state' IN ('ended', 'failed')
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

REVOKE ALL ON FUNCTION cleanup_expired_post_onboarding(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_scopes_with_expired_post_onboarding_demos(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_expired_post_onboarding(integer) TO frontline_cleanup;
GRANT EXECUTE ON FUNCTION list_scopes_with_expired_post_onboarding_demos(integer) TO frontline_app;

COMMIT;
