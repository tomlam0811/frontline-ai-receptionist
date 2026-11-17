BEGIN;

-- Operational room deadlines contain no transcript, caller fields or source text.
-- Runtime receives only narrow functions, never direct table access.
CREATE TABLE IF NOT EXISTS demo_deadline_ledger (
  demo_id uuid PRIMARY KEY REFERENCES internal_demo_scopes(demo_id),
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id),
  room_name text NOT NULL,
  reservation_id uuid NOT NULL REFERENCES voice_start_reservations(id),
  deadline_at timestamptz NOT NULL,
  phase text NOT NULL CHECK (phase IN ('setup', 'active')),
  state text NOT NULL CHECK (state IN ('active', 'closing', 'ended')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_deadline_due_idx ON demo_deadline_ledger (deadline_at) WHERE state = 'active';

CREATE OR REPLACE FUNCTION upsert_demo_deadline(
  p_demo_id uuid, p_scope uuid, p_room text, p_reservation uuid,
  p_deadline timestamptz, p_phase text, p_state text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  IF p_state NOT IN ('active', 'ended') OR p_phase NOT IN ('setup', 'active') OR p_deadline IS NULL OR length(p_room) > 128 THEN
    RAISE EXCEPTION 'invalid deadline record';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.internal_demo_scopes WHERE demo_id = p_demo_id AND owner_scope_id = p_scope) THEN
    RAISE EXCEPTION 'demo scope mismatch';
  END IF;
  INSERT INTO public.demo_deadline_ledger
    (demo_id, owner_scope_id, room_name, reservation_id, deadline_at, phase, state)
  VALUES (p_demo_id, p_scope, p_room, p_reservation, p_deadline, p_phase, p_state)
  ON CONFLICT (demo_id) DO UPDATE SET
    deadline_at = CASE WHEN public.demo_deadline_ledger.state IN ('closing', 'ended') THEN public.demo_deadline_ledger.deadline_at ELSE EXCLUDED.deadline_at END,
    phase = CASE WHEN public.demo_deadline_ledger.state IN ('closing', 'ended') THEN public.demo_deadline_ledger.phase ELSE EXCLUDED.phase END,
    state = CASE WHEN public.demo_deadline_ledger.state = 'ended' THEN 'ended' ELSE EXCLUDED.state END,
    updated_at = now()
  WHERE public.demo_deadline_ledger.owner_scope_id = EXCLUDED.owner_scope_id
    AND public.demo_deadline_ledger.room_name = EXCLUDED.room_name
    AND public.demo_deadline_ledger.reservation_id = EXCLUDED.reservation_id
    AND ((public.demo_deadline_ledger.state = 'closing' AND EXCLUDED.state = 'ended')
      OR public.demo_deadline_ledger.state = 'ended'
      OR (public.demo_deadline_ledger.phase = EXCLUDED.phase AND public.demo_deadline_ledger.deadline_at = EXCLUDED.deadline_at)
      OR (public.demo_deadline_ledger.state = 'active' AND public.demo_deadline_ledger.phase = 'setup' AND EXCLUDED.phase = 'active'))
    AND NOT (public.demo_deadline_ledger.state = 'closing' AND EXCLUDED.state = 'active');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'deadline binding conflict'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION list_due_demo_deadlines(p_now timestamptz)
RETURNS TABLE(demo_id uuid, owner_scope_id uuid, room_name text, reservation_id uuid, deadline_at timestamptz, phase text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH due AS (
    SELECT d.demo_id FROM public.demo_deadline_ledger d
    WHERE d.state IN ('active', 'closing') AND d.deadline_at <= p_now
    ORDER BY d.deadline_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.demo_deadline_ledger d SET state = 'closing', updated_at = now()
  FROM due WHERE d.demo_id = due.demo_id
  RETURNING d.demo_id, d.owner_scope_id, d.room_name, d.reservation_id, d.deadline_at, d.phase;
$$;

REVOKE ALL ON FUNCTION upsert_demo_deadline(uuid,uuid,text,uuid,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_demo_deadlines(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_demo_deadline(uuid,uuid,text,uuid,timestamptz,text,text) TO frontline_app;
GRANT EXECUTE ON FUNCTION list_due_demo_deadlines(timestamptz) TO frontline_app;

COMMIT;
