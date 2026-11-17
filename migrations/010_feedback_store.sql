BEGIN;

-- Global feedback store. The builder reads across owners, so these tables are not
-- part of any owner scope. frontline_app reaches them only through the functions
-- below. Retention (expires_at) is 30 days (PO-OQ5); the cleanup function that
-- deletes expired rows arrives with the retention migration.
CREATE TABLE frontline_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('owner','guest')),
  input_method text NOT NULL CHECK (input_method IN ('text','dictation')),
  category text NOT NULL CHECK (category IN ('business_context','quality','functionality','other')),
  submitted_text text NOT NULL CHECK (char_length(submitted_text) BETWEEN 1 AND 10000),
  original_transcript text CHECK (original_transcript IS NULL OR char_length(original_transcript) <= 10000),
  owner_scope_id uuid NOT NULL REFERENCES ownership_scopes(id),
  stable_agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  conversation_id uuid,
  linked_knowledge_update_id uuid,
  creator_kind text NOT NULL CHECK (creator_kind IN ('owner','guest_session')),
  creator_ref text NOT NULL CHECK (length(creator_ref) = 64),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','resolved')),
  revision integer NOT NULL DEFAULT 1,
  derived_summary text,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  payload_digest text NOT NULL CHECK (length(payload_digest) = 64),
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', submitted_text)) STORED,
  expires_at timestamptz NOT NULL,
  CHECK ((creator_kind = 'owner') = (source = 'owner')),
  UNIQUE (owner_scope_id, creator_ref, idempotency_key)
);
CREATE INDEX frontline_feedback_search_idx ON frontline_feedback USING gin (search);
CREATE INDEX frontline_feedback_created_idx ON frontline_feedback (created_at DESC, id DESC);
CREATE INDEX frontline_feedback_filter_idx ON frontline_feedback (category, source, status);
CREATE INDEX frontline_feedback_agent_idx ON frontline_feedback (stable_agent_id, created_at DESC);
CREATE INDEX frontline_feedback_expiry_idx ON frontline_feedback (expires_at);

CREATE TABLE frontline_feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES frontline_feedback(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner','guest_session','builder')),
  actor_ref text NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted','status_changed')),
  from_status text,
  to_status text
);
CREATE INDEX frontline_feedback_events_idx ON frontline_feedback_events (feedback_id, at);
REVOKE ALL ON frontline_feedback, frontline_feedback_events FROM PUBLIC;

