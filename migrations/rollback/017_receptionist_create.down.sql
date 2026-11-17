BEGIN;

-- Rollback for 017_receptionist_create.sql. Applied by the migration owner by hand, never by scripts/migrate.mjs.
--
-- It drops the registration function, restores the listing order of migration 011 and drops the created_at column.
-- Claimed targets registered for extra receptionists stay in place, and so do their lineages in the owner scope JSON.
-- After a rollback the API cannot add receptionists, and receptionists already added still list and work.

DROP FUNCTION IF EXISTS register_frontline_claimed_agent(text, uuid, uuid);

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
   ORDER BY o.created_at, t.target_id;
$$;

ALTER TABLE frontline_claimed_targets DROP COLUMN IF EXISTS created_at;

COMMIT;
