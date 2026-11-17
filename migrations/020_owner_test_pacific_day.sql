BEGIN;

-- Owner test-call allowances follow the business owner's Pacific calendar day.
-- Shared guest limits and the shared spend ledger remain on UTC.
CREATE FUNCTION frontline_voice_scope_day_start(p_mode text, p_at timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT date_trunc('day', p_at AT TIME ZONE zone_name) AT TIME ZONE zone_name
  FROM (SELECT CASE WHEN p_mode = 'owner_test' THEN 'America/Los_Angeles' ELSE 'UTC' END AS zone_name) AS zone_choice
$$;

REVOKE ALL ON FUNCTION frontline_voice_scope_day_start(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION frontline_voice_scope_day_start(text, timestamptz) TO frontline_app;

CREATE OR REPLACE FUNCTION reserve_voice_start_claimed(
  p_scope uuid, p_stable_agent uuid, p_mode text, p_grant uuid,
  p_daily_cap_cents integer, p_reserved_cents integer, p_global_concurrent integer,
  p_ttl_seconds integer, p_scope_daily_max integer, p_agent_active_max integer
) RETURNS TABLE(reservation_id uuid, approved boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_today timestamptz;
  v_day_utc date := (now() AT TIME ZONE 'UTC')::date;
  v_spend bigint; v_global_active bigint; v_agent_active bigint; v_scope_starts bigint; v_id uuid;
BEGIN
  IF p_daily_cap_cents <= 0 OR p_reserved_cents <= 0 OR p_global_concurrent <= 0
     OR p_ttl_seconds < 300 OR p_ttl_seconds > 1800 OR p_scope_daily_max <= 0 OR p_agent_active_max <= 0
     OR p_mode NOT IN ('owner_test', 'shared_guest')
     OR (p_mode = 'shared_guest') <> (p_grant IS NOT NULL) THEN
    RETURN QUERY SELECT NULL::uuid, false, 'invalid_budget_configuration'::text;
    RETURN;
  END IF;
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(46298131838);
  IF NOT EXISTS (SELECT 1 FROM public.ownership_scopes o WHERE o.id = p_scope AND o.kind = 'tenant' AND o.state = 'claimed') THEN
    RETURN QUERY SELECT NULL::uuid, false, 'workspace_unavailable'::text;
    RETURN;
  END IF;
  UPDATE public.voice_start_reservations r SET state = 'expired'
    WHERE r.state = 'reserved' AND r.expires_at <= now()
      AND NOT EXISTS (SELECT 1 FROM public.demo_deadline_ledger d WHERE d.reservation_id = r.id AND d.state IN ('active', 'closing'));
  SELECT COALESCE(b.reserved_cents, 0) INTO v_spend FROM public.voice_daily_budget b WHERE b.day_utc = v_day_utc;
  v_spend := COALESCE(v_spend, 0);
  SELECT count(*) INTO v_global_active FROM public.voice_start_reservations r WHERE r.state = 'reserved';
  SELECT count(*) INTO v_agent_active FROM public.voice_start_reservations r WHERE r.stable_agent_id = p_stable_agent AND r.state = 'reserved';
  v_today := public.frontline_voice_scope_day_start(p_mode, now());
  SELECT count(*) INTO v_scope_starts FROM public.voice_start_reservations r
    WHERE r.owner_scope_id = p_scope AND r.mode = p_mode AND r.created_at >= v_today AND r.state <> 'released';
  IF v_agent_active >= p_agent_active_max THEN
    RETURN QUERY SELECT NULL::uuid, false, 'agent_busy'::text;
    RETURN;
  END IF;
  IF v_spend + p_reserved_cents > p_daily_cap_cents OR v_global_active >= p_global_concurrent OR v_scope_starts >= p_scope_daily_max THEN
    RETURN QUERY SELECT NULL::uuid, false, 'voice_limit_reached'::text;
    RETURN;
  END IF;
  INSERT INTO public.voice_start_reservations (owner_scope_id, preparation_id, mode, reserved_cents, state, expires_at, stable_agent_id, grant_id)
    VALUES (p_scope, p_stable_agent, p_mode, p_reserved_cents, 'reserved', now() + make_interval(secs => p_ttl_seconds), p_stable_agent, p_grant)
    RETURNING id INTO v_id;
  INSERT INTO public.voice_daily_budget (day_utc, reserved_cents) VALUES (v_day_utc, p_reserved_cents)
    ON CONFLICT (day_utc) DO UPDATE SET reserved_cents = public.voice_daily_budget.reserved_cents + EXCLUDED.reserved_cents;
  RETURN QUERY SELECT v_id, true, 'approved'::text;
END;
$$;

REVOKE ALL ON FUNCTION reserve_voice_start_claimed(uuid, uuid, text, uuid, integer, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_voice_start_claimed(uuid, uuid, text, uuid, integer, integer, integer, integer, integer, integer) TO frontline_app;

COMMIT;
