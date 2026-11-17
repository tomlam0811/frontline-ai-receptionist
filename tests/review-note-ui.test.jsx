import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationOutcomes from '../src/components/owner/ConversationOutcomes.jsx';
import CallSummary from '../src/components/product/CallSummary.jsx';
import { missingText, noteTitle } from '../src/components/product/ReviewNote.jsx';
import { resetOwnerApi } from '../src/lib/owner-api.js';

// VA-T14 and VA-T16 at the component level. The review endpoint is mocked; the backend owns its own tests.

const agentId = 'agent-1';
const conversationId = 'conv-1';
const reviewPath = (recordId) => `/v1/agents/${agentId}/conversations/${conversationId}/outcomes/${recordId}/review`;

const unfinished = {
  recordId: 'r1', reviewStatus: 'needs_review', missingFields: ['propertyCity', 'propertyState'],
  fields: { serviceNeed: 'Driveway pressure washing', callerName: 'Tom', contactPhone: '(408) 555-2147' },
  nextStep: 'Call Tom at (408) 555-2147 to ask where the job is.',
};
const complete = {
  recordId: 'r2', reviewStatus: 'needs_review', missingFields: [],
  fields: { serviceNeed: 'Window cleaning', callerName: 'Maria', contactPhone: '(714) 555-0100', propertyCity: 'Tustin', propertyState: 'California' },
  nextStep: 'Call Maria at (714) 555-0100 to follow up.',
};

/** @type {{status: number, body: any, hold: Promise<void>|null}} */
let reply;
/** @type {Array<{path: string, method: string, headers: any, body: any}>} */
let calls;

