import { useEffect, useRef, useState } from 'react';
import './landing.css';
import { ArrowIcon } from '../components/landing/ArrowIcon.jsx';
import { Logo } from '../components/landing/Logo.jsx';
import { Photo } from '../components/landing/Photo.jsx';
import { useLandingMotion } from '../components/landing/useLandingMotion.js';
import {
  AddInfoScene, CallScene, CaptionsScene, MeetBobScene, ReadingScene, RequestScene, ReviewScene, SaveScene, ShareScene,
} from '../components/landing/ProductScenes.jsx';

function normalizeWebsite(value) {
  const input = value.trim();
  if (!input || /\s/.test(input)) throw new Error('Type your website, like yourbusiness.com.');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('That address won\'t work. Type your public website, like yourbusiness.com.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
    throw new Error('That address won\'t work. Type your public website, like yourbusiness.com.');
  }
  return url.href;
}

const setupSteps = [
  {
    title: 'Add your website',
    text: 'Type your web address. Blake reads your public pages to learn about your business.',
    scene: <ReadingScene />,
  },
  {
    title: 'Talk to Blake',
    text: 'Have a short voice conversation with Blake. Talk the way your customers would.',
    scene: <MeetBobScene />,
  },
  {
    title: 'Save Blake',
    text: 'Like what you hear? Create an account with Google and Blake is saved.',
    scene: <SaveScene />,
  },
  {
    title: 'Teach Blake more',
    text: 'Add anything the website missed so Blake can answer better. Then Blake is ready to talk and share.',
    scene: <AddInfoScene />,
  },
];

/** One website form. The page has two, so every id carries the form's own prefix. */
function WebsiteForm({ prefix, website, error, onChange, onSubmit }) {
  const errorId = `${prefix}-website-error`;
  return <form className="site-form" id={prefix === 'hero' ? 'website' : `${prefix}-form`} onSubmit={onSubmit} noValidate>
    <label htmlFor={`${prefix}-website`}>Business website</label>
    <div className="site-form__row">
      <input id={`${prefix}-website`} name="website" type="text" inputMode="url" autoComplete="url" placeholder="yourbusiness.com" value={website} onChange={onChange} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />
      <button className="landing-button" type="submit">Try Blake <ArrowIcon /></button>
    </div>
    {error && <p className="site-form__error" id={errorId} role="alert">{error}</p>}
  </form>;
}

/**
 * PO-D12. After an account is deleted the browser lands on `/?account=deleted`. The confirmation shows once, and the
 * address loses the parameter so a reload or a shared link does not show it again. It is read after the first render,
 * so the prerendered markup still hydrates unchanged.
 */
function useAccountDeletedNotice() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('account') !== 'deleted') return;
    url.searchParams.delete('account');
    try { window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* the notice still shows */ }
    setShown(true);
  }, []);
  return shown;
}

