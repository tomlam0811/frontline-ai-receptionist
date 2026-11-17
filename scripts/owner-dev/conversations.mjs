import { randomUUID } from 'node:crypto';

// Past conversations for the development harness only, so the Conversations list and a conversation detail have
// something to review. Written through the same fixture the tests use; nothing here runs in production.

const DAY = 86_400_000;
const MINUTE = 60_000;

/** A caller/receptionist exchange as alternating turns. */
const talk = (pairs) => ({ callerTurns: pairs.map(([caller]) => ({ text: caller })), bobTurns: pairs.map(([, bob]) => ({ text: bob })) });

/** A saved service request: the task, the saved record and the receipt that ties them together. */
function savedRequest(goal, fields) {
  const receiptId = randomUUID(); const recordId = randomUUID();
  return {
    currentTask: { kind: 'service_request', goal, status: 'completed', fields, missingFields: [], receipt: { receiptId } },
    requests: [{ recordId, receiptId, fields, savedAt: new Date().toISOString() }],
    receipts: [{ receiptId, recordId }],
  };
}

/** A saved complaint or hand-off. */
function savedCase(kind, goal, context, escalationReason) {
  const receiptId = randomUUID(); const recordId = randomUUID();
  return {
    currentTask: { kind: kind === 'complaint' ? 'complaint' : 'service_request', goal, status: 'completed', fields: {}, missingFields: [], receipt: { receiptId } },
    cases: [{ recordId, receiptId, kind, context, ...(escalationReason ? { escalationReason } : {}), savedAt: new Date().toISOString() }],
    receipts: [{ receiptId, recordId }],
  };
}

/**
 * Ten conversations over the last two weeks: demo, test and shared calls, with complete, ended early and interrupted endings.
 * @param {{now?: number, business?: string}} [options]
 */
export function devConversationSeeds({ now = Date.now(), business = 'Riverside Dental' } = {}) {
  const ago = (days, minutes = 0) => new Date(now - days * DAY - minutes * MINUTE).toISOString();
  const seed = (mode, daysAgo, minutes, durationSeconds, rest) => ({ mode, createdAt: ago(daysAgo, minutes), durationSeconds, expiresAt: new Date(now + (30 - daysAgo) * DAY).toISOString(), ...rest });
  return [
    seed('owner_test', 1, 130, 200, {
      ...talk([
        ['Hi, I would like to book a teeth cleaning.', `Happy to help. I can take down your details for a cleaning request. What's your name?`],
        ['Dana Whitfield.', 'Thanks, Dana. What is the best phone number to reach you?'],
        ['555-0142. Thursday morning works for me.', 'Got it. A teeth cleaning, Thursday morning, phone 555-0142. Is that right?'],
        ['Yes, that is right.', `Thanks. I've saved that request for ${business} to review. Someone will follow up with you.`],
      ]),
      ...savedRequest('Book a teeth cleaning', { callerName: 'Dana Whitfield', contactPhone: '555-0142', serviceNeed: 'Teeth cleaning', preferredDay: 'Thursday', preferredWindow: 'Morning' }),
    }),
    seed('shared_guest', 2, 45, 96, talk([
      ['How much does a cleaning cost?', `I don't have a confirmed price for a cleaning. The office can give you an exact amount when you call.`],
      ['Okay, and are you open on Fridays?', `${business} is open Monday to Friday, 9am to 5pm.`],
      ['Great, thank you.', 'You are welcome. Anything else I can help with?'],
    ])),
    seed('owner_test', 3, 200, 262, {
      ...talk([
        ['I had an appointment last week and waited forty minutes past my time.', `I'm sorry about the wait. I can save a complaint for the office to review. Can I get your name?`],
        ['Marcus Bell.', 'Thank you, Marcus. Is there anything you want the office to know?'],
        ['Just that the wait was much longer than I was told to expect.', `Understood. I've saved that for ${business} to review.`],
      ]),
      ...savedCase('complaint', 'Report a long wait', { summary: 'Waited forty minutes past the appointment time', callerName: 'Marcus Bell' }),
    }),
    seed('shared_guest', 5, 15, 148, {
      ...talk([
        ['I think I need a filling. Can I set something up?', 'I can take a request for a filling. What is your name?'],
        ['Priya Nair.', 'Thanks, Priya. What is the best number to reach you?'],
        ['555-0177.', 'Got it. A filling request for Priya Nair, phone 555-0177. Is that right?'],
        ['Yes.', `Thanks. I've saved that request for ${business} to review.`],
      ]),
      ...savedRequest('Request a filling', { callerName: 'Priya Nair', contactPhone: '555-0177', serviceNeed: 'Filling' }),
    }),
    seed('owner_test', 6, 300, 84, {
      ...talk([
        ['I need to move my appointment, and I also have a question about a bill.', `I can't change appointments myself. For the billing question I can pass along a request for a person to help. Would you like that?`],
        ['Yes, please have someone call me about the bill.', `I've saved a request for the office to follow up with you about billing.`],
      ]),
      ...savedCase('escalation', 'Billing question for a person', { summary: 'Caller asked for a person to follow up about a bill' }, 'caller_requested_human'),
    }),
    seed('shared_guest', 8, 60, 20, { terminalReason: 'provider_failure', state: 'failed', callerTurns: [{ text: 'Hello, can you hear me?' }] }),
    seed('business_demo', 9, 90, 130, talk([
      ['Hi, are you open on Saturdays?', `${business} is open Monday to Friday, 9am to 5pm, and closed on Saturdays.`],
      ['Do you do teeth cleaning?', 'Yes, teeth cleaning is one of the services. Would you like me to take down your details?'],
      ['Not right now, thanks.', `No problem. Call ${business} any time.`],
    ])),
    seed('shared_guest', 11, 30, 38, { terminalReason: 'caller_ended', ...talk([['Do you take walk-ins?', `I don't have information about walk-ins. The office can tell you when you call.`]]) }),
    // The caller hung up partway through a request, so the list shows "Ended early".
    seed('business_demo', 12, 20, 47, { terminalReason: 'caller_ended', ...talk([['Can I book a filling?', `Sure, I can take that down for the office. What's your name?`]]),
      currentTask: { kind: 'service_request', goal: 'Book a filling', status: 'stopped', noteRecordId: 'dev-open-request', fields: { serviceNeed: 'Filling' } } }),
    seed('business_demo', 15, 240, 176, {
      ...talk([
        ['I would like to book a cleaning for next week.', `Happy to take a request. What's your name?`],
        ['Sam Ortega, phone 555-0109.', 'Thanks, Sam. Which day works best?'],
        ['Tuesday afternoon.', 'A teeth cleaning, Tuesday afternoon, phone 555-0109. Is that right?'],
        ['Correct.', `Thanks. I've saved that request for ${business} to review.`],
      ]),
      ...savedRequest('Book a teeth cleaning', { callerName: 'Sam Ortega', contactPhone: '555-0109', serviceNeed: 'Teeth cleaning', preferredDay: 'Tuesday', preferredWindow: 'Afternoon' }),
    }),
  ];
}
