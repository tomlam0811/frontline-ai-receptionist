BEGIN;

-- The deployment supplies a separate LOGIN credential for this role. It has
-- no API table grants; only this bounded cleanup entry point is executable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'frontline_cleanup') THEN
    CREATE ROLE frontline_cleanup NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS anonymous_scope_tombstones (
  owner_scope_id uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION cleanup_expired_anonymous_scopes(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_scope uuid;
  v_state jsonb;
  v_deleted integer := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'cleanup batch limit must be between 1 and 50';
  END IF;

  -- Share the start gate's lock so no reservation can appear between the
  -- safety check and deletion. Claims must lock ownership_scopes first.
  PERFORM pg_advisory_xact_lock(46298131838);
  FOR v_scope IN
    SELECT o.id
    FROM public.ownership_scopes o
    WHERE o.kind = 'anonymous' AND o.state = 'anonymous'
      AND o.expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.demo_deadline_ledger d
        WHERE d.owner_scope_id = o.id AND d.state <> 'ended'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.voice_start_reservations r
        WHERE r.owner_scope_id = o.id AND r.state = 'reserved'
          AND r.expires_at > now()
      )
    ORDER BY o.expires_at, o.id
    LIMIT p_limit * 20
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Preserve the existing RLS boundary, even for this SECURITY DEFINER
    -- function. Never grant a cleanup role all-scope JSON access.
    PERFORM set_config('app.owner_scope_id', v_scope::text, true);
    SELECT state INTO v_state FROM public.scoped_workspace_states
      WHERE owner_scope_id = v_scope FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    -- A missing deadline record must never make a live room deletable.
    IF EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(v_state->'demos', '{}'::jsonb)) AS demo
      WHERE demo.value->>'state' IS DISTINCT FROM 'ended'
        AND demo.value->>'state' IS DISTINCT FROM 'failed'
    ) THEN
      CONTINUE;
    END IF;
    INSERT INTO public.anonymous_scope_tombstones(owner_scope_id)
    VALUES (v_scope) ON CONFLICT (owner_scope_id) DO NOTHING;
    DELETE FROM public.demo_deadline_ledger WHERE owner_scope_id = v_scope;
    DELETE FROM public.internal_demo_scopes WHERE owner_scope_id = v_scope;
    DELETE FROM public.voice_start_reservations WHERE owner_scope_id = v_scope;
    -- Migration 005 adds this job ledger; all migrations are applied together
    -- before the retention worker is started.
    DELETE FROM public.preparation_jobs WHERE owner_scope_id = v_scope;
    DELETE FROM public.scoped_workspace_states WHERE owner_scope_id = v_scope;
    DELETE FROM public.ownership_scopes
      WHERE id = v_scope AND kind = 'anonymous' AND state = 'anonymous'
        AND expires_at <= now();
    IF NOT FOUND THEN RAISE EXCEPTION 'anonymous scope changed during deletion'; END IF;
    v_deleted := v_deleted + 1;
    EXIT WHEN v_deleted >= p_limit;
  END LOOP;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_expired_anonymous_scopes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_expired_anonymous_scopes(integer) TO frontline_cleanup;
COMMIT;
