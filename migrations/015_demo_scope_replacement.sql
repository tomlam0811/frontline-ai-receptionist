BEGIN;

-- Voice worker routes find a demo's owner scope from the demo id alone. Until now that lookup only
-- resolved anonymous trial scopes, so a demo that lives in a claimed tenant scope (an owner test call
-- or a shared guest call) could not reach the worker routes. This replaces the function so it also
-- resolves claimed tenant scopes. It still returns only a scope id, and every data read that follows
-- still needs the transaction-local row level security setting. Signature and grants are unchanged.
CREATE OR REPLACE FUNCTION resolve_internal_demo_scope(p_demo_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.owner_scope_id FROM public.internal_demo_scopes s
  JOIN public.ownership_scopes o ON o.id = s.owner_scope_id
  WHERE s.demo_id = p_demo_id
    AND ((o.state = 'anonymous' AND o.expires_at > now())
      OR (o.kind = 'tenant' AND o.state = 'claimed'))
  LIMIT 1;
$$;

COMMIT;
