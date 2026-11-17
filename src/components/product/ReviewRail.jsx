import { SCREENS, STATES } from '../../pages/Experience.jsx';

export default function ReviewRail({ open, screen, state, onScreen, onState, onClose }) {
  if (!open) return null;
  return <aside className="review-rail" aria-label="Review mode state switcher">
    <div className="review-head"><div><span className="eyebrow">Reviewer controls</span><h2>Screen & state</h2></div><button onClick={onClose} aria-label="Close review mode">×</button></div>
    <p>This panel changes the prototype only. It is not part of the customer product.</p>
    <label>Journey screen<select value={screen} onChange={e => onScreen(e.target.value)}>{SCREENS.map(([id, name]) => <option key={id} value={id}>{id} · {name}</option>)}</select></label>
    <fieldset><legend>Screen state</legend>{STATES[screen].map(item => <label className="radio" key={item}><input type="radio" name="state" checked={state === item} onChange={() => onState(item)} /><span>{item}</span></label>)}</fieldset>
    <div className="review-rail__note"><strong>Truthful boundary</strong><br/>Voice, crawl, authentication and number provisioning are interface simulations. No external service is contacted.</div>
  </aside>;
}
