BEGIN;

-- Builder access for the post-onboarding feedback store. Builders are Google
-- subjects listed in frontline_builder_subjects, which only the migration owner
-- writes (scripts/builder/add-subject.mjs). An empty table denies everyone.
-- Like the 006 auth tables, these tables get no grant to frontline_app; the
-- runtime role reaches them only through the SECURITY DEFINER functions below.
CREATE TABLE frontline_builder_subjects (
  provider_subject text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE TABLE frontline_builder_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  provider_subject text NOT NULL REFERENCES frontline_builder_subjects(provider_subject) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'feedback:read' CHECK (scope IN ('feedback:read')),
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz
);
-- One-time loopback authorization codes for the CLI login (PKCE, S256).
CREATE TABLE frontline_builder_cli_codes (
  code_hash text PRIMARY KEY CHECK (length(code_hash) = 64),
  provider_subject text NOT NULL REFERENCES frontline_builder_subjects(provider_subject) ON DELETE CASCADE,
  challenge text NOT NULL CHECK (char_length(challenge) BETWEEN 43 AND 128),
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
REVOKE ALL ON frontline_builder_subjects, frontline_builder_credentials, frontline_builder_cli_codes FROM PUBLIC;

-- Internal helper, not granted to the runtime role. Exactly one of the two hashes
-- must be supplied. Errors: 'builder_forbidden' (42501), 'credential_invalid' (28000).
CREATE FUNCTION builder_resolve_subject(p_credential_hash text, p_session_hash text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_subject text;
BEGIN
  IF (p_credential_hash IS NULL) = (p_session_hash IS NULL) THEN
    RAISE EXCEPTION 'credential_invalid' USING ERRCODE = '28000';
  END IF;
  IF p_credential_hash IS NOT NULL THEN
    IF length(p_credential_hash) <> 64 THEN RAISE EXCEPTION 'credential_invalid' USING ERRCODE = '28000'; END IF;
    UPDATE public.frontline_builder_credentials c SET last_used_at = now()
     WHERE c.token_hash = p_credential_hash AND c.revoked_at IS NULL AND c.expires_at > now()
       AND c.scope = 'feedback:read'
       AND EXISTS (SELECT 1 FROM public.frontline_builder_subjects b WHERE b.provider_subject = c.provider_subject)
     RETURNING c.provider_subject INTO v_subject;
    IF v_subject IS NULL THEN RAISE EXCEPTION 'credential_invalid' USING ERRCODE = '28000'; END IF;
    RETURN v_subject;
  END IF;
  IF length(p_session_hash) <> 64 THEN RAISE EXCEPTION 'builder_forbidden' USING ERRCODE = '42501'; END IF;
  SELECT s.provider_subject INTO v_subject FROM public.frontline_auth_sessions s
   JOIN public.frontline_builder_subjects b ON b.provider_subject = s.provider_subject
  WHERE s.secret_hash = p_session_hash AND s.revoked_at IS NULL AND s.expires_at > now();
  IF v_subject IS NULL THEN RAISE EXCEPTION 'builder_forbidden' USING ERRCODE = '42501'; END IF;
  RETURN v_subject;
END;
$$;
REVOKE ALL ON FUNCTION builder_resolve_subject(text, text) FROM PUBLIC;

CREATE FUNCTION builder_session_status(p_session_hash text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.frontline_auth_sessions s
     JOIN public.frontline_builder_subjects b ON b.provider_subject = s.provider_subject
    WHERE s.secret_hash = p_session_hash AND s.revoked_at IS NULL AND s.expires_at > now());
$$;

CREATE FUNCTION issue_builder_credential(
  p_session_hash text, p_token_hash text, p_label text, p_ttl_seconds integer
) RETURNS TABLE(id uuid, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_subject text;
BEGIN
  v_subject := public.builder_resolve_subject(NULL, p_session_hash);
  IF length(p_token_hash) <> 64 OR p_ttl_seconds < 3600 OR p_ttl_seconds > 2592000 THEN
    RAISE EXCEPTION 'invalid credential request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY INSERT INTO public.frontline_builder_credentials AS c
      (token_hash, provider_subject, label, expires_at)
    VALUES (p_token_hash, v_subject, p_label, now() + make_interval(secs => p_ttl_seconds))
    RETURNING c.id, c.expires_at;
END;
$$;

CREATE FUNCTION revoke_builder_credential(p_session_hash text, p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_subject text; v_count integer;
BEGIN
  v_subject := public.builder_resolve_subject(NULL, p_session_hash);
  UPDATE public.frontline_builder_credentials SET revoked_at = now()
   WHERE id = p_id AND provider_subject = v_subject AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Revokes the caller's own credential by its token (the CLI logout path).
CREATE FUNCTION revoke_builder_credential_by_token(p_token_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  IF length(p_token_hash) <> 64 THEN RETURN false; END IF;
  UPDATE public.frontline_builder_credentials SET revoked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

-- Called from the signed-in approval page. Stores a one-time code bound to the
-- PKCE challenge; the browser is redirected to the CLI loopback listener with it.
CREATE FUNCTION builder_cli_code_create(
  p_session_hash text, p_code_hash text, p_challenge text, p_label text, p_ttl_seconds integer
) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_subject text; v_expires timestamptz;
BEGIN
  v_subject := public.builder_resolve_subject(NULL, p_session_hash);
  IF length(p_code_hash) <> 64 OR p_ttl_seconds < 30 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'invalid code request' USING ERRCODE = '22023';
  END IF;
  v_expires := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO public.frontline_builder_cli_codes(code_hash, provider_subject, challenge, label, expires_at)
    VALUES (p_code_hash, v_subject, p_challenge, p_label, v_expires);
  RETURN v_expires;
END;
$$;

-- Called by the CLI without a session. p_challenge is base64url(sha256(verifier)),
-- computed by the API from the verifier the CLI sends. The code works once.
CREATE FUNCTION builder_cli_code_exchange(
  p_code_hash text, p_challenge text, p_token_hash text, p_ttl_seconds integer
) RETURNS TABLE(id uuid, expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_code public.frontline_builder_cli_codes%ROWTYPE;
BEGIN
  IF length(p_code_hash) <> 64 OR length(p_token_hash) <> 64
     OR p_ttl_seconds < 3600 OR p_ttl_seconds > 2592000 THEN
    RAISE EXCEPTION 'credential_invalid' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_code FROM public.frontline_builder_cli_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.consumed_at IS NOT NULL OR v_code.expires_at <= now()
     OR NOT EXISTS (SELECT 1 FROM public.frontline_builder_subjects b WHERE b.provider_subject = v_code.provider_subject) THEN
    RAISE EXCEPTION 'credential_invalid' USING ERRCODE = '28000';
  END IF;
  IF v_code.challenge <> p_challenge THEN
    -- A wrong verifier burns the code so it cannot be guessed at. This returns an empty
    -- result instead of raising, because a raise would roll the burn back.
    UPDATE public.frontline_builder_cli_codes SET consumed_at = now() WHERE code_hash = p_code_hash;
    RETURN;
  END IF;
  UPDATE public.frontline_builder_cli_codes SET consumed_at = now() WHERE code_hash = p_code_hash;
  RETURN QUERY INSERT INTO public.frontline_builder_credentials AS c
      (token_hash, provider_subject, label, expires_at)
    VALUES (p_token_hash, v_code.provider_subject, v_code.label, now() + make_interval(secs => p_ttl_seconds))
    RETURNING c.id, c.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION builder_session_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_builder_credential(text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_builder_credential(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_builder_credential_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION builder_cli_code_create(text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION builder_cli_code_exchange(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION builder_session_status(text) TO frontline_app;
GRANT EXECUTE ON FUNCTION issue_builder_credential(text, text, text, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION revoke_builder_credential(text, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION revoke_builder_credential_by_token(text) TO frontline_app;
GRANT EXECUTE ON FUNCTION builder_cli_code_create(text, text, text, text, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION builder_cli_code_exchange(text, text, text, integer) TO frontline_app;

COMMIT;
