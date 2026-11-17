BEGIN;

-- Metadata only. The submitted URL and extracted facts stay in the RLS-scoped
-- workspace document; the runtime role can use only the narrow functions below.
CREATE TABLE IF NOT EXISTS preparation_jobs (
  id uuid PRIMARY KEY,
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id),
  client_hash text NOT NULL CHECK (length(client_hash) = 64),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'complete', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reconciled_at timestamptz
);
CREATE INDEX IF NOT EXISTS preparation_jobs_available_idx ON preparation_jobs (available_at, created_at) WHERE state IN ('queued', 'leased');
CREATE INDEX IF NOT EXISTS preparation_jobs_client_idx ON preparation_jobs (client_hash, created_at);
CREATE INDEX IF NOT EXISTS preparation_jobs_scope_idx ON preparation_jobs (owner_scope_id, created_at);

CREATE OR REPLACE FUNCTION admit_preparation_job(p_id uuid, p_scope uuid, p_client_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_now timestamptz := now();
BEGIN
  IF p_id IS NULL OR p_scope IS NULL OR p_client_hash !~ '^[a-f0-9]{64}$' THEN RETURN 'invalid_admission'; END IF;
  PERFORM pg_advisory_xact_lock(46298131839);
  IF NOT EXISTS (SELECT 1 FROM public.ownership_scopes WHERE id = p_scope AND kind = 'anonymous' AND state = 'anonymous' AND expires_at > v_now) THEN
    RETURN 'workspace_unavailable';
  END IF;
  -- In-flight jobs cannot be bypassed by rotating anonymous cookies. This
  -- counter includes leases until final completion, including after restarts.
  IF (SELECT count(*) FROM public.preparation_jobs WHERE state IN ('queued', 'leased')) >= 8
     OR (SELECT count(*) FROM public.preparation_jobs WHERE client_hash = p_client_hash AND state IN ('queued', 'leased')) >= 1
     OR (SELECT count(*) FROM public.preparation_jobs WHERE owner_scope_id = p_scope AND state IN ('queued', 'leased')) >= 1 THEN
    RETURN 'inspection_busy';
  END IF;
  IF (SELECT count(*) FROM public.preparation_jobs WHERE created_at > v_now - interval '1 minute') >= 60
     OR (SELECT count(*) FROM public.preparation_jobs WHERE client_hash = p_client_hash AND created_at > v_now - interval '1 minute') >= 6
     OR (SELECT count(*) FROM public.preparation_jobs WHERE owner_scope_id = p_scope AND created_at > v_now - interval '1 day') >= 12 THEN
    RETURN 'rate_limited';
  END IF;
  INSERT INTO public.preparation_jobs (id, owner_scope_id, client_hash, state) VALUES (p_id, p_scope, p_client_hash, 'queued');
  RETURN 'admitted';
END;
$$;

CREATE OR REPLACE FUNCTION lease_preparation_job(p_lease_seconds integer)
RETURNS TABLE(job_id uuid, owner_scope_id uuid, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 300 THEN RETURN; END IF;
  RETURN QUERY
  WITH selected AS (
    SELECT j.id FROM public.preparation_jobs j
    JOIN public.ownership_scopes o ON o.id = j.owner_scope_id
    WHERE ((j.state = 'queued' AND j.available_at <= now()) OR (j.state = 'leased' AND j.lease_until <= now()))
      AND j.attempts < 3 AND o.kind = 'anonymous' AND o.state = 'anonymous' AND o.expires_at > now()
    ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
  )
  UPDATE public.preparation_jobs j SET state = 'leased', attempts = attempts + 1,
    lease_token = gen_random_uuid(), lease_until = now() + make_interval(secs => p_lease_seconds)
  FROM selected WHERE j.id = selected.id
  RETURNING j.id, j.owner_scope_id, j.lease_token;
END;
$$;

CREATE OR REPLACE FUNCTION renew_preparation_lease(p_id uuid, p_token uuid, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 300 THEN RETURN false; END IF;
  UPDATE public.preparation_jobs SET lease_until = now() + make_interval(secs => p_lease_seconds)
    WHERE id = p_id AND lease_token = p_token AND state = 'leased' AND lease_until > now()
      AND EXISTS (SELECT 1 FROM public.ownership_scopes o
        WHERE o.id = owner_scope_id AND o.kind = 'anonymous'
          AND o.state = 'anonymous' AND o.expires_at > now());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION settle_preparation_job(p_id uuid, p_token uuid, p_success boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.preparation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.preparation_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_job.state <> 'leased' OR v_job.lease_token <> p_token OR v_job.lease_until <= now()
     OR NOT EXISTS (SELECT 1 FROM public.ownership_scopes o
       WHERE o.id = v_job.owner_scope_id AND o.kind = 'anonymous'
         AND o.state = 'anonymous' AND o.expires_at > now()) THEN RETURN 'stale'; END IF;
  IF p_success THEN
    UPDATE public.preparation_jobs SET state = 'complete', lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = p_id;
    RETURN 'complete';
  ELSIF v_job.attempts >= 3 THEN
    UPDATE public.preparation_jobs SET state = 'failed', lease_token = NULL, lease_until = NULL, finished_at = now() WHERE id = p_id;
    RETURN 'failed';
  ELSE
    UPDATE public.preparation_jobs SET state = 'queued', lease_token = NULL, lease_until = NULL,
      available_at = now() + make_interval(secs => CASE WHEN v_job.attempts = 1 THEN 15 ELSE 60 END) WHERE id = p_id;
    RETURN 'retry';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION list_terminal_preparation_jobs()
RETURNS TABLE(job_id uuid, owner_scope_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.preparation_jobs SET state = 'failed', lease_token = NULL, lease_until = NULL, finished_at = now()
    WHERE state = 'leased' AND lease_until <= now() AND attempts >= 3;
  RETURN QUERY SELECT j.id, j.owner_scope_id FROM public.preparation_jobs j
    JOIN public.ownership_scopes o ON o.id = j.owner_scope_id
    WHERE j.state = 'failed' AND j.reconciled_at IS NULL AND o.state = 'anonymous' AND o.expires_at > now()
    ORDER BY j.finished_at LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION acknowledge_terminal_preparation_job(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.preparation_jobs SET reconciled_at = now()
    WHERE id = p_id AND state = 'failed' AND reconciled_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

REVOKE ALL ON preparation_jobs FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_preparation_job(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lease_preparation_job(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION renew_preparation_lease(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_preparation_job(uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_terminal_preparation_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION acknowledge_terminal_preparation_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admit_preparation_job(uuid,uuid,text) TO frontline_app;
GRANT EXECUTE ON FUNCTION lease_preparation_job(integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION renew_preparation_lease(uuid,uuid,integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION settle_preparation_job(uuid,uuid,boolean) TO frontline_app;
GRANT EXECUTE ON FUNCTION list_terminal_preparation_jobs() TO frontline_app;
GRANT EXECUTE ON FUNCTION acknowledge_terminal_preparation_job(uuid) TO frontline_app;

COMMIT;
