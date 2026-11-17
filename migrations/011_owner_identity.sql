BEGIN;

-- Additive owner-identity lookups for the post-onboarding surfaces. Nothing here
-- replaces an existing function; replacing resolve_internal_demo_scope for claimed
-- scopes is a connection-time migration (PO-C1).

-- Lists the claimed targets of the signed-in subject so the owner home can find
-- Bob without a remembered id (PO-F4). Returns only ids.
CREATE FUNCTION list_frontline_claimed_targets(p_auth_session_hash text)
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

-- The stable, non-reversible reference for the signed-in person (sha256 of the
-- provider subject). Used as the creator reference on feedback so idempotency and
-- ownership survive new sign-in sessions without storing the raw subject.
CREATE FUNCTION frontline_session_subject_ref(p_auth_session_hash text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(s.provider_subject, 'UTF8')), 'hex')
    FROM public.frontline_auth_sessions s
   WHERE s.secret_hash = p_auth_session_hash AND s.revoked_at IS NULL AND s.expires_at > now();
$$;

REVOKE ALL ON FUNCTION list_frontline_claimed_targets(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION frontline_session_subject_ref(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_frontline_claimed_targets(text) TO frontline_app;
GRANT EXECUTE ON FUNCTION frontline_session_subject_ref(text) TO frontline_app;

COMMIT;
