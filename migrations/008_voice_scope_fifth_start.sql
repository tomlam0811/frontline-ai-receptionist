BEGIN;

-- One additional start for the explicitly approved fifth voice reservation.
-- Preserve the independent global spend and active-concurrency checks.
DO $migration$
DECLARE
  prior_definition text := pg_get_functiondef('public.reserve_voice_start(uuid,uuid,text,integer,integer,integer,integer)'::regprocedure);
BEGIN
  IF prior_definition IS NULL OR strpos(prior_definition, 'v_scope_starts >= 4') = 0
     OR strpos(prior_definition, 'v_scope_starts >= 5') > 0 THEN
    RAISE EXCEPTION 'Unexpected voice reservation function version';
  END IF;
  EXECUTE replace(prior_definition, 'v_scope_starts >= 4', 'v_scope_starts >= 5');
END;
$migration$;

COMMIT;