export default function Landing({ onPrepare, initialWebsite = '', signInError = '' }) {
  const rootRef = useRef(null);
  const [website, setWebsite] = useState(initialWebsite);
  const [websiteError, setWebsiteError] = useState({ form: '', message: '' });
  const accountDeleted = useAccountDeletedNotice();
  useLandingMotion(rootRef);

  const submitWebsite = (form) => (event) => {
    event.preventDefault();
    let url;
    try {
      url = normalizeWebsite(website);
    } catch (error) {
      setWebsiteError({ form, message: error.message });
      return;
    }
    setWebsiteError({ form: '', message: '' });
    onPrepare(url);
  };
  const changeWebsite = (event) => { setWebsite(event.target.value); setWebsiteError({ form: '', message: '' }); };
  const errorFor = (form) => (websiteError.form === form ? websiteError.message : '');

  return <div className="landing" ref={rootRef}>
    <header className="landing-header">
      <a href="/" aria-label="Frontline home"><Logo /></a>
      <a className="landing-header__signin" href="/app">Sign in</a>
      <a className="landing-header__cta" href="#website">Try Blake</a>
    </header>

    <main id="top">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__photo">
          <Photo photo="serviceCall" priority sizes="100vw" alt="A technician repairs a furnace while a customer watches. A phone on the toolbox shows an incoming call." />
        </div>
        <div className="hero__inner">
          <div className="hero__copy">
            {signInError && <p className="landing-notice" role="alert">{signInError}</p>}
            {accountDeleted && <p className="landing-notice" role="status">Your account was deleted. Thank you for trying Frontline.</p>}
            <h1 id="hero-title"><span>Miss fewer</span>{' '}<span>customer calls</span></h1>
            <p className="hero__lead">An AI receptionist that answers customer questions from your website and saves their details when you&apos;re busy.</p>
            <WebsiteForm prefix="hero" website={website} error={errorFor('hero')} onChange={changeWebsite} onSubmit={submitWebsite('hero')} />
          </div>
        </div>
      </section>

      <section className="pain" aria-labelledby="pain-title">
        <div className="pain__inner">
          <h2 id="pain-title" data-reveal>Work keeps you away from the phone</h2>
          <div className="pain__grid">
            <article className="pain-card" data-reveal>
              <div className="crop"><Photo photo="withCustomer" sizes="(max-width: 700px) 92vw, 33vw" alt="A technician explains a written estimate to a homeowner in her kitchen while a phone rings on the counter." /></div>
              <h3>With a customer</h3>
              <p>You&apos;re in the middle of an estimate or talking with someone in person. Answering the phone means cutting them off.</p>
            </article>
            <article className="pain-card" data-reveal style={{ '--d': '120ms' }}>
              <div className="crop"><Photo photo="onTheRoad" sizes="(max-width: 700px) 92vw, 33vw" alt="A technician drives a work van down a residential street while a phone on the dashboard shows an incoming call." /></div>
              <h3>On the road</h3>
              <p>You&apos;re between jobs and behind the wheel. Picking up means pulling over, or calling back once you arrive.</p>
            </article>
            <article className="pain-card" data-reveal style={{ '--d': '240ms' }}>
              <div className="crop"><Photo photo="underSink" sizes="(max-width: 700px) 92vw, 33vw" alt="A plumber lies under a kitchen sink working on the pipes while a phone rings on the floor beside his tools." /></div>
              <h3>On the job</h3>
              <p>You&apos;re on a ladder, under a sink or halfway through a repair. The phone rings and nobody is free to answer.</p>
            </article>
          </div>
          <p className="pain__result" data-reveal>Callers who reach voicemail often try the next business.</p>
        </div>
      </section>

      <section className="product" aria-labelledby="product-title">
        <div className="product__band">
          <Photo photo="afterHours" sizes="100vw" alt="A service office at dusk. An owner puts on her jacket beside a desk phone." />
          <div className="product__band-copy" data-reveal>
            <h2 id="product-title">How Blake handles a call</h2>
          </div>
        </div>
        <div className="product__rows">
          <div className="feature">
            <div className="feature__copy" data-reveal>
              <h3>Knows your business</h3>
              <p>Blake answers from what you&apos;ve told him, such as your services, hours, service area and policies. When he doesn&apos;t know something, he says so.</p>
            </div>
            <div className="feature__stage" data-reveal style={{ '--d': '100ms' }}><CallScene /></div>
          </div>
          <div className="feature feature--flip">
            <div className="feature__copy" data-reveal>
              <h3>Takes a request</h3>
              <p>When a caller needs help, Blake asks for the caller&apos;s name, how to reach them and what they need. Then he saves the request for you. Nothing gets booked or sent.</p>
            </div>
            <div className="feature__stage" data-reveal style={{ '--d': '100ms' }}><RequestScene /></div>
          </div>
          <div className="feature">
            <div className="feature__copy" data-reveal>
              <h3>Shows what was said</h3>
              <p>Captions appear as the call happens. Afterward, each call has a summary and a transcript.</p>
            </div>
            <div className="feature__stage" data-reveal style={{ '--d': '100ms' }}><CaptionsScene /></div>
          </div>
        </div>
      </section>

      <section className="setup" aria-labelledby="setup-title">
        <div className="setup__inner">
          <h2 id="setup-title" data-reveal>Set up Blake in four steps</h2>
          <ol className="setup-steps" data-steps>
            {setupSteps.map((step, index) => <li className="setup-step" data-step key={step.title}>
              <span className="setup-step__marker" aria-hidden="true">{index + 1}</span>
              <div className="setup-step__copy">
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
              <div className="setup-step__stage" data-reveal>{step.scene}</div>
            </li>)}
          </ol>
        </div>
      </section>

      <section className="control" aria-labelledby="control-title">
        <div className="control__inner">
          <div className="control__copy">
            <h2 id="control-title" data-reveal>Stay in control</h2>
            <ul>
              <li data-reveal style={{ '--d': '80ms' }}>
                <h3>Review changes</h3>
                <p>Everything you add shows up for review first. Blake uses a change after you apply it.</p>
              </li>
              <li data-reveal style={{ '--d': '160ms' }}>
                <h3>Talk to Blake</h3>
                <p>Call Blake from your browser and hear how he answers with your latest changes.</p>
              </li>
              <li data-reveal style={{ '--d': '240ms' }}>
                <h3>Share a link</h3>
                <p>Send the link to anyone who should try Blake. They get one conversation of up to 5 minutes and need no account. Revoke a link any time.</p>
              </li>
              <li data-reveal style={{ '--d': '360ms' }}>
                <h3>Go live</h3>
                <p>Ready for real calls? Contact the Frontline team from Blake&apos;s page to set up your phone number.</p>
              </li>
            </ul>
          </div>
          <div className="control__stage" data-reveal style={{ '--d': '120ms' }}>
            <ReviewScene />
            <ShareScene />
          </div>
        </div>
      </section>

      <section className="closing" aria-labelledby="closing-title">
        <div className="closing__inner">
          <div className="closing__copy" data-reveal>
            <h2 id="closing-title">Hear Blake answer for your business</h2>
            <WebsiteForm prefix="closing" website={website} error={errorFor('closing')} onChange={changeWebsite} onSubmit={submitWebsite('closing')} />
          </div>
        </div>
        <div className="closing__photo" data-reveal style={{ '--d': '120ms' }}>
          <Photo photo="betweenJobs" sizes="(max-width: 900px) 92vw, 44vw" alt="A technician checks a work order beside his service van. A phone on the van's dashboard shows an incoming call." />
        </div>
      </section>
    </main>
    <footer><Logo /></footer>
  </div>;
}
