import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DemoResult from '../src/components/product/DemoResult.jsx';
import OwnerHistory from '../src/components/product/OwnerHistory.jsx';
import MeetBob from '../src/components/product/MeetBob.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agentId = '11111111-1111-4111-8111-111111111111';
const baseResult = { mode: 'business_demo', requests: [], cases: [], lookups: [], receipts: [] };
const savedReceipt = (kind, recordId, receiptId) => ({ receiptId, operationId: crypto.randomUUID(), operationKind: kind, payloadHash: 'hash', workflowInstanceId: crypto.randomUUID(), workflowRevision: 3, recordedAt: '2026-09-24T10:00:00Z', sequence: 1, outcome: 'saved', recordId });

describe('TOM-21 truthful results', () => {
  it('distinguishes request, complaint, escalation, and their request-only truth', () => {
    const request = { recordId: 'request-1', receiptId: 'receipt-1', fields: { callerName: 'Jordan', contactEmail: 'j@example.com', serviceNeed: 'Pressure washing', propertyCity: 'Irvine' } };
    const complaint = { recordId: 'case-1', receiptId: 'receipt-2', kind: 'complaint', context: { summary: 'Water reached an entryway' } };
    const escalation = { recordId: 'case-2', receiptId: 'receipt-3', kind: 'escalation', escalationReason: 'human_preference', context: { summary: 'Asked for a person' } };
    render(<DemoResult result={{ ...baseResult, requests: [request], cases: [complaint, escalation], receipts: [savedReceipt('request', request.recordId, request.receiptId), savedReceipt('case', complaint.recordId, complaint.receiptId), savedReceipt('escalation', escalation.recordId, escalation.receiptId)] }} />);
    expect(screen.getByText('Request saved')).toBeInTheDocument();
    expect(screen.getByText('Complaint saved')).toBeInTheDocument();
    expect(screen.getByText('Human help request saved')).toBeInTheDocument();
    expect(screen.getByText(/nothing was booked or sent/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no one was called or notified/i)).toHaveLength(2);
  });

  it('keeps empty conversations neutral and shows unavailable lookups and failed saves separately', () => {
    const { rerender } = render(<DemoResult result={baseResult} />);
    expect(screen.getByRole('heading', { name: 'No request came up on this call.' })).toBeInTheDocument();
    expect(screen.queryByText(/insufficient information|server receipts|seeded customer/i)).not.toBeInTheDocument();
    rerender(<DemoResult result={{ ...baseResult, lookups: [{ action: 'cancel', recordedAt: '2026-09-24T10:00:00Z', result: { kind: 'unavailable', lookupId: 'lookup-1', reason: 'storage_error' } }], receipts: [{ receiptId: 'failed-1', operationKind: 'request', outcome: 'failed', failureCode: 'storage_error' }] }} />);
    expect(screen.getByRole('heading', { name: "Couldn't check appointments" })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Request not saved' })).toBeInTheDocument();
  });
});

describe('TOM-21 capabilities and private history', () => {
  it('presents the agent as a reveal with a customer-role instruction and one voice CTA, not a setup checklist', () => {
    render(<MeetBob profile={{ businessName: 'Bayside Power Wash', services: [{ name: 'Commercial pressure washing', sourceUrl: 'https://www.example-powerwash.com/' }] }} readiness="ready" capabilityManifest={{ capabilities: ['WF-01','WF-02','WF-03','WF-04','WF-05','WF-06'].map((workflowId) => ({ workflowId, enabled: true, allowedToolIds: [] })) }} availableModes={['business_demo']} onTalkToBob={() => {}} />);
    expect(screen.getByText(/Bayside Power Wash's AI receptionist/)).toBeInTheDocument();
    expect(screen.getByText(/the way Bayside Power Wash's customers would/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeInTheDocument();
    expect(screen.queryByText(/allowedToolIds|WF-0/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What Blake can do' })).not.toBeInTheDocument();
  });

  it('loads history only through the exact agent id and supports retry', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (path) => {
      if (path === '/v1/session') return { ok: true, status: 200, json: async () => ({ csrfToken: 'csrf' }) };
      if (path === `/v1/agents/${agentId}/history`) {
        attempt += 1;
        if (attempt === 1) return { ok: false, status: 503, json: async () => ({ detail: 'History is temporarily unavailable.' }) };
        return { ok: true, status: 200, json: async () => ({ resourceKind: 'agent', resourceId: agentId, requests: [], cases: [], lookups: [], receipts: [], nextCursor: null }) };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OwnerHistory resource={{ kind: 'agent', id: agentId }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('History is temporarily unavailable.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No requests, complaints, or call results yet/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/v1/agents/${agentId}/history`, expect.objectContaining({ credentials: 'include' })));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('example-powerwash'))).toBe(false);
  });
});

it('labels the unfinished Frontline workspace without promising an agent', () => {
  const { rerender } = render(<DemoResult result={{ ...baseResult, mode: 'frontline_qa' }} onSave={() => {}} />);
  expect(screen.getByRole('button', { name: 'Save conversation' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save receptionist' })).not.toBeInTheDocument();
  rerender(<DemoResult result={baseResult} onSave={() => {}} />);
  expect(screen.getByRole('button', { name: 'Save receptionist' })).toBeInTheDocument();
});

it('preserves caller contact and escalation reason in claimed private history', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session' ? { csrfToken: 'csrf' } : {
    resourceKind: 'agent', resourceId: agentId, requests: [], lookups: [], receipts: [], nextCursor: null,
    cases: [{ recordId: 'case-contact', kind: 'escalation', context: { summary: 'Caller wants an owner review', callerName: 'Jordan', contactEmail: 'j@example.com', contactPhone: '+15555550100' }, escalationReason: 'human_preference', savedAt: '2026-09-24T10:00:00Z' }],
  } })));
  render(<OwnerHistory resource={{ kind: 'agent', id: agentId }} />);
  expect(await screen.findByText('Jordan')).toBeInTheDocument();
  expect(screen.getByText('j@example.com')).toBeInTheDocument();
  expect(screen.getByText('+15555550100')).toBeInTheDocument();
  expect(screen.getByText('Reason: human preference.')).toBeInTheDocument();
  expect(screen.getByText(/nothing was sent to anyone/i)).toBeInTheDocument();
});

it('keeps the legacy manifest reveal free of setup detail and duplicated limits', () => {
  render(<MeetBob profile={{ businessName: 'Bayside Power Wash', services: [{ name: 'Pressure washing', sourceUrl: 'https://www.example-powerwash.com/' }], hours: { basis: 'unknown' } }} readiness="ready" capabilityManifest={{ knowledgeCoverage: 'sourced', actionReadiness: 'intake_only', capabilities: ['Questions', 'Services', 'Intake', 'Limits'].map((topic) => ({ topic, context: 'Bayside Power Wash repeated business context', canDoNow: 'Collect a simulated request', cannotDecide: 'Cannot book', handoff: 'Cannot transfer' })), limits: ['No booking or business request is sent.'] }} availableModes={['business_demo']} onTalkToBob={() => {}} />);
  expect(screen.queryByText(/simulated request|repeated business context|Blake cannot decide/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Nothing is booked or sent/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Hours unconfirmed/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Source for Pressure washing' })).not.toBeInTheDocument();
});

it('retains the request time zone in both result and claimed history', async () => {
  const request = { recordId: 'timezone-request', receiptId: 'timezone-receipt', fields: { callerName: 'Jordan', serviceNeed: 'Pressure washing', preferredDay: 'Friday', preferredWindow: 'Morning', timezone: 'America/Los_Angeles' } };
  const receipt = savedReceipt('request', request.recordId, request.receiptId);
  const view = render(<DemoResult result={{ ...baseResult, requests: [request], receipts: [receipt] }} />);
  expect(screen.getByText('Time zone')).toBeInTheDocument();
  expect(screen.getByText('America/Los_Angeles')).toBeInTheDocument();
  view.unmount();
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session' ? { csrfToken: 'csrf' } : { resourceKind: 'agent', resourceId: agentId, requests: [request], cases: [], lookups: [], receipts: [receipt], nextCursor: null } })));
  render(<OwnerHistory resource={{ kind: 'agent', id: agentId }} />);
  expect(await screen.findByText('Time zone')).toBeInTheDocument();
  expect(screen.getByText('America/Los_Angeles')).toBeInTheDocument();
});
