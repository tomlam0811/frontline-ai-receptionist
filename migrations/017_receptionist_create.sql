BEGIN;

-- Adding a receptionist to a claimed business (multi-receptionist spec MR-D1, MR-D9, technical spec PO-F2 as amended).
-- An agent is a claimed target id with a lineage in the owner scope JSON. Claiming registers the first target; this
-- migration adds the one way to register another target for the same scope, and keeps the listing in creation order.
--
-- 1. frontline_claimed_targets gains created_at, so a scope's receptionists list in the order they were added.
--    Rows that exist now all take the time this migration ran; they keep their old relative order through target_id.
-- 2. list_frontline_claimed_targets orders by scope, then by creation. Signature and columns are unchanged.
-- 3. register_frontline_claimed_agent inserts one agent target for the caller's own scope and refuses the sixth.
--    The limit is counted and enforced here, under a lock on the scope, so two requests cannot both take the last place.
--
-- Rollback is migrations/rollback/017_receptionist_create.down.sql. It leaves registered targets in place.

ALTER TABLE frontline_claimed_targets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION list_frontline_claimed_targets(p_auth_session_hash text)
RETURNS TABLE(target_kind text, target_id uuid, owner_scope_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.target_kind, t.target_id, t.owner_scope_id, t.tenant_id
    FROM public.frontline_auth_sessions s
    JOIN public.frontline_memberships m ON m.provider_subject = s.provider_subject
    JOIN public.frontline_claimed_targets t ON t.tenant_id = m.tenant_id
    JOIN public.ownership_scopes o ON o.id = t.owner_scope_id
   WHERE s.secret_hash = p_auth_session_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND o.kind = 'tenant' AND o.state = 'claimed'
   ORDER BY o.created_at, t.created_at, t.target_id;
$$;

-- Runtime role, owner scope only. The caller sets app.owner_scope_id to the scope, as for every owner write, and passes
-- the hash of its signed-in session. The session must belong to a member of the scope's tenant. Returns how many agent
-- targets the scope has after this one. Errors: 'owner scope mismatch' (42501), 'not_found' (P0002),
-- 'receptionist_limit' (53400).
CREATE OR REPLACE FUNCTION register_frontline_claimed_agent(p_auth_session_hash text, p_scope uuid, p_target_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_limit CONSTANT integer := 5;
  v_tenant uuid;
  v_count integer;
BEGIN
  IF p_scope IS NULL OR p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_target_id IS NULL OR length(p_auth_session_hash) <> 64 THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('frontline_claimed_agents:' || p_scope::text, 0));
  SELECT o.tenant_id INTO v_tenant
    FROM public.ownership_scopes o
    JOIN public.frontline_memberships m ON m.tenant_id = o.tenant_id
    JOIN public.frontline_auth_sessions s ON s.provider_subject = m.provider_subject
   WHERE o.id = p_scope AND o.kind = 'tenant' AND o.state = 'claimed'
     AND s.secret_hash = p_auth_session_hash AND s.revoked_at IS NULL AND s.expires_at > now()
   LIMIT 1;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.frontline_claimed_targets t
   WHERE t.owner_scope_id = p_scope AND t.target_kind = 'agent';
  IF v_count >= v_limit THEN RAISE EXCEPTION 'receptionist_limit' USING ERRCODE = '53400'; END IF;
  INSERT INTO public.frontline_claimed_targets(target_kind, target_id, owner_scope_id, tenant_id)
    VALUES ('agent', p_target_id, p_scope, v_tenant);
  RETURN v_count + 1;
END;
$$;

REVOKE ALL ON FUNCTION register_frontline_claimed_agent(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_frontline_claimed_agent(text, uuid, uuid) TO frontline_app;

COMMIT;
