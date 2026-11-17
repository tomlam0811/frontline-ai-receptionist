BEGIN;

-- Authentication is provider verified in the API. These private tables are
-- reachable by the runtime role only through the bounded functions below.
ALTER TABLE ownership_scopes ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE ownership_scopes ALTER COLUMN expires_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS frontline_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS frontline_memberships (
  tenant_id uuid NOT NULL REFERENCES frontline_tenants(id),
  provider_subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_subject)
);
CREATE TABLE IF NOT EXISTS frontline_auth_sessions (
  secret_hash text PRIMARY KEY CHECK (length(secret_hash) = 64),
  provider_subject text NOT NULL,
  provider_session_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS frontline_auth_sessions_subject_idx ON frontline_auth_sessions(provider_subject);
CREATE TABLE IF NOT EXISTS frontline_claim_grants (
  secret_hash text PRIMARY KEY CHECK (length(secret_hash) = 64),
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id) ON DELETE CASCADE,
  demo_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('agent', 'workspace')),
  target_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_subject text,
  claimed_tenant_id uuid REFERENCES frontline_tenants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS frontline_claim_grants_scope_idx ON frontline_claim_grants(owner_scope_id);
CREATE TABLE IF NOT EXISTS frontline_claimed_targets (
  target_kind text NOT NULL CHECK (target_kind IN ('agent', 'workspace')),
  target_id uuid NOT NULL,
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES frontline_tenants(id),
  PRIMARY KEY (target_kind, target_id)
);
CREATE TABLE IF NOT EXISTS frontline_claim_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  provider_subject text NOT NULL,
  tenant_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS frontline_claim_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type = 'claim.consumed'),
  owner_scope_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE OR REPLACE FUNCTION issue_frontline_claim_grant(
  p_capability_hash text, p_demo_id uuid, p_target_kind text, p_target_id uuid, p_grant_hash text
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_scope public.ownership_scopes%ROWTYPE; v_state jsonb; v_expires timestamptz;
BEGIN
  IF length(p_capability_hash) <> 64 OR length(p_grant_hash) <> 64
     OR p_target_kind NOT IN ('agent', 'workspace') THEN
    RAISE EXCEPTION 'invalid claim grant' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM public.ownership_scopes
   WHERE secret_hash = p_capability_hash FOR UPDATE;
  IF NOT FOUND OR v_scope.kind <> 'anonymous' OR v_scope.state <> 'anonymous'
     OR v_scope.expires_at <= now() THEN
    RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.owner_scope_id', v_scope.id::text, true);
  SELECT s.state INTO v_state FROM public.scoped_workspace_states s
   WHERE s.owner_scope_id = v_scope.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_each(COALESCE(v_state->'demos', '{}'::jsonb)) AS demo
     WHERE demo.key = p_demo_id::text AND demo.value->>'workspaceId' = v_scope.id::text
       AND demo.value->>'state' = 'ended'
       AND ((p_target_kind = 'agent' AND demo.value->>'mode' = 'business_demo'
             AND demo.value->>'agentVersionId' = p_target_id::text)
         OR (p_target_kind = 'workspace' AND demo.value->>'mode' = 'frontline_qa'
             AND p_target_id = v_scope.id))
  ) THEN RAISE EXCEPTION 'claim target unavailable' USING ERRCODE = 'P0002'; END IF;
  IF (p_target_kind = 'workspace' AND (
      p_target_id <> v_scope.id OR NOT EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(v_state->'demos', '{}'::jsonb)) AS demo
         WHERE demo.value->>'workspaceId' = v_scope.id::text
           AND demo.value->>'mode' = 'frontline_qa'
           AND demo.value->>'state' = 'ended'
      ))) OR (p_target_kind = 'agent' AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(COALESCE(v_state->'agents', '{}'::jsonb)) AS agent
         WHERE agent.key = p_target_id::text
           AND agent.value->>'workspaceId' = v_scope.id::text
           AND EXISTS (
             SELECT 1 FROM jsonb_each(COALESCE(v_state->'demos', '{}'::jsonb)) AS demo
              WHERE demo.value->>'agentVersionId' = p_target_id::text
                AND demo.value->>'workspaceId' = v_scope.id::text
                AND demo.value->>'mode' = 'business_demo'
                AND demo.value->>'state' = 'ended'
           )
      )) THEN
    RAISE EXCEPTION 'claim target unavailable' USING ERRCODE = 'P0002';
  END IF;
  v_expires := LEAST(v_scope.expires_at, now() + interval '20 minutes');
  INSERT INTO public.frontline_claim_grants
    (secret_hash, owner_scope_id, demo_id, target_kind, target_id, expires_at)
    VALUES (p_grant_hash, v_scope.id, p_demo_id, p_target_kind, p_target_id, v_expires);
  RETURN v_expires;