beforeEach(() => {
  resetOwnerApi();
  calls = [];
  reply = { status: 200, body: null, hold: null };
  vi.stubGlobal('fetch', vi.fn(async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === '/v1/session') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ csrfToken: 'csrf' }) };
    if (reply.hold) await reply.hold;
    const requested = JSON.parse(init.body).reviewStatus;
    const body = reply.body ?? { ...unfinished, reviewStatus: requested };
    return { ok: reply.status < 400, status: reply.status, headers: new Headers(), json: async () => (reply.status < 400 ? body : { title: 'request_failed' }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const note = (title) => screen.getByRole('article', { name: title });
const reviewCalls = () => calls.filter((call) => call.path.endsWith('/review'));

describe('Needs review note', () => {
  it('shows status, title, details, a plain missing line, the next step and the quiet line, in that order', () => {
    render(<ConversationOutcomes outcomes={{ requests: [unfinished], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    const card = note('Driveway pressure washing');
    expect(within(card).getByText('Needs review')).toBeInTheDocument();
    expect(within(card).getByRole('heading', { level: 3, name: 'Driveway pressure washing' })).toBeInTheDocument();
    expect(within(card).getByText('Tom')).toBeInTheDocument();
    expect(within(card).getByText('(408) 555-2147')).toBeInTheDocument();
    // The title is not repeated as a detail.
    expect(within(card).queryByText('Service need')).not.toBeInTheDocument();
    expect(within(card).getByText('Missing: where the job is.')).toBeInTheDocument();
    expect(card).toHaveTextContent('Next step: Call Tom at (408) 555-2147 to ask where the job is.');
    expect(within(card).getByText('Nothing was booked or sent.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Mark as done' })).toBeEnabled();
    const order = ['Needs review', 'Driveway pressure washing', 'Tom', 'Missing:', 'Next step:', 'Nothing was booked or sent.', 'Mark as done'];
    const text = card.textContent;
    expect(order.map((part) => text.indexOf(part))).toEqual([...order.map((part) => text.indexOf(part))].sort((a, b) => a - b));
    expect(text).not.toMatch(/saved|propertyCity|needs_review|—/);
  });

  it('leaves out the missing line when nothing is missing, and shows the city with its state', () => {
    render(<ConversationOutcomes outcomes={{ requests: [complete], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    const card = note('Window cleaning');
    expect(within(card).queryByText(/Missing/)).not.toBeInTheDocument();
    expect(within(card).getByText('Tustin, California')).toBeInTheDocument();
    expect(card).toHaveTextContent('Next step: Call Maria at (714) 555-0100 to follow up.');
  });

  it('titles each kind by what the customer asked for', () => {
    expect(noteTitle({ kind: 'complaint', context: { summary: 'Complaint about a missed visit' } })).toBe('Complaint about a missed visit');
    expect(noteTitle({ kind: 'appointment_lookup', fields: { appointmentAction: 'cancel' } })).toBe('Cancel an appointment');
    expect(noteTitle({ kind: 'appointment_lookup', fields: { appointmentAction: 'reschedule' } })).toBe('Change an appointment');
    expect(noteTitle({ kind: 'escalation', escalationReason: 'human_preference', context: {} })).toBe('Talk to a person');
    expect(noteTitle({ kind: 'something_new', fields: {} })).toBe('Customer request');
    expect(noteTitle({})).toBe('Customer request');
  });

  it('says what is missing in plain words, once each, joined naturally', () => {
    expect(missingText(['callerName'])).toBe('their name');
    expect(missingText(['contactPhone', 'contactEmail', 'propertyCity'])).toBe('a way to reach them and where the job is');
    expect(missingText(['serviceNeed', 'callerName', 'contactPhone'])).toBe('what they need, their name, and a way to reach them');
    expect(missingText(['cityConfirmed', 'unknown_key'])).toBe('');
    expect(missingText(undefined)).toBe('');
  });

  it('shows lookup, complaint and person notes from the conversation, and an unknown kind without breaking', () => {
    render(<ConversationOutcomes agentId={agentId} conversationId={conversationId} outcomes={{
      requests: [{ recordId: 'l1', kind: 'appointment_lookup', fields: { callerName: 'Ana', appointmentAction: 'cancel' }, missingFields: [], nextStep: 'Call Ana back about the appointment.' },
        { recordId: 'u1', kind: 'future_kind', fields: {}, missingFields: [] }],
      cases: [{ recordId: 'c1', kind: 'complaint', context: { summary: 'Complaint about a missed visit', callerName: 'Lee' }, missingFields: ['contactPhone'] },
        { recordId: 'e1', kind: 'escalation', escalationReason: 'human_preference', context: { callerName: 'Sam' }, missingFields: [], nextStep: 'Call Sam back. They asked to talk to a person.' }],
    }} />);
    expect(note('Cancel an appointment')).toHaveTextContent('Ana');
    expect(note('Customer request')).toHaveTextContent('Needs review');
    expect(note('Complaint about a missed visit')).toHaveTextContent('Missing: a way to reach them.');
    expect(note('Talk to a person')).toHaveTextContent('Next step: Call Sam back. They asked to talk to a person.');
    expect(screen.queryByText(/Reason:/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark as done' })).toHaveLength(4);
  });
});

describe('Mark as done (VA-T16)', () => {
  it('saves Done through the review endpoint, dims the note and offers Undo, which sets it back', async () => {
    const user = userEvent.setup();
    /** @type {() => void} */
    let release = () => {};
    reply.hold = new Promise((resolve) => { release = () => resolve(); });
    render(<ConversationOutcomes outcomes={{ requests: [unfinished], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    const card = note('Driveway pressure washing');
    await user.click(within(card).getByRole('button', { name: 'Mark as done' }));

    const pending = await within(card).findByRole('button', { name: 'Saving…' });
    expect(pending).toBeDisabled();
    expect(pending.querySelector('.owner-spinner')).not.toBeNull();
    expect(within(card).getByText('Needs review')).toBeInTheDocument();
    release();

    expect(await within(card).findByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(within(card).getByText('Done')).toBeInTheDocument();
    expect(card).toHaveClass('review-note--done');
    expect(reviewCalls()).toEqual([expect.objectContaining({ path: reviewPath('r1'), method: 'POST', body: { reviewStatus: 'done' } })]);
    expect(reviewCalls()[0].headers['X-Frontline-CSRF']).toBe('csrf');

    reply.hold = null;
    await user.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(await within(card).findByRole('button', { name: 'Mark as done' })).toBeEnabled();
    expect(within(card).getByText('Needs review')).toBeInTheDocument();
    expect(card).not.toHaveClass('review-note--done');
    expect(reviewCalls()[1]).toMatchObject({ path: reviewPath('r1'), method: 'POST', body: { reviewStatus: 'needs_review' } });
  });

  it('shows a note that was already done as Done with Undo, as after a reload', () => {
    render(<ConversationOutcomes outcomes={{ requests: [{ ...unfinished, reviewStatus: 'done' }], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    const card = note('Driveway pressure washing');
    expect(within(card).getByText('Done')).toBeInTheDocument();
    expect(card).toHaveClass('review-note--done');
    expect(within(card).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('keeps the note as it was when the update fails, says so, and succeeds on retry', async () => {
    const user = userEvent.setup();
    reply.status = 500;
    render(<ConversationOutcomes outcomes={{ requests: [unfinished, complete], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    const card = note('Driveway pressure washing');
    await user.click(within(card).getByRole('button', { name: 'Mark as done' }));

    expect(await within(card).findByRole('alert')).toHaveTextContent("Couldn't update this. Try again.");
    expect(within(card).getByText('Needs review')).toBeInTheDocument();
    expect(card).not.toHaveClass('review-note--done');
    expect(within(card).getByRole('button', { name: 'Mark as done' })).toBeEnabled();
    // The other note is untouched.
    expect(within(note('Window cleaning')).queryByRole('alert')).not.toBeInTheDocument();

    reply.status = 200;
    await user.click(within(card).getByRole('button', { name: 'Mark as done' }));
    expect(await within(card).findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await waitFor(() => expect(within(card).queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows no button for a record it cannot address', () => {
    render(<ConversationOutcomes outcomes={{ requests: [{ ...unfinished, recordId: undefined }], cases: [] }} agentId={agentId} conversationId={conversationId} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Call result (CallSummary)', () => {
  const summary = { demoId: 'd', mode: 'business_demo', endedAt: null, callerTurnCount: 2, callerExcerpts: [], tasks: [
    { kind: 'service_request', goal: 'Driveway pressure washing', status: 'cancelled', fields: { serviceNeed: 'Driveway pressure washing', callerName: 'Tom' }, missingFields: ['propertyCity'], saved: false, lookupRecorded: false },
  ] };

  it('shows the saved note with its status only, once, with no button and no old save lines', () => {
    render(<CallSummary summary={summary} records={{ requests: [unfinished], cases: [] }} showHeading={false} />);
    const notes = screen.getAllByRole('article');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Needs review');
    expect(notes[0]).toHaveTextContent('Missing: where the job is.');
    expect(notes[0]).toHaveTextContent('Next step: Call Tom at (408) 555-2147 to ask where the job is.');
    expect(notes[0]).toHaveTextContent('Nothing was booked or sent.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/nothing was saved|listed separately|wasn't confirmed/i);
  });

  it('shows an unrecorded call task as a note too, and leaves out tasks whose note is listed elsewhere on the page', () => {
    const view = render(<CallSummary summary={summary} />);
    expect(screen.getByRole('article', { name: 'Driveway pressure washing' })).toHaveTextContent('Missing: where the job is.');
    view.rerender(<CallSummary summary={{ ...summary, callerExcerpts: ['I need my driveway washed.'] }} listedSeparately={{ requests: [unfinished], cases: [] }} />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText('Caller notes')).toBeInTheDocument();
  });

  it('leaves out a noted task when its note is listed elsewhere and only the flag says so', () => {
    render(<CallSummary summary={{ ...summary, callerExcerpts: ['Hello there, anyone?'], tasks: [{ ...summary.tasks[0], noted: true }] }} omitRecordedTasks />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('pairs a task with the record it names before pairing by kind', () => {
    const two = { ...summary, tasks: [{ ...summary.tasks[0], fields: { serviceNeed: 'Gutter cleaning' } }, { ...summary.tasks[0], noteRecordId: 'r1' }] };
    render(<CallSummary summary={two} records={{ requests: [unfinished], cases: [] }} showHeading={false} />);
    expect(screen.getAllByRole('article').map((item) => item.querySelector('h3').textContent)).toEqual(['Driveway pressure washing', 'Gutter cleaning']);
  });
});
