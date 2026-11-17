-- Apply as a migration owner. The application role must be separate from the
-- table owner and must not be superuser or BYPASSRLS.
CREATE TABLE IF NOT EXISTS ownership_scopes (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('anonymous', 'tenant')),
  secret_hash text UNIQUE NOT NULL CHECK (length(secret_hash) = 64),
  state text NOT NULL CHECK (state IN ('anonymous', 'claimed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scoped_workspace_states (
  owner_scope_id uuid PRIMARY KEY REFERENCES ownership_scopes(id),
  state jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_demo_scopes (
  demo_id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id)
);

ALTER TABLE scoped_workspace_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoped_workspace_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontline_scope_access ON scoped_workspace_states;
CREATE POLICY frontline_scope_access ON scoped_workspace_states
  USING (owner_scope_id = NULLIF(current_setting('app.owner_scope_id', true), '')::uuid)
  WITH CHECK (owner_scope_id = NULLIF(current_setting('app.owner_scope_id', true), '')::uuid);

-- These functions reveal only a scope UUID after a capability hash or opaque
-- worker demo ID lookup. Every data read still requires transaction-local RLS.
CREATE OR REPLACE FUNCTION resolve_anonymous_scope(p_secret_hash text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM public.ownership_scopes
  WHERE secret_hash = p_secret_hash AND kind = 'anonymous'
    AND state = 'anonymous' AND expires_at > now()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_internal_demo_scope(p_demo_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.owner_scope_id FROM public.internal_demo_scopes s
  JOIN public.ownership_scopes o ON o.id = s.owner_scope_id
  WHERE s.demo_id = p_demo_id AND o.state = 'anonymous' AND o.expires_at > now()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION index_internal_demo_scope(p_demo_id uuid, p_scope uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  IF p_scope IS NULL OR p_scope::text <> current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'demo scope context mismatch';
  END IF;
  INSERT INTO public.internal_demo_scopes (demo_id, owner_scope_id)
    VALUES (p_demo_id, p_scope)
    ON CONFLICT (demo_id) DO UPDATE
      SET owner_scope_id = EXCLUDED.owner_scope_id
      WHERE public.internal_demo_scopes.owner_scope_id = EXCLUDED.owner_scope_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'demo scope binding conflict'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION resolve_anonymous_scope(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_internal_demo_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION index_internal_demo_scope(uuid,uuid) FROM PUBLIC;

-- The deployment must create frontline_app with LOGIN and its own secret.
-- No runtime role may own these tables, be superuser, or have BYPASSRLS.
GRANT INSERT ON ownership_scopes TO frontline_app;
GRANT SELECT, INSERT, UPDATE ON scoped_workspace_states TO frontline_app;
GRANT EXECUTE ON FUNCTION resolve_anonymous_scope(text) TO frontline_app;
GRANT EXECUTE ON FUNCTION resolve_internal_demo_scope(uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION index_internal_demo_scope(uuid,uuid) TO frontline_app;
