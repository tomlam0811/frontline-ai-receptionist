import { useState } from 'react';
import { ownerApi, newKey } from '../lib/owner-api.js';
import { uploadKnowledgeDocument } from '../lib/owner-uploads.js';
import { receptionistName } from '../lib/receptionist-name.js';
import { InputMethodBar, TypePanel, UrlPanel, DocumentPanel, Recorder, documentProblem } from '../components/owner/KnowledgeParts.jsx';
import '../components/product/meet-bob.css';
import './owner/knowledge.css';

const INPUTS = { text: true, url: true, document: true, dictation: true };

/** S13. A last chance to add anything the public website didn't cover, offered once right after sign-up. Optional: skipping moves straight to the agent home. Reuses the same knowledge-update capability the owner's Knowledge page uses, so anything added here shows up there as a normal pending update to review. */
export default function AdditionalInfo({ agentId, onDone, name = receptionistName() }) {
  const [panel, setPanel] = useState(null);
  const [drafts, setDrafts] = useState({ text: '', url: '', file: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);

  async function submit(fields) {
    setBusy(true); setError('');
    try {
      const base = await ownerApi.getKnowledge(agentId);
      await ownerApi.createKnowledgeUpdate(agentId, { ...fields, baseAgentVersionId: base?.data?.currentAgentVersionId, expectedPointerGeneration: base?.data?.pointerGeneration }, newKey());
      setAdded(true);
      setPanel(null);
    } catch {
      setError("Couldn't save that. Try again or skip for now.");
    } finally {
      setBusy(false);
    }
  }

  const submitText = () => (drafts.text.trim() ? submit({ inputType: 'text', text: drafts.text }) : setError('Add some text first.'));
  const submitUrl = () => {
    const address = drafts.url.trim();
    if (!/^https:\/\//.test(address)) return setError('Paste a public page that starts with https://.');
    return submit({ inputType: 'url', url: address });
  };
  const submitDocument = async () => {
    if (!drafts.file) return setError('Choose a file first.');
    const problem = documentProblem(drafts.file);
    if (problem) return setError("Couldn't use that file. Try a PDF, Word, or text file under 5 MB.");
    return submit({ inputType: 'document', uploadHandle: await uploadKnowledgeDocument(agentId, drafts.file) });
  };

  return (
    <div className="bob-page owner-shell">
      <section className="bob-intro" aria-labelledby="additional-info-title">
        <p className="bob-eyebrow">Last step</p>
        <h1 id="additional-info-title">{`Anything else ${name} should know?`}</h1>
        <p>Add anything the website missed. This step is optional, and more can be added later in Knowledge.</p>
      </section>
      <section className="bob-meet__card" aria-label="Add information">
        {added ? <p role="status">{`Saved. Review it on the Knowledge page before ${name} uses it.`}</p> : <>
          <InputMethodBar inputs={INPUTS} active={panel} onChoose={(key) => { setPanel(key); setError(''); }} />
          {panel === 'text' && <TypePanel value={drafts.text} onChange={(text) => setDrafts((current) => ({ ...current, text }))} onSubmit={submitText} busy={busy} error={error} submitLabel="Add text" name={name} />}
          {panel === 'url' && <UrlPanel value={drafts.url} onChange={(url) => setDrafts((current) => ({ ...current, url }))} onSubmit={submitUrl} busy={busy} error={error} submitLabel="Add website" />}
          {panel === 'document' && <DocumentPanel file={drafts.file} onChoose={(file) => setDrafts((current) => ({ ...current, file }))} onSubmit={submitDocument} busy={busy} error={error} submitLabel="Add file" />}
          {panel === 'dictation' && <Recorder agentId={agentId} busy={busy} onTypeInstead={() => setPanel('text')} onUse={(text) => submit({ inputType: 'dictation', text })} />}
        </>}
        <div className="bob-actions">
          {added && <button type="button" className="bob-button bob-button--primary" onClick={onDone}>Open receptionist</button>}
          {!added && <button type="button" className="bob-button bob-button--quiet" onClick={onDone}>Skip for now</button>}
        </div>
      </section>
    </div>
  );
}
