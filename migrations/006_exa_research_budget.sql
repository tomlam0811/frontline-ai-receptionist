BEGIN;

-- One admitted preparation can call Exa at most three times (the job retry
-- ceiling). At most ten text pages are requested per call. This rolling daily
-- admission ceiling is an operator-configured cost bound, not a price quote.
CREATE OR REPLACE FUNCTION admit_bounded_preparation_job(
  p_id uuid, p_scope uuid, p_client_hash text, p_daily_limit integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_daily_limit IS NULL OR p_daily_limit < 1 OR p_daily_limit > 10000 THEN
    RETURN 'research_unavailable';
  END IF;
  PERFORM pg_advisory_xact_lock(46298131839);
  IF (SELECT count(*) FROM public.preparation_jobs WHERE created_at > now() - interval '1 day') >= p_daily_limit THEN
    RETURN 'rate_limited';
  END IF;
  RETURN public.admit_preparation_job(p_id, p_scope, p_client_hash);
END;
$$;

REVOKE ALL ON FUNCTION admit_bounded_preparation_job(uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admit_bounded_preparation_job(uuid,uuid,text,integer) TO frontline_app;

COMMIT;