END;
$$;

CREATE OR REPLACE FUNCTION create_frontline_auth_session(
  p_session_hash text, p_subject text, p_provider_session_id text, p_expires_at timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF length(p_session_hash) <> 64 OR length(p_subject) < 3 OR length(p_provider_session_id) < 3
     OR p_expires_at <= now() OR p_expires_at > now() + interval '7 days' THEN
    RAISE EXCEPTION 'invalid verified session' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.frontline_auth_sessions
    (secret_hash, provider_subject, provider_session_id, expires_at)
    VALUES (p_session_hash, p_subject, p_provider_session_id, p_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION claim_frontline_scope(
  p_capability_hash text, p_grant_hash text, p_auth_session_hash text, p_demo_id uuid
) RETURNS TABLE(tenant_id uuid, target_kind text, target_id uuid, owner_scope_id uuid, demo_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_grant public.frontline_claim_grants%ROWTYPE;
        v_scope public.ownership_scopes%ROWTYPE;
        v_session public.frontline_auth_sessions%ROWTYPE;
        v_state jsonb; v_tenant uuid; v_job_id uuid; v_preparation jsonb;
BEGIN
  IF p_capability_hash IS NULL OR (p_capability_hash <> '' AND length(p_capability_hash) <> 64) OR length(p_grant_hash) <> 64
     OR length(p_auth_session_hash) <> 64 THEN
    RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002';
  END IF;
  -- Resolve, then lock scope first, matching anonymous cleanup lock order.
  SELECT * INTO v_grant FROM public.frontline_claim_grants
   WHERE secret_hash = p_grant_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_scope FROM public.ownership_scopes
   WHERE id = v_grant.owner_scope_id FOR UPDATE;
  SELECT * INTO v_grant FROM public.frontline_claim_grants
   WHERE secret_hash = p_grant_hash FOR UPDATE;
  IF v_grant.demo_id <> p_demo_id THEN
    RAISE EXCEPTION 'claim target mismatch' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_session FROM public.frontline_auth_sessions
   WHERE secret_hash = p_auth_session_hash FOR UPDATE;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'verified session required' USING ERRCODE = '28000';
  END IF;
  IF v_grant.consumed_at IS NOT NULL THEN
    IF v_grant.consumed_subject <> v_session.provider_subject THEN
      RAISE EXCEPTION 'claim conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_grant.claimed_tenant_id, v_grant.target_kind,
                        v_grant.target_id, v_grant.owner_scope_id, v_grant.demo_id;
    RETURN;
  END IF;
  IF v_scope.id IS NULL OR v_scope.kind <> 'anonymous' OR v_scope.state <> 'anonymous'
     OR v_scope.expires_at <= now() OR p_capability_hash = ''
     OR v_scope.secret_hash <> p_capability_hash
     OR v_grant.expires_at <= now() THEN
    RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.owner_scope_id', v_scope.id::text, true);
  SELECT s.state INTO v_state FROM public.scoped_workspace_states s
   WHERE s.owner_scope_id = v_scope.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim unavailable' USING ERRCODE = 'P0002'; END IF;
  -- Fence queued and leased research before converting the anonymous scope.
  -- This runs under the same scope/state locks as the claim, so a worker that
  -- later attempts to renew or settle an old lease cannot publish a result.
  FOR v_job_id IN SELECT j.id FROM public.preparation_jobs j
     WHERE j.owner_scope_id = v_scope.id
       AND (j.state IN ('queued', 'leased') OR (j.state = 'failed' AND j.reconciled_at IS NULL))
     FOR UPDATE OF j LOOP
    UPDATE public.preparation_jobs SET state = 'failed', lease_token = NULL,
      lease_until = NULL, finished_at = now(), reconciled_at = now()
      WHERE id = v_job_id;
    v_preparation := v_state #> ARRAY['preparations', v_job_id::text];
    IF v_preparation IS NOT NULL AND v_preparation->>'state' = 'researching' THEN
      v_state := jsonb_set(v_state, ARRAY['preparations', v_job_id::text],
        v_preparation || jsonb_build_object('state', 'failed_retryable',
          'error', jsonb_build_object('code', 'workspace_claimed',
            'message', 'Preparation stopped when this workspace was claimed.')),
        false);
    END IF;
  END LOOP;
  -- Scope conversion, rather than copying descendants, preserves every
  -- preparation, knowledge, agent version, demo and request identifier.
  INSERT INTO public.frontline_tenants DEFAULT VALUES RETURNING id INTO v_tenant;
  INSERT INTO public.frontline_memberships(tenant_id, provider_subject, role)
    VALUES (v_tenant, v_session.provider_subject, 'owner');
  UPDATE public.ownership_scopes SET kind = 'tenant', state = 'claimed',
    tenant_id = v_tenant, expires_at = NULL WHERE id = v_scope.id;
  UPDATE public.scoped_workspace_states s
     SET state = jsonb_set(v_state, ARRAY['workspaces', v_scope.id::text, 'state'],
                           '"claimed"'::jsonb, true),
         version = version + 1, updated_at = now()
   WHERE s.owner_scope_id = v_scope.id;
  UPDATE public.frontline_claim_grants SET consumed_at = now(),
    consumed_subject = v_session.provider_subject, claimed_tenant_id = v_tenant
   WHERE secret_hash = p_grant_hash;
  INSERT INTO public.frontline_claim_audit
    (owner_scope_id, target_kind, target_id, provider_subject, tenant_id)
    VALUES (v_scope.id, v_grant.target_kind, v_grant.target_id,
            v_session.provider_subject, v_tenant);
  INSERT INTO public.frontline_claimed_targets
    (target_kind, target_id, owner_scope_id, tenant_id)
    VALUES (v_grant.target_kind, v_grant.target_id, v_scope.id, v_tenant);
  INSERT INTO public.frontline_claim_outbox
    (event_type, owner_scope_id, target_kind, target_id, tenant_id)
    VALUES ('claim.consumed', v_scope.id, v_grant.target_kind, v_grant.target_id, v_tenant);
  RETURN QUERY SELECT v_tenant, v_grant.target_kind, v_grant.target_id, v_scope.id, v_grant.demo_id;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_frontline_member_scope(
  p_auth_session_hash text, p_owner_scope_id uuid
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT o.id FROM public.frontline_auth_sessions s
   JOIN public.frontline_memberships m
     ON m.provider_subject = s.provider_subject
   JOIN public.ownership_scopes o ON o.tenant_id = m.tenant_id
  WHERE s.secret_hash = p_auth_session_hash AND s.revoked_at IS NULL
    AND s.expires_at > now() AND o.id = p_owner_scope_id
    AND o.kind = 'tenant' AND o.state = 'claimed'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_frontline_claimed_target(
  p_auth_session_hash text, p_target_kind text, p_target_id uuid
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT t.owner_scope_id FROM public.frontline_auth_sessions s
   JOIN public.frontline_memberships m ON m.provider_subject = s.provider_subject
   JOIN public.frontline_claimed_targets t ON t.tenant_id = m.tenant_id
   JOIN public.ownership_scopes o ON o.id = t.owner_scope_id
  WHERE s.secret_hash = p_auth_session_hash AND s.revoked_at IS NULL
    AND s.expires_at > now() AND t.target_kind = p_target_kind
    AND t.target_id = p_target_id AND o.kind = 'tenant' AND o.state = 'claimed'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION revoke_frontline_auth_session(p_auth_session_hash text)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  UPDATE public.frontline_auth_sessions SET revoked_at = now()
   WHERE secret_hash = p_auth_session_hash AND revoked_at IS NULL;
$$;

REVOKE ALL ON frontline_auth_sessions, frontline_claim_grants,
  frontline_tenants, frontline_memberships, frontline_claim_audit,
  frontline_claimed_targets, frontline_claim_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_frontline_claim_grant(text,uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_frontline_auth_session(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_frontline_scope(text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_frontline_member_scope(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_frontline_claimed_target(text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_frontline_auth_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_frontline_claim_grant(text,uuid,text,uuid,text) TO frontline_app;
GRANT EXECUTE ON FUNCTION create_frontline_auth_session(text,text,text,timestamptz) TO frontline_app;
GRANT EXECUTE ON FUNCTION claim_frontline_scope(text,text,text,uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION resolve_frontline_member_scope(text,uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION resolve_frontline_claimed_target(text,text,uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION revoke_frontline_auth_session(text) TO frontline_app;
COMMIT;
