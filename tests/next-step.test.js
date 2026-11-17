import { describe, expect, it } from 'vitest';
import { formatPhone, nextStep, withNextStep, withNextSteps } from '../server/api/next-step.js';

// VA-D5: one line per Needs review note, built by code from what is known.
const tom = { callerName: 'Tom Lam', contactPhone: '(408) 555-2147', serviceNeed: 'Driveway washing', propertyCity: 'Tustin', cityConfirmed: true };

describe('nextStep', () => {
  it('asks the owner to follow up on a complete service request', () => {
    expect(nextStep({ kind: 'service_request', fields: tom, missingFields: [] })).toBe('Call Tom at (408) 555-2147 to follow up.');
  });

  it('asks where the job is when the city, or its state, is missing', () => {
    expect(nextStep({ fields: { ...tom, propertyCity: undefined }, missingFields: ['propertyCity'] })).toBe('Call Tom at (408) 555-2147 to ask where the job is.');
    expect(nextStep({ fields: tom, missingFields: ['propertyState'] })).toBe('Call Tom at (408) 555-2147 to ask where the job is.');
  });

  it('asks what they need, and joins two asks', () => {
    expect(nextStep({ fields: tom, missingFields: ['serviceNeed'] })).toBe('Call Tom at (408) 555-2147 to ask what they need.');
    expect(nextStep({ fields: tom, missingFields: ['propertyCity', 'serviceNeed'] })).toBe('Call Tom at (408) 555-2147 to ask what they need and where the job is.');
  });

  it('drops the name when there is none and adapts the ask the same way', () => {
    expect(nextStep({ fields: { contactPhone: '4085552147' }, missingFields: ['callerName'] })).toBe('Call (408) 555-2147 to follow up.');
    expect(nextStep({ fields: { contactPhone: '4085552147' }, missingFields: ['callerName', 'propertyCity'] })).toBe('Call (408) 555-2147 to ask where the job is.');
  });

  it('emails when the only way to reach them is an email', () => {
    expect(nextStep({ fields: { contactEmail: 'tom@example.com' } })).toBe('Email tom@example.com to follow up.');
    expect(nextStep({ fields: { callerName: 'Tom', contactEmail: 'tom@example.com' }, missingFields: ['serviceNeed'] })).toBe('Email Tom at tom@example.com to ask what they need.');
  });

  it('prefers the phone when both are known', () => {
    expect(nextStep({ fields: { ...tom, contactEmail: 'tom@example.com' } })).toBe('Call Tom at (408) 555-2147 to follow up.');
  });

  it('says they asked for a person, from the ending reason or the escalation reason', () => {
    const line = 'Call Tom back at (408) 555-2147. They asked to talk to a person.';
    expect(nextStep({ fields: tom, missingFields: ['propertyCity'], endedBecause: 'human_preference' })).toBe(line);
    expect(nextStep({ kind: 'escalation', fields: tom, escalationReason: 'human_preference' })).toBe(line);
    expect(nextStep({ fields: { contactPhone: '4085552147' }, endedBecause: 'human_preference' })).toBe('Call them back at (408) 555-2147. They asked to talk to a person.');
    expect(nextStep({ fields: { callerName: 'Tom', contactEmail: 'tom@example.com' }, endedBecause: 'human_preference' })).toBe('Email Tom at tom@example.com. They asked to talk to a person.');
    expect(nextStep({ fields: { contactEmail: 'tom@example.com' }, endedBecause: 'human_preference' })).toBe('Email tom@example.com. They asked to talk to a person.');
  });

  it('says when the caller wants the work done as soon as possible', () => {
    const notes = 'Calling for Mike. Wants it done as soon as possible.';
    expect(nextStep({ fields: { ...tom, notes } })).toBe('Call Tom at (408) 555-2147 to follow up. They want it done as soon as possible.');
    expect(nextStep({ fields: { ...tom, notes }, missingFields: ['propertyCity'] }))
      .toBe('Call Tom at (408) 555-2147 to ask where the job is. They want it done as soon as possible.');
  });

  it('names a complaint and an appointment change', () => {
    expect(nextStep({ kind: 'complaint', fields: tom })).toBe('Call Tom at (408) 555-2147 about their complaint.');
    expect(nextStep({ kind: 'appointment_lookup', fields: tom, missingFields: ['appointmentAction'] })).toBe('Call Tom at (408) 555-2147 about changing their appointment.');
  });

  it('finds an appointment by name when the caller left no phone or email', () => {
    expect(nextStep({ kind: 'appointment_lookup', fields: { callerName: 'Sam Lee', appointmentAction: 'cancel' } })).toBe("Look up Sam Lee's appointment and cancel it.");
    expect(nextStep({ kind: 'appointment_lookup', fields: { callerName: 'Sam Lee', appointmentAction: 'reschedule' } })).toBe("Look up Sam Lee's appointment and call them about a new time.");
    expect(nextStep({ kind: 'appointment_lookup', fields: { callerName: 'Sam Lee' }, missingFields: ['appointmentAction'] })).toBe("Look up Sam Lee's appointment to see what they need.");
    expect(nextStep({ kind: 'appointment_lookup', fields: { appointmentAction: 'cancel' }, missingFields: ['callerName'] })).toBe("The caller didn't say whose appointment it is.");
  });

  it('says there is no way to reach them, whatever else is known', () => {
    const line = "The caller didn't leave a way to reach them.";
    expect(nextStep({ fields: { callerName: 'Tom' } })).toBe(line);
    expect(nextStep({ kind: 'complaint', fields: { noContact: true, summary: 'Late' } })).toBe(line);
    expect(nextStep({ fields: {}, endedBecause: 'human_preference' })).toBe(line);
    expect(nextStep({})).toBe(line);
  });

  it('formats phones and keeps an unparseable one as written', () => {
    expect(formatPhone('+1 408 555 2147')).toBe('(408) 555-2147');
    expect(formatPhone('408-555-2147')).toBe('(408) 555-2147');
    expect(formatPhone(' 555-0100 ')).toBe('555-0100');
    expect(formatPhone(undefined)).toBe('');
  });

  it('never uses an em dash', () => {
    const lines = [nextStep({ fields: tom }), nextStep({ fields: tom, endedBecause: 'human_preference' }), nextStep({ kind: 'complaint', fields: tom }), nextStep({})];
    for (const line of lines) expect(line).not.toContain('—');
  });
});

