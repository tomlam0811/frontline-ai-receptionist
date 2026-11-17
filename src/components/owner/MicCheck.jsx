import { useState } from 'react';
import { Button, Notice } from './ui.jsx';

// The guest microphone check (design spec PO-S7). It asks the browser for the microphone once, stops it at once,
// and reports whether the guest can start. A denied microphone never touches the link: it stays unused.

function denied(error) { return ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name); }

/** @param {{onReadyChange: (ready: boolean) => void, disabled?: boolean, name?: string}} props */
export default function MicCheck({ onReadyChange, disabled = false, name = 'The receptionist' }) {
  const [state, setState] = useState('idle');
  const [problem, setProblem] = useState('');

  async function check() {
    setState('checking'); setProblem(''); onReadyChange(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no microphone api'), { name: 'NotFoundError' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setState('ready'); onReadyChange(true);
    } catch (error) {
      setState('problem');
      setProblem(denied(error)
        ? 'The browser blocked the microphone. Allow it in the address bar or browser settings, then check again.'
        : error?.name === 'NotReadableError' ? 'Another app is using the microphone. Close that app, then check again.'
          : 'No microphone found. Connect one, then check again.');
    }
  }

  return <section className="owner-card" aria-labelledby="owner-mic-title">
    <h2 id="owner-mic-title">Check your microphone</h2>
    {state === 'idle' && <p>{`${name} needs your microphone to hear you. Check it before you start.`}</p>}
    {state === 'checking' && <p role="status">Allow the microphone when your browser asks.</p>}
    {state === 'ready' && <p role="status">Microphone ready.</p>}
    {state === 'problem' && <Notice kind="error">{problem}</Notice>}
    {state !== 'ready' && <div className="owner-actions"><Button variant="secondary" busy={state === 'checking'} disabled={disabled} onClick={check}>{state === 'problem' ? 'Check again' : 'Check my microphone'}</Button></div>}
  </section>;
}
