BEGIN;

-- The prior migration defines the full security-definer reservation function.
-- Change only its per-scope daily start ceiling; its global spend and active
-- concurrency checks remain exactly as published.
DO $migration$
DECLARE
  prior_definition text := pg_get_functiondef('public.reserve_voice_start(uuid,uuid,text,integer,integer,integer,integer)'::regprocedure);
BEGIN
  IF prior_definition IS NULL OR strpos(prior_definition, 'v_scope_starts >= 3') = 0
     OR strpos(prior_definition, 'v_scope_starts >= 4') > 0 THEN
    RAISE EXCEPTION 'Unexpected voice reservation function version';
  END IF;
  EXECUTE replace(prior_definition, 'v_scope_starts >= 3', 'v_scope_starts >= 4');
END;
$migration$;

COMMIT;
