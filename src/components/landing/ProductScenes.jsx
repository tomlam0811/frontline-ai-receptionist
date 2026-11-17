import './scenes.css';

// Visual recreations of real Frontline screens, drawn with generic states only: no business names, no
// customer details, no records. Text on them is the product's own text. They are pictures of the product,
// so they are hidden from assistive technology and hold no buttons or links. The page text next to each
// one says the same thing in words.

const WAVE_BARS = Array.from({ length: 30 }, (_, index) => {
  const height = 0.22 + 0.78 * Math.abs(Math.sin(index * 0.83) * Math.cos(index * 0.31));
  return {
    '--hi': height.toFixed(3),
    '--lo': (height * 0.42).toFixed(3),
    '--dur': `${(0.85 + ((index * 37) % 7) * 0.12).toFixed(2)}s`,
    '--delay': `-${(((index * 53) % 9) * 0.13).toFixed(2)}s`,
  };
});

/** The live call screen while Blake listens. The bars move only while the scene is on screen. */
export function CallScene() {
  return <div className="sc sc-call" data-live aria-hidden="true">
    <p className="sc-call__label">Call with Blake</p>
    <div className="sc-call__panel">
      <div className="sc-call__state"><span className="sc-call__light" /><span>Blake is listening</span></div>
      <div className="sc-wave">{WAVE_BARS.map((style, index) => <span key={index} style={style} />)}</div>
      <div className="sc-call__actions"><span className="sc-call__button">Mute</span><span className="sc-call__button sc-call__button--end">End call</span></div>
    </div>
  </div>;
}

const REQUEST_FIELDS = [['Name', 46], ['Phone', 38], ['Service', 62], ['Property city', 44], ['Preferred day', 40], ['Preferred time', 34], ['Notes', 72]];

/** The saved-request card with its real field labels and empty values. */
export function RequestScene() {
  return <div className="sc sc-card sc-request" aria-hidden="true">
    <p className="sc-title sc-title--first">Service request</p>
    <dl>{REQUEST_FIELDS.map(([label, width]) => <div key={label}><dt>{label}</dt><dd><span className="sc-skeleton" style={{ width: `${width}%` }} /></dd></div>)}</dl>
  </div>;
}

/** Captions during the call. The lines appear one after another while the scene is on screen. */
export function CaptionsScene() {
  return <div className="sc sc-card sc-captions" data-live aria-hidden="true">
    <p className="sc-title sc-title--first">Captions</p>
    <ol>
      <li><strong>Blake</strong><p><span className="sc-skeleton" style={{ width: '92%' }} /><span className="sc-skeleton" style={{ width: '58%' }} /></p></li>
      <li><strong>You</strong><p><span className="sc-skeleton" style={{ width: '76%' }} /></p></li>
      <li><strong>Blake</strong><p><span className="sc-skeleton" style={{ width: '88%' }} /><span className="sc-skeleton" style={{ width: '40%' }} /></p></li>
    </ol>
  </div>;
}

const READING_STATUSES = ['Reading your website.', 'Finding the details callers ask about.', 'Confirming the business.', 'Almost ready.'];

/** The website reading screen. Each line settles in turn while the scene is on screen. */
export function ReadingScene() {
  return <div className="sc sc-card sc-reading" data-live aria-hidden="true">
    <p className="sc-fieldlabel">Business website</p>
    <div className="sc-input"><span>yourbusiness.com</span></div>
    <div className="sc-reading__head"><span className="sc-avatar sc-avatar--small" /><p className="sc-title">Getting the receptionist ready.</p></div>
    <ul>{READING_STATUSES.map((text) => <li key={text}><span className="sc-tick"><i /><b>&#10003;</b></span>{text}</li>)}</ul>
  </div>;
}

/** The Meet Blake screen that comes before the demo call. */
export function MeetBobScene() {
  return <div className="sc sc-card sc-meet" aria-hidden="true">
    <div className="sc-identity">
      <span className="sc-avatar">B</span>
      <p className="sc-heading">Meet Blake</p>
    </div>
    <p className="sc-body">Talk to Blake the way a customer would.</p>
    <span className="sc-button">Talk to Blake</span>
  </div>;
}

/** The account step after the demo call. */
export function SaveScene() {
  return <div className="sc sc-card sc-save" aria-hidden="true">
    <p className="sc-heading">Save Blake for your business.</p>
    <p className="sc-body">Create an account to save Blake and this call.</p>
    <span className="sc-button">Continue with Google</span>
  </div>;
}

const ADD_METHODS = [['Type', 'Up to 10,000 characters'], ['Dictate', 'Up to 2 minutes'], ['Upload a file', 'PDF, Word or text files up to 5 MB'], ['Add a web address', 'One public page']];

/** The step where the owner adds more about the business. */
export function AddInfoScene() {
  return <div className="sc sc-card sc-add" aria-hidden="true">
    <p className="sc-heading">Anything else Blake should know?</p>
    <p className="sc-body">Add anything the website missed.</p>
    <ul>{ADD_METHODS.map(([label, caption]) => <li key={label}><span className="sc-dot" /><span><strong>{label}</strong><small>{caption}</small></span></li>)}</ul>
  </div>;
}

/** Review of a change before Blake uses it. */
export function ReviewScene() {
  return <div className="sc sc-card sc-review" aria-hidden="true">
    <p className="sc-title sc-title--first">Review changes for Blake</p>
    <p className="sc-body">Changes take effect once you apply them.</p>
    <div className="sc-candidate">
      <p><span className="sc-tag">Add</span><span className="sc-muted">Business details</span></p>
      <span className="sc-skeleton" style={{ width: '84%' }} />
      <span className="sc-skeleton" style={{ width: '52%' }} />
      <div className="sc-choices"><span className="is-on"><i />Use this</span><span><i />Skip</span><span><i />Edit first</span></div>
    </div>
    <span className="sc-button">Apply 1 change</span>
  </div>;
}

/** The share screen. */
export function ShareScene() {
  return <div className="sc sc-card sc-share" aria-hidden="true">
    <p className="sc-title sc-title--first">Share</p>
    <p className="sc-body">This link opens Blake with the latest saved changes.</p>
    <span className="sc-button">Create link</span>
  </div>;
}