-- Owner or guest submit. The caller (API) has already resolved the owner or guest
-- capability and set app.owner_scope_id for the transaction.
-- Errors: 'owner scope mismatch' (42501), 'idempotency_conflict' (23505).
CREATE FUNCTION submit_feedback(
  p_scope uuid, p_stable_agent_id uuid, p_agent_version_id uuid, p_conversation_id uuid,
  p_source text, p_input_method text, p_category text, p_text text, p_original_transcript text,
  p_creator_kind text, p_creator_ref text, p_key text, p_digest text, p_expires_at timestamptz,
  p_linked_update uuid DEFAULT NULL
) RETURNS TABLE(id uuid, created_at timestamptz, category text, status text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row public.frontline_feedback%ROWTYPE;
BEGIN
  IF p_scope::text IS DISTINCT FROM current_setting('app.owner_scope_id', true) THEN
    RAISE EXCEPTION 'owner scope mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.frontline_feedback AS f
    (source, input_method, category, submitted_text, original_transcript, owner_scope_id,
     stable_agent_id, agent_version_id, conversation_id, linked_knowledge_update_id,
     creator_kind, creator_ref, idempotency_key, payload_digest, expires_at)
  VALUES (p_source, p_input_method, p_category, p_text, p_original_transcript, p_scope,
     p_stable_agent_id, p_agent_version_id, p_conversation_id, p_linked_update,
     p_creator_kind, p_creator_ref, p_key, p_digest, p_expires_at)
  ON CONFLICT (owner_scope_id, creator_ref, idempotency_key) DO NOTHING
  RETURNING f.* INTO v_row;
  IF v_row.id IS NOT NULL THEN
    INSERT INTO public.frontline_feedback_events(feedback_id, actor_kind, actor_ref, action, to_status)
      VALUES (v_row.id, p_creator_kind, p_creator_ref, 'submitted', 'new');
    RETURN QUERY SELECT v_row.id, v_row.created_at, v_row.category, v_row.status, false;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM public.frontline_feedback f
   WHERE f.owner_scope_id = p_scope AND f.creator_ref = p_creator_ref AND f.idempotency_key = p_key;
  IF v_row.payload_digest <> p_digest THEN
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_row.id, v_row.created_at, v_row.category, v_row.status, true;
END;
$$;

-- Read-only record shape shared by search and get. It excludes the owner scope id,
-- creator reference, idempotency data and payload digest.
CREATE FUNCTION builder_search_feedback(
  p_credential_hash text, p_session_hash text,
  p_q text, p_category text, p_stable_agent_id uuid, p_agent_version_id uuid,
  p_conversation_id uuid, p_source text, p_status text, p_since timestamptz,
  p_cursor_created_at timestamptz, p_cursor_id uuid, p_limit integer
) RETURNS TABLE(
  id uuid, schema_version integer, created_at timestamptz, updated_at timestamptz,
  source text, input_method text, category text, submitted_text text, original_transcript text,
  stable_agent_id uuid, agent_version_id uuid, conversation_id uuid,
  linked_knowledge_update_id uuid, status text, revision integer, derived_summary text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
BEGIN
  PERFORM public.builder_resolve_subject(p_credential_hash, p_session_hash);
  RETURN QUERY
  SELECT f.id, f.schema_version, f.created_at, f.updated_at, f.source, f.input_method, f.category,
         f.submitted_text, f.original_transcript, f.stable_agent_id, f.agent_version_id,
         f.conversation_id, f.linked_knowledge_update_id, f.status, f.revision, f.derived_summary
    FROM public.frontline_feedback f
   WHERE f.expires_at > now()
     AND (p_q IS NULL OR f.search @@ websearch_to_tsquery('simple', p_q))
     AND (p_category IS NULL OR f.category = p_category)
     AND (p_stable_agent_id IS NULL OR f.stable_agent_id = p_stable_agent_id)
     AND (p_agent_version_id IS NULL OR f.agent_version_id = p_agent_version_id)
     AND (p_conversation_id IS NULL OR f.conversation_id = p_conversation_id)
     AND (p_source IS NULL OR f.source = p_source)
     AND (p_status IS NULL OR f.status = p_status)
     AND (p_since IS NULL OR f.created_at >= p_since)
     AND (p_cursor_created_at IS NULL OR (f.created_at, f.id) < (p_cursor_created_at, p_cursor_id))
   ORDER BY f.created_at DESC, f.id DESC
   LIMIT v_limit + 1;
END;
$$;

CREATE FUNCTION builder_get_feedback(p_credential_hash text, p_session_hash text, p_id uuid)
RETURNS TABLE(
  id uuid, schema_version integer, created_at timestamptz, updated_at timestamptz,
  source text, input_method text, category text, submitted_text text, original_transcript text,
  stable_agent_id uuid, agent_version_id uuid, conversation_id uuid,
  linked_knowledge_update_id uuid, status text, revision integer, derived_summary text,
  events jsonb
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.builder_resolve_subject(p_credential_hash, p_session_hash);
  RETURN QUERY
  SELECT f.id, f.schema_version, f.created_at, f.updated_at, f.source, f.input_method, f.category,
         f.submitted_text, f.original_transcript, f.stable_agent_id, f.agent_version_id,
         f.conversation_id, f.linked_knowledge_update_id, f.status, f.revision, f.derived_summary,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('at', e.at, 'actorKind', e.actor_kind,
                    'action', e.action, 'fromStatus', e.from_status, 'toStatus', e.to_status)
                    ORDER BY e.at, e.id)
                    FROM public.frontline_feedback_events e WHERE e.feedback_id = f.id), '[]'::jsonb)
    FROM public.frontline_feedback f
   WHERE f.id = p_id AND f.expires_at > now();
END;
$$;

-- Session only: a read-only credential cannot change status (PO-R12).
-- Errors: 'builder_forbidden', 'not_found' (P0002), 'stale_revision' (40001),
-- 'invalid_transition' (22023).
CREATE FUNCTION builder_update_feedback_status(
  p_session_hash text, p_id uuid, p_expected_revision integer, p_to_status text
) RETURNS TABLE(id uuid, status text, revision integer, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_subject text; v_row public.frontline_feedback%ROWTYPE;
BEGIN
  v_subject := public.builder_resolve_subject(NULL, p_session_hash);
  SELECT * INTO v_row FROM public.frontline_feedback f
   WHERE f.id = p_id AND f.expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale_revision' USING ERRCODE = '40001';
  END IF;
  IF NOT ((v_row.status, p_to_status) IN (('new','reviewed'),('new','resolved'),
         ('reviewed','resolved'),('reviewed','new'),('resolved','reviewed'))) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023';
  END IF;
  UPDATE public.frontline_feedback f SET status = p_to_status, revision = f.revision + 1, updated_at = now()
   WHERE f.id = p_id;
  INSERT INTO public.frontline_feedback_events(feedback_id, actor_kind, actor_ref, action, from_status, to_status)
    VALUES (p_id, 'builder', encode(sha256(convert_to(v_subject, 'UTF8')), 'hex'), 'status_changed', v_row.status, p_to_status);
  RETURN QUERY SELECT f.id, f.status, f.revision, f.updated_at FROM public.frontline_feedback f WHERE f.id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION submit_feedback(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION builder_search_feedback(text, text, text, text, uuid, uuid, uuid, text, text, timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION builder_get_feedback(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION builder_update_feedback_status(text, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_feedback(uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, timestamptz, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION builder_search_feedback(text, text, text, text, uuid, uuid, uuid, text, text, timestamptz, timestamptz, uuid, integer) TO frontline_app;
GRANT EXECUTE ON FUNCTION builder_get_feedback(text, text, uuid) TO frontline_app;
GRANT EXECUTE ON FUNCTION builder_update_feedback_status(text, uuid, integer, text) TO frontline_app;

COMMIT;
