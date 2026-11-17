import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DemoResult from '../src/components/product/DemoResult.jsx';
import OwnerHistory from '../src/components/product/OwnerHistory.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const base = { mode: 'business_demo', requests: [], cases: [], lookups: [], receipts: [] };
const summary = { demoId: 'a', mode: 'business_demo', endedAt: null, callerTurnCount: 2,
  callerExcerpts: ['I need a driveway wash.', 'Could you do next week?'], tasks: [{
    kind: 'service_request', goal: 'Collect a driveway wash request', status: 'cancelled',
    fields: { serviceNeed: 'Driveway washing', propertyCity: 'Irvine' }, missingFields: [], saved: false, lookupRecorded: false,
  }] };

it('shows an unfinished request as a Needs review note, with caller words labeled', () => {
  render(<DemoResult result={{ ...base, callSummary: summary }} />);
  expect(screen.getByText('Needs review')).toBeInTheDocument();
  expect(screen.getByText('Nothing was booked or sent.')).toBeInTheDocument();
  expect(screen.queryByText(/nothing was saved/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark as done' })).not.toBeInTheDocument();
  expect(screen.getByText('Driveway washing')).toBeInTheDocument();
  expect(screen.getByText('“I need a driveway wash.”')).toBeInTheDocument();
  expect(screen.getByText('Caller notes')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Call result' })).toBeInTheDocument();
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'No request came up on this call.' })).not.toBeInTheDocument();
});

it('names what is missing in plain words, when the server reported it', () => {
  render(<DemoResult result={{ ...base, callSummary: { ...summary, tasks: [{ ...summary.tasks[0], missingFields: ['contactPhone', 'contactEmail', 'preferredDay'] }] } }} />);
  expect(screen.getByText('Missing: a way to reach them and preferred day.')).toBeInTheDocument();
});

it('omits the missing line when nothing is missing', () => {
  render(<DemoResult result={{ ...base, callSummary: summary }} />);
  expect(screen.queryByText(/Missing:/)).not.toBeInTheDocument();
});

it('shows Q&A caller topics without implying Blake answered or an action saved', () => {
  render(<DemoResult result={{ ...base, mode: 'frontline_qa', callSummary: {
    ...summary, mode: 'frontline_qa', tasks: [], callerExcerpts: ['What does Frontline do?'], callerTurnCount: 1,
  } }} />);
  expect(screen.getByText('“What does Frontline do?”')).toBeInTheDocument();
  expect(screen.queryByText(/Request discussed/)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'No request came up on this call.' })).toBeInTheDocument();
});

it('keeps saved and failed records distinct from the recap', () => {
  const request = { recordId: 'record', receiptId: 'receipt', fields: { serviceNeed: 'Driveway washing' } };
  const receipt = { receiptId: 'receipt', operationKind: 'request', recordId: 'record', outcome: 'saved' };
  const view = render(<DemoResult result={{ ...base, callSummary: { ...summary, tasks: [{ ...summary.tasks[0], status: 'succeeded', saved: true }] }, requests: [request], receipts: [receipt] }} />);
  expect(screen.getByText('Request saved')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'No request came up on this call.' })).not.toBeInTheDocument();
  view.rerender(<DemoResult result={{ ...base, callSummary: { ...summary, tasks: [{ ...summary.tasks[0], status: 'failed' }] }, receipts: [{ receiptId: 'failed', operationKind: 'request', outcome: 'failed' }] }} />);
  expect(screen.getByRole('heading', { name: 'Request not saved' })).toBeInTheDocument();
  expect(screen.queryByText('Request saved')).not.toBeInTheDocument();
});

it('shows a voice v2 note record once, as Needs review, never as a failed save', () => {
  // A request that ended unfinished is a note with no request receipt; an escalation receipt may point at it.
  const note = { recordId: 'note', receiptId: 'escalation-receipt', reviewStatus: 'needs_review', missingFields: ['propertyCity'],
    nextStep: 'Call Tom at (408) 555-2147 to ask where the job is.', fields: { serviceNeed: 'Driveway washing', callerName: 'Tom' } };
  const receipt = { receiptId: 'escalation-receipt', operationKind: 'escalation', recordId: 'note', outcome: 'saved' };
  render(<DemoResult result={{ ...base, callSummary: { ...summary, tasks: [{ ...summary.tasks[0], noted: true }] }, requests: [note], receipts: [receipt] }} />);
  expect(screen.getAllByText('Needs review')).toHaveLength(1);
  expect(screen.getByText('Missing: where the job is.')).toBeInTheDocument();
  expect(screen.getByText(/Call Tom at \(408\) 555-2147/)).toBeInTheDocument();
  expect(screen.queryByText('Save not confirmed')).not.toBeInTheDocument();
  expect(screen.queryByText('Request saved')).not.toBeInTheDocument();
});

it('shows an owner-scoped recap even when nothing was saved', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, status: 200, json: async () => path === '/v1/session'
    ? { csrfToken: 'csrf' }
    : { resourceKind: 'agent', resourceId: 'agent-1', requests: [], cases: [], lookups: [], receipts: [], callSummaries: [summary] } })));
  render(<OwnerHistory resource={{ kind: 'agent', id: 'agent-1' }} />);
  expect(await screen.findByText('Needs review')).toBeInTheDocument();
  expect(screen.getByText('“Could you do next week?”')).toBeInTheDocument();
});

it.each([
  ['caller_ended', 'Call ended at your request.'],
  ['human_preference', 'A person was requested, so the call ended.'],
  ['urgency', 'Urgent help was requested, so the call ended.'],
  ['safety_emergency', 'An immediate safety concern came up, so the call ended.'],
  ['blocking_unknown', "Blake couldn't confirm something needed to continue."],
  ['setup_timeout', "The call didn't start in time."],
  ['soft_close_elapsed', 'The call reached its time limit.'],
  ['hard_end_elapsed', 'The call reached its time limit.'],
  ['provider_failure', 'Sorry, the call had a problem and ended early.'],
])('explains API terminal reason %s in caller-friendly language', (terminalReason, copy) => {
  render(<DemoResult result={{ ...base, terminalReason }} />);
  expect(screen.getByText(copy)).toBeInTheDocument();
});

it('keeps a neutral fallback for unknown terminal reasons', () => {
  render(<DemoResult result={{ ...base, terminalReason: 'future_reason' }} />);
  expect(screen.getByText('The call ended.')).toBeInTheDocument();
});
