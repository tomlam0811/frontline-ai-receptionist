BEGIN;

-- One-conversation guest share links. The raw link token and the guest cookie value are
-- never stored, only their SHA-256 hashes. Like the other global tables, these get no
-- grant to frontline_app; the runtime role uses the SECURITY DEFINER functions below.
CREATE TABLE frontline_share_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id),
  stable_agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status text NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused','reserved','active','consumed','expired','revoked')),
  created_by_ref text NOT NULL CHECK (length(created_by_ref) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  payload_digest text NOT NULL CHECK (length(payload_digest) = 64),
  version integer NOT NULL DEFAULT 1,
  lease_generation integer NOT NULL DEFAULT 0,
  reservation_id uuid,
  demo_id uuid,
  session_id uuid,
  start_capability_hash text,
  reserved_at timestamptz,
  reservation_deadline_at timestamptz,
  activated_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  terminal_reason text,
  UNIQUE (owner_scope_id, idempotency_key)
);
-- The database-level guarantee for one live guest conversation per agent.
CREATE UNIQUE INDEX frontline_share_one_live_per_agent ON frontline_share_grants (stable_agent_id)
  WHERE status IN ('reserved','active');
CREATE INDEX frontline_share_agent_idx ON frontline_share_grants (owner_scope_id, stable_agent_id, created_at DESC);
CREATE INDEX frontline_share_expiry_idx ON frontline_share_grants (expires_at) WHERE status IN ('unused','reserved','active');

