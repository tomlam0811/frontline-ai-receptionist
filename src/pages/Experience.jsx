import { useEffect, useState } from 'react';
import ReviewRail from '../components/product/ReviewRail.jsx';
import ProductScreen from '../components/product/ProductScreen.jsx';
import '../product.css';

export const SCREENS = [
  ['S1', 'Business website'], ['S2', 'Preparing agent'], ['S3', 'Ready to try'],
  ['S4', 'Microphone check'], ['S5', 'Voice preview'], ['S6', 'Frontline close'],
  ['S7', 'Call result'], ['S8', 'Save agent'], ['S9', 'Tailored setup'], ['S10', 'Agent home'],
];

export const STATES = {
  S1: ['empty', 'error', 'back', 'no website', 'identity check'],
  S2: ['loading', 'partial', 'error', 'stale', 'resume'],
  S3: ['ready', 'partial'], S4: ['permission', 'allowed', 'denied', 'no input', 'unsupported'],
  S5: ['listening', 'thinking', 'speaking', 'reconnect', 'uncertain'],
  S6: ['wrapping up', 'grace period'], S7: ['complete', 'incomplete', 'ended early'],
  S8: ['empty', 'saving', 'saved', 'error', 'claim expiry', 'claim conflict', 'redirect recovery'],
  S9: ['recommended', 'unsaved', 'saved', 'missing info', 'provisioning', 'unsupported region', 'provisioning failure', 'active'],
  S10: ['active', 'paused', 'unsaved', 'saved', 'stale', 'provisioning issue'],
};

export default function Experience({ entry, onExit }) {
  const [screen, setScreen] = useState(entry?.kind === 'website' ? 'S2' : 'S1');
  const [state, setState] = useState(entry?.kind === 'website' ? 'loading' : entry?.kind === 'noWebsite' ? 'no website' : 'empty');
  const [reviewOpen, setReviewOpen] = useState(false);
  const go = (id, nextState) => { setScreen(id); setState(nextState || STATES[id][0]); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  useEffect(() => { if (!STATES[screen].includes(state)) setState(STATES[screen][0]); }, [screen, state]);

  return (
    <div className="product-shell">
      <a className="skip-link" href="#product-content">Skip to product</a>
      <header className="product-topbar">
        <button className="wordmark" onClick={onExit} aria-label="Frontline, back to website"><span>F</span> Frontline</button>
        <div className="preview-label"><i /> Interactive product preview <b>Simulation</b></div>
        <button className="review-toggle" onClick={() => setReviewOpen(!reviewOpen)} aria-expanded={reviewOpen}>Review mode <span>{reviewOpen ? 'Close' : 'Open'}</span></button>
      </header>
      <ReviewRail open={reviewOpen} screen={screen} state={state} onScreen={go} onState={setState} onClose={() => setReviewOpen(false)} />
      <main id="product-content" className={reviewOpen ? 'product-main rail-open' : 'product-main'}>
        <ProductScreen screen={screen} state={state} go={go} onExit={onExit} initialWebsite={entry?.website} />
      </main>
    </div>
  );
}