describe('withNextStep', () => {
  it('defaults review status and computes missing fields for a record saved before notes existed', () => {
    const legacy = { recordId: 'r1', fields: { callerName: 'Tom', serviceNeed: 'Washing', propertyCity: 'Irvine', contactPhone: '4085552147' } };
    expect(withNextStep(legacy)).toMatchObject({ reviewStatus: 'needs_review', endedBecause: null,
      missingFields: [], nextStep: 'Call Tom at (408) 555-2147 to follow up.' });
    expect(withNextStep({ fields: { contactPhone: '4085552147' } })).toMatchObject({ missingFields: ['callerName', 'serviceNeed', 'propertyCity'],
      nextStep: 'Call (408) 555-2147 to ask what they need and where the job is.' });
  });

  it('reads a case from its context and keeps a stored status', () => {
    const complaint = { kind: 'complaint', reviewStatus: 'done', context: { summary: 'Late crew', callerTurnIds: [], callerName: 'Ana', contactEmail: 'ana@example.com' } };
    expect(withNextStep(complaint)).toMatchObject({ reviewStatus: 'done', missingFields: [], nextStep: 'Email Ana at ana@example.com about their complaint.' });
    const escalation = { kind: 'escalation', escalationReason: 'human_preference', missingFields: [], context: { summary: 'Asked for a person', callerTurnIds: [], contactPhone: '4085552147' } };
    expect(withNextStep(escalation).nextStep).toBe('Call them back at (408) 555-2147. They asked to talk to a person.');
    expect(withNextSteps(undefined)).toEqual([]);
  });
});