CREATE TABLE frontline_guest_capabilities (
  capability_hash text PRIMARY KEY CHECK (length(capability_hash) = 64),
  grant_id uuid NOT NULL REFERENCES frontline_share_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('preview','session','denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX frontline_guest_capabilities_grant_idx ON frontline_guest_capabilities (grant_id);
-- Exactly one capability can ever be bound to a grant's conversation.
CREATE UNIQUE INDEX frontline_guest_one_session ON frontline_guest_capabilities (grant_id) WHERE kind = 'session';
REVOKE ALL ON frontline_share_grants, frontline_guest_capabilities FROM PUBLIC;

-- Owner: create. The owner scope was resolved by the API and set in app.owner_scope_id.
-- A replay of the same key returns the stored row without a secret (replayed = true).
-- Errors: 'owner scope mismatch' (42501), 'idempotency_conflict' (23505), 'share_limit_reached' (53400).
CREATE FUNCTION share_create(
  p_scope uuid, p_stable uuid, p_version uuid, p_token_hash text, p_created_by_ref text,
  p_expires_at timestamptz, p_key text, p_digest text, p_max_unused integer
) RETURNS TABLE(id uuid, status text, agent_version_id uuid, created_at timestamptz, expires_at timestamptz, version integer, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row public.frontline_share_grants%ROWTYPE; v_unused integer;
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.frontline_share_grants g WHERE g.owner_scope_id = p_scope AND g.idempotency_key = p_key;
  IF FOUND THEN
    IF v_row.payload_digest <> p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505'; END IF;
    RETURN QUERY SELECT v_row.id, v_row.status, v_row.agent_version_id, v_row.created_at, v_row.expires_at, v_row.version, true;
    RETURN;
  END IF;
  UPDATE public.frontline_share_grants g SET status = 'expired', version = g.version + 1
   WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_stable AND g.status = 'unused' AND g.expires_at <= now();
  SELECT count(*) INTO v_unused FROM public.frontline_share_grants g
   WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_stable AND g.status = 'unused' AND g.expires_at > now();
  IF v_unused >= p_max_unused THEN RAISE EXCEPTION 'share_limit_reached' USING ERRCODE = '53400'; END IF;
  INSERT INTO public.frontline_share_grants(owner_scope_id, stable_agent_id, agent_version_id, token_hash, created_by_ref, expires_at, idempotency_key, payload_digest)
    VALUES (p_scope, p_stable, p_version, p_token_hash, p_created_by_ref, p_expires_at, p_key, p_digest)
    RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.status, v_row.agent_version_id, v_row.created_at, v_row.expires_at, v_row.version, false;
END;
$$;

-- Owner: list. Never returns token_hash. Lazily expires overdue unused links; live ones
-- (reserved or active) are expired by share_expire_due so their calls are ended first.
CREATE FUNCTION share_list(p_scope uuid, p_stable uuid)
RETURNS TABLE(id uuid, status text, agent_version_id uuid, created_at timestamptz, expires_at timestamptz,
              activated_at timestamptz, consumed_at timestamptz, revoked_at timestamptz, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  UPDATE public.frontline_share_grants g SET status = 'expired', version = g.version + 1
   WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_stable AND g.status = 'unused' AND g.expires_at <= now();
  RETURN QUERY
  SELECT g.id, g.status, g.agent_version_id, g.created_at, g.expires_at, g.activated_at, g.consumed_at, g.revoked_at, g.version
    FROM public.frontline_share_grants g
   WHERE g.owner_scope_id = p_scope AND g.stable_agent_id = p_stable
   ORDER BY g.created_at DESC, g.id DESC LIMIT 100;
END;
$$;

-- Owner: revoke. Reports whether a live conversation must now be ended by the caller.
-- Errors: 'not_found' (P0002), 'stale_share' (40001), 'invalid_transition' (22023).
CREATE FUNCTION share_revoke(p_scope uuid, p_grant uuid, p_expected_version integer)
RETURNS TABLE(id uuid, status text, was_live boolean, demo_id uuid, session_id uuid, reservation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row public.frontline_share_grants%ROWTYPE;
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.frontline_share_grants g WHERE g.id = p_grant AND g.owner_scope_id = p_scope FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status = 'revoked' THEN
    RETURN QUERY SELECT v_row.id, v_row.status, false, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF v_row.version <> p_expected_version THEN RAISE EXCEPTION 'stale_share' USING ERRCODE = '40001'; END IF;
  IF v_row.status NOT IN ('unused','reserved','active') THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023'; END IF;
  UPDATE public.frontline_share_grants g SET status = 'revoked', revoked_at = now(), version = g.version + 1, terminal_reason = 'share_revoked'
   WHERE g.id = p_grant;
  UPDATE public.frontline_guest_capabilities c SET kind = 'denied' WHERE c.grant_id = p_grant AND c.kind = 'preview';
  RETURN QUERY SELECT v_row.id, 'revoked'::text, v_row.status IN ('reserved','active'),
                      CASE WHEN v_row.status IN ('reserved','active') THEN v_row.demo_id END,
                      CASE WHEN v_row.status IN ('reserved','active') THEN v_row.session_id END,
                      CASE WHEN v_row.status IN ('reserved','active') THEN v_row.reservation_id END;
END;
$$;

-- Guest: the link page opens. Only an unused, unexpired link yields a preview capability.
-- `reason` is one of available, unavailable, used, revoked, expired, busy (fixed set).
CREATE FUNCTION share_exchange(p_token_hash text, p_preview_hash text, p_ttl_seconds integer)
RETURNS TABLE(reason text, grant_id uuid, owner_scope_id uuid, stable_agent_id uuid, agent_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row public.frontline_share_grants%ROWTYPE;
BEGIN
  IF length(p_token_hash) <> 64 OR length(p_preview_hash) <> 64 OR p_ttl_seconds < 60 OR p_ttl_seconds > 86400 THEN
    RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v_row FROM public.frontline_share_grants g WHERE g.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF v_row.status = 'unused' AND v_row.expires_at <= now() THEN
    UPDATE public.frontline_share_grants g SET status = 'expired', version = g.version + 1 WHERE g.id = v_row.id;
    v_row.status := 'expired';
  END IF;
  IF v_row.status <> 'unused' THEN
    RETURN QUERY SELECT CASE v_row.status WHEN 'consumed' THEN 'used' WHEN 'revoked' THEN 'revoked' WHEN 'expired' THEN 'expired' ELSE 'busy' END,
                        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.frontline_guest_capabilities c WHERE c.grant_id = v_row.id) >= 20 THEN
    RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.frontline_guest_capabilities(capability_hash, grant_id, kind, expires_at)
    VALUES (p_preview_hash, v_row.id, 'preview', least(now() + make_interval(secs => p_ttl_seconds), v_row.expires_at));
  RETURN QUERY SELECT 'available'::text, v_row.id, v_row.owner_scope_id, v_row.stable_agent_id, v_row.agent_version_id;
END;
$$;

-- Guest: start. Locks the grant, moves unused -> reserved, binds one capability to the
-- conversation and marks every other capability denied. The caller runs this in the same
-- transaction as the paid voice reservation and rolls back if that is not approved.
-- outcome: reserved | replay | busy | used | expired | revoked | unavailable
CREATE FUNCTION share_start_reserve(p_capability_hash text, p_demo_id uuid, p_session_id uuid, p_session_ttl_seconds integer, p_readiness_seconds integer)
RETURNS TABLE(outcome text, grant_id uuid, lease_generation integer, demo_id uuid, session_id uuid, owner_scope_id uuid, stable_agent_id uuid, agent_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_cap public.frontline_guest_capabilities%ROWTYPE; v_row public.frontline_share_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_cap FROM public.frontline_guest_capabilities c WHERE c.capability_hash = p_capability_hash;
  IF NOT FOUND OR v_cap.expires_at <= now() THEN
    RETURN QUERY SELECT 'unavailable'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v_row FROM public.frontline_share_grants g WHERE g.id = v_cap.grant_id FOR UPDATE;
  IF v_row.status = 'unused' AND v_row.expires_at <= now() THEN
    UPDATE public.frontline_share_grants g SET status = 'expired', version = g.version + 1 WHERE g.id = v_row.id;
    v_row.status := 'expired';
  END IF;
  IF v_cap.kind = 'session' AND v_row.status IN ('reserved','active') THEN
    RETURN QUERY SELECT 'replay'::text, v_row.id, v_row.lease_generation, v_row.demo_id, v_row.session_id, v_row.owner_scope_id, v_row.stable_agent_id, v_row.agent_version_id; RETURN;
  END IF;
  IF v_row.status <> 'unused' OR v_cap.kind <> 'preview' THEN
    RETURN QUERY SELECT CASE WHEN v_row.status = 'consumed' THEN 'used' WHEN v_row.status = 'revoked' THEN 'revoked'
                          WHEN v_row.status = 'expired' THEN 'expired' ELSE 'busy' END,
                        NULL::uuid, NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  BEGIN
    UPDATE public.frontline_share_grants g SET status = 'reserved', lease_generation = g.lease_generation + 1,
        start_capability_hash = p_capability_hash, demo_id = p_demo_id, session_id = p_session_id,
        reserved_at = now(), reservation_deadline_at = now() + make_interval(secs => p_readiness_seconds), version = g.version + 1
      WHERE g.id = v_row.id RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Another link for the same agent is already live.
    RETURN QUERY SELECT 'busy'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END;
  UPDATE public.frontline_guest_capabilities c SET kind = 'denied' WHERE c.grant_id = v_row.id AND c.capability_hash <> p_capability_hash;
  UPDATE public.frontline_guest_capabilities c SET kind = 'session', expires_at = now() + make_interval(secs => p_session_ttl_seconds)
   WHERE c.capability_hash = p_capability_hash;
  RETURN QUERY SELECT 'reserved'::text, v_row.id, v_row.lease_generation, v_row.demo_id, v_row.session_id, v_row.owner_scope_id, v_row.stable_agent_id, v_row.agent_version_id;
END;
$$;

-- Binds the paid voice reservation to the grant, in the same transaction as the reserve.
CREATE FUNCTION share_bind_reservation(p_grant uuid, p_lease_generation integer, p_reservation uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.frontline_share_grants g SET reservation_id = p_reservation
   WHERE g.id = p_grant AND g.status = 'reserved' AND g.lease_generation = p_lease_generation AND g.reservation_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- All fenced by lease generation: a late worker holding an older generation changes nothing.
CREATE FUNCTION share_mark_active(p_grant uuid, p_lease_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.frontline_share_grants g SET status = 'active', activated_at = now(), version = g.version + 1
   WHERE g.id = p_grant AND g.status = 'reserved' AND g.lease_generation = p_lease_generation;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE FUNCTION share_mark_consumed(p_grant uuid, p_lease_generation integer, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.frontline_share_grants g SET status = 'consumed', consumed_at = now(), terminal_reason = left(p_reason, 80), version = g.version + 1
   WHERE g.id = p_grant AND g.status = 'active' AND g.lease_generation = p_lease_generation;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Only after the caller confirmed the room is gone. Keeps the incremented generation so a
-- late worker with the old one stays fenced, and lets the starting browser try again.
CREATE FUNCTION share_release_reservation(p_grant uuid, p_lease_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer; v_cap text;
BEGIN
  UPDATE public.frontline_share_grants g SET status = 'unused', reservation_id = NULL, demo_id = NULL, session_id = NULL,
         reserved_at = NULL, reservation_deadline_at = NULL, version = g.version + 1
   WHERE g.id = p_grant AND g.status = 'reserved' AND g.lease_generation = p_lease_generation
   RETURNING g.start_capability_hash INTO v_cap;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 1 THEN
    UPDATE public.frontline_share_grants g SET start_capability_hash = NULL WHERE g.id = p_grant;
    UPDATE public.frontline_guest_capabilities c SET kind = 'preview' WHERE c.capability_hash = v_cap;
  END IF;
  RETURN v_count = 1;
END;
$$;

-- Watchdog and lazy expiry. Returns live conversations so the caller ends them through the
-- normal terminal path.
CREATE FUNCTION share_expire_due(p_limit integer)
RETURNS TABLE(grant_id uuid, owner_scope_id uuid, was_live boolean, demo_id uuid, session_id uuid, reservation_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH due AS (
    SELECT g.id, g.status AS prior FROM public.frontline_share_grants g
     WHERE g.status IN ('unused','reserved','active') AND g.expires_at <= now()
     ORDER BY g.expires_at LIMIT least(greatest(p_limit, 1), 500) FOR UPDATE SKIP LOCKED
  ), changed AS (
    UPDATE public.frontline_share_grants g SET status = 'expired', version = g.version + 1, terminal_reason = 'share_expired'
      FROM due WHERE g.id = due.id
      RETURNING g.id, g.owner_scope_id, due.prior, g.demo_id, g.session_id, g.reservation_id
  )
  SELECT changed.id, changed.owner_scope_id, changed.prior IN ('reserved','active'), changed.demo_id, changed.session_id, changed.reservation_id FROM changed;
$$;

-- Guest request context: ids only. Excludes revoked and expired links. A consumed link keeps
-- resolving until the session capability expires, so the guest can read the result and send
-- feedback within the window.
CREATE FUNCTION resolve_guest_scope(p_capability_hash text)
RETURNS TABLE(owner_scope_id uuid, grant_id uuid, demo_id uuid, session_id uuid, kind text, status text,
              stable_agent_id uuid, agent_version_id uuid, lease_generation integer, consumed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT g.owner_scope_id, g.id, g.demo_id, g.session_id, c.kind, g.status, g.stable_agent_id, g.agent_version_id, g.lease_generation, g.consumed_at
    FROM public.frontline_guest_capabilities c
    JOIN public.frontline_share_grants g ON g.id = c.grant_id
   WHERE c.capability_hash = p_capability_hash AND c.expires_at > now() AND c.kind IN ('preview','session')
     AND g.status NOT IN ('revoked','expired')
     AND (g.status <> 'unused' OR g.expires_at > now());
$$;

REVOKE ALL ON FUNCTION share_create(uuid, uuid, uuid, text, text, timestamptz, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_list(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_revoke(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_exchange(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_start_reserve(text, uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_bind_reservation(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_mark_active(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_mark_consumed(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_release_reservation(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION share_expire_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_guest_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION share_create(uuid, uuid, uuid, text, text, timestamptz, text, text, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_list(uuid, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_revoke(uuid, uuid, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_exchange(text, text, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_start_reserve(text, uuid, uuid, integer, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_bind_reservation(uuid, integer, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_mark_active(uuid, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_mark_consumed(uuid, integer, text) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_release_reservation(uuid, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION share_expire_due(integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION resolve_guest_scope(text) TO frontline_app;

COMMIT;
