import { useMemo, useState } from 'react';
import { ownerApi } from '../../lib/owner-api.js';
import { receptionistName } from '../../lib/receptionist-name.js';
import { Button, Loading, Notice, Shell } from '../../components/owner/ui.jsx';
import { useLoad, usePageTitle } from '../../components/owner/hooks.js';
import { AccessGate, BackToBob, useBobSummary } from '../../components/owner/BobFrame.jsx';
import ChooseKnowledgeDialog from '../../components/owner/ChooseKnowledgeDialog.jsx';
import { countFactsBySource } from '../../components/owner/source-names.js';
import SourceRow from '../../components/owner/SourceRow.jsx';
import { errorMessage } from './error-copy.js';
import './knowledge.css';

// MR-S5. What one receptionist knows: the business sources it uses, and "Choose sources" to change them.
// The business library itself (every source, its facts, adding and removing) is /app/knowledge.

/** @param {{agentId: string, signIn?: () => void}} props */
export default function ReceptionistKnowledge({ agentId, signIn }) {
  const bob = useBobSummary(agentId);
  const ok = bob.access === 'ok';
  const knowledge = useLoad((signal) => (ok ? ownerApi.getKnowledge(agentId, signal) : Promise.resolve(null)), [agentId, ok]);
  const [choosing, setChoosing] = useState(false);
  const name = receptionistName(bob.summary);
  usePageTitle('Knowledge', bob.status !== 'loading' && (!ok || knowledge.status !== 'loading'));

  const data = knowledge.data;
  const factCounts = useMemo(() => countFactsBySource(data?.categories ?? []), [data]);
  const erasing = useMemo(() => new Set((data?.sourceErasures ?? []).map((job) => job.sourceId)), [data]);
  const chooseFrom = useMemo(() => (data?.sources ?? []).filter((source) => !erasing.has(source.sourceId)), [data, erasing]);
  const used = useMemo(() => chooseFrom.filter((source) => data.sourceIds.includes(source.sourceId)), [data, chooseFrom]);
  const blocked = bob.status === 'error' || (bob.status === 'ready' && !ok);
  const reload = () => { knowledge.reload(); bob.reload(); };

  return <Shell wide>
    {bob.status === 'loading' && <><h1>Knowledge</h1><Loading>Loading Knowledge…</Loading></>}
    {blocked && <AccessGate bob={bob} signIn={signIn} />}
    {ok && <>
      <BackToBob agentId={agentId} name={name} />
      <div className="owner-page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="owner-lede">{`What ${name} knows about your business.`}</p>
        </div>
        {data && <Button aria-haspopup="dialog" onClick={() => setChoosing(true)}>Choose sources</Button>}
      </div>
      {knowledge.status === 'loading' && !data && <Loading>Loading Knowledge…</Loading>}
      {knowledge.status === 'error' && !data && <Notice kind="error" title="Couldn't load Knowledge." action={<Button variant="secondary" onClick={knowledge.reload}>Try again</Button>}>{errorMessage(knowledge.error)}</Notice>}
      {data && used.length === 0 && <p className="owner-muted">{`${name} needs knowledge before it can take calls. Choose at least one source.`}</p>}
      {data && used.length > 0 && <section className="owner-sources" aria-label="Sources">
        <ul className="owner-source-list" aria-label="Sources">
          {used.map((source) => <SourceRow key={source.sourceId} source={source} detailCount={factCounts.get(source.sourceId) ?? 0} />)}
        </ul>
      </section>}
      {choosing && data && <ChooseKnowledgeDialog agentId={agentId} name={name} sources={chooseFrom} selectedIds={data.sourceIds} factCounts={factCounts}
        versionId={data.currentAgentVersionId} onClose={() => setChoosing(false)} onSaved={() => { setChoosing(false); reload(); }} onReload={() => { setChoosing(false); reload(); }} />}
    </>}
  </Shell>;
}
