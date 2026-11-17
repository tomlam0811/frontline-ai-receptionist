BEGIN;

-- Budget metadata contains no caller content. Only narrow SECURITY DEFINER
-- functions can read/write it; the runtime role has no table grants.
CREATE TABLE IF NOT EXISTS voice_start_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id),
  preparation_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('business_demo', 'frontline_qa')),
  reserved_cents integer NOT NULL CHECK (reserved_cents > 0),
  state text NOT NULL CHECK (state IN ('reserved', 'completed', 'released', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_reservations_day_idx ON voice_start_reservations (created_at, state);
CREATE INDEX IF NOT EXISTS voice_reservations_scope_day_idx ON voice_start_reservations (owner_scope_id, created_at, state);

-- Aggregate accounting survives deletion of an expired anonymous scope.
-- It contains no prospect, preparation, room, or reservation identifier.
CREATE TABLE IF NOT EXISTS voice_daily_budget (
  day_utc date PRIMARY KEY,
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0)
);

CREATE OR REPLACE FUNCTION reserve_voice_start(
  p_scope uuid, p_preparation uuid, p_mode text,
  p_daily_cap_cents integer, p_reserved_cents integer,
  p_global_concurrent integer, p_ttl_seconds integer
) RETURNS TABLE(reservation_id uuid, approved boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_today timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_day_utc date := (now() AT TIME ZONE 'UTC')::date;
  v_spend bigint;
  v_global_active bigint;
  v_scope_active bigint;
  v_scope_starts bigint;
  v_id uuid;
BEGIN
  IF p_daily_cap_cents <= 0 OR p_reserved_cents <= 0 OR p_global_concurrent <= 0
     OR p_ttl_seconds < 300 OR p_ttl_seconds > 1800 OR p_mode NOT IN ('business_demo', 'frontline_qa') THEN
    RETURN QUERY SELECT NULL::uuid, false, 'invalid_budget_configuration'::text;
    RETURN;
  END IF;
  -- One lock serializes all starts across API processes and prevents cap races.
  PERFORM pg_advisory_xact_lock(46298131838);
  IF NOT EXISTS (
    SELECT 1 FROM public.ownership_scopes
    WHERE id = p_scope AND kind = 'anonymous' AND state = 'anonymous' AND expires_at > now()
  ) THEN
    RETURN QUERY SELECT NULL::uuid, false, 'workspace_unavailable'::text;
    RETURN;
  END IF;
  UPDATE public.voice_start_reservations r SET state = 'expired'
    WHERE r.state = 'reserved' AND r.expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.demo_deadline_ledger d
        WHERE d.reservation_id = r.id AND d.state IN ('active', 'closing')
      );
  SELECT COALESCE(reserved_cents, 0) INTO v_spend
    FROM public.voice_daily_budget WHERE day_utc = v_day_utc;
  v_spend := COALESCE(v_spend, 0);
  SELECT count(*) INTO v_global_active
    FROM public.voice_start_reservations
    WHERE state = 'reserved';
  SELECT count(*) INTO v_scope_active
    FROM public.voice_start_reservations
    WHERE owner_scope_id = p_scope AND state = 'reserved';
  SELECT count(*) INTO v_scope_starts
    FROM public.voice_start_reservations
    WHERE owner_scope_id = p_scope AND created_at >= v_today AND state <> 'released';
  IF v_spend + p_reserved_cents > p_daily_cap_cents OR v_global_active >= p_global_concurrent
     OR v_scope_active >= 1 OR v_scope_starts >= 3 THEN
    RETURN QUERY SELECT NULL::uuid, false, 'voice_limit_reached'::text;
    RETURN;
  END IF;
  INSERT INTO public.voice_start_reservations
    (owner_scope_id, preparation_id, mode, reserved_cents, state, expires_at)
  VALUES (p_scope, p_preparation, p_mode, p_reserved_cents, 'reserved', now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  INSERT INTO public.voice_daily_budget (day_utc, reserved_cents)
    VALUES (v_day_utc, p_reserved_cents)
    ON CONFLICT (day_utc) DO UPDATE
      SET reserved_cents = public.voice_daily_budget.reserved_cents + EXCLUDED.reserved_cents;
  RETURN QUERY SELECT v_id, true, 'approved'::text;
END;
$$;

CREATE OR REPLACE FUNCTION settle_voice_start(p_id uuid, p_state text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_created_at timestamptz; v_reserved_cents bigint; v_count integer;
BEGIN
  IF p_state NOT IN ('completed', 'released') THEN RETURN false; END IF;
  UPDATE public.voice_start_reservations SET state = p_state
    WHERE id = p_id AND state = 'reserved'
    RETURNING created_at, reserved_cents INTO v_created_at, v_reserved_cents;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 1 AND p_state = 'released' THEN
    UPDATE public.voice_daily_budget
      SET reserved_cents = reserved_cents - v_reserved_cents
      WHERE day_utc = (v_created_at AT TIME ZONE 'UTC')::date
        AND reserved_cents >= v_reserved_cents;
    IF NOT FOUND THEN RAISE EXCEPTION 'voice budget ledger mismatch'; END IF;
  END IF;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION reserve_voice_start(uuid,uuid,text,integer,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_voice_start(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_voice_start(uuid,uuid,text,integer,integer,integer,integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION settle_voice_start(uuid,text) TO frontline_app;

COMMIT;
