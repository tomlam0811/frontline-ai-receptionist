import { useState } from 'react';
import PreparationProgress from '../components/product/PreparationProgress.jsx';
import MeetBob from '../components/product/MeetBob.jsx';
import AdditionalInfo from './AdditionalInfo.jsx';

const SAMPLE_PROFILE = {
  businessName: 'Bayside Power Wash',
  location: 'Irvine, California',
  services: [
    { name: 'Commercial pressure washing', sourceUrl: 'https://www.example-powerwash.com/' },
    { name: 'Driveway and walkway cleaning', sourceUrl: 'https://www.example-powerwash.com/' },
  ],
};

const SAMPLE_CAPABILITIES = {
  capabilities: ['WF-01', 'WF-02', 'WF-03'].map((workflowId) => ({ workflowId, enabled: true })),
};

const SCREENS = {
  s2: {
    label: 'S2 · Generation',
    states: {
      generating: { label: 'Generating (live)', render: () => <PreparationProgress stage="researching" /> },
      blocked: { label: 'Blocked site', render: () => <PreparationProgress stage="blocked" onRetry={() => {}} onCancel={() => {}} /> },
    },
  },
  s3: {
    label: 'S3 · Generated agent preview',
    states: {
      ready: { label: 'Ready', render: () => <MeetBob profile={SAMPLE_PROFILE} readiness="ready" capabilityManifest={SAMPLE_CAPABILITIES} availableModes={['business_demo']} onTalkToBob={() => {}} /> },
      limited: { label: 'Limited details', render: () => <MeetBob profile={SAMPLE_PROFILE} readiness="limited_ready" capabilityManifest={SAMPLE_CAPABILITIES} availableModes={['business_demo']} onTalkToBob={() => {}} /> },
      notFit: { label: 'Not a fit', render: () => <MeetBob profile={{ ...SAMPLE_PROFILE, businessName: 'Port Plastics' }} readiness="limited_ready" capabilityManifest={SAMPLE_CAPABILITIES} availableModes={['business_demo']} businessFit={{ verdict: 'not_fit', businessType: 'plastics distributor' }} contactEmail="team@frontline.example" onTalkToBob={() => {}} onRetryResearch={() => {}} /> },
      insufficient: { label: 'Not enough context', render: () => <MeetBob profile={{}} readiness="insufficient_context" onAskFrontline={() => {}} onRetryResearch={() => {}} /> },
    },
  },
  s13: {
    label: 'S13 · Additional info',
    states: {
      empty: { label: 'Empty', render: () => <AdditionalInfo agentId="00000000-0000-4000-8000-000000000000" onDone={() => {}} /> },
    },
  },
};

/** Dev-only review harness: renders the real onboarding components with fixture props, so a screen and its states can be reviewed without a live website-research backend. Not shipped: only mounted behind /design-review in dev builds. */
export default function DesignReview() {
  const [screenId, setScreenId] = useState('s2');
  const [stateId, setStateId] = useState(Object.keys(SCREENS.s2.states)[0]);
  const screen = SCREENS[screenId];
  const activeState = screen.states[stateId] ? stateId : Object.keys(screen.states)[0];

  return (
    <div style={{ fontFamily: 'Inter, Arial, sans-serif' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff', borderBottom: '1px solid #e2dcd3', padding: '14px 20px', display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Design review</strong>
        {Object.entries(SCREENS).map(([id, s]) => (
          <button key={id} onClick={() => { setScreenId(id); setStateId(Object.keys(s.states)[0]); }}
            style={{ fontWeight: id === screenId ? 700 : 400, background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>
            {s.label}
          </button>
        ))}
        <span style={{ color: '#9a9086' }}>|</span>
        {Object.entries(screen.states).map(([id, s]) => (
          <button key={id} onClick={() => setStateId(id)}
            style={{ fontWeight: id === activeState ? 700 : 400, background: id === activeState ? '#edf4f1' : 'none', border: '1px solid #e2dcd3', borderRadius: 6, cursor: 'pointer', padding: '4px 10px' }}>
            {s.label}
          </button>
        ))}
      </div>
      {screen.states[activeState].render()}
    </div>
  );
}
