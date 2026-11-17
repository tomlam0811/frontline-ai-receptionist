import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MeetBob from '../src/components/product/MeetBob.jsx';
import PreparationProgress from '../src/components/product/PreparationProgress.jsx';

const preparedProfile = {
  businessName: 'Northside Auto Care',
  location: 'Portland, Oregon',
  services: [{ name: 'Vehicle inspections', sourceUrl: 'https://northside.example/services' }],
  hours: { label: 'Monday–Friday, 8 a.m.–5 p.m.', basis: 'published', sourceUrl: 'https://northside.example/hours' },
  capabilities: ['Answer questions about listed services', 'Collect appointment preferences'],
  limits: ['Prices not found on the public website'],
};

afterEach(cleanup);

describe('Meet Blake', () => {
  it('reveals the agent with a customer-role instruction and one voice CTA, not a setup checklist', async () => {
    const onTalkToBob = vi.fn();
    render(<MeetBob profile={preparedProfile} readiness="ready" onTalkToBob={onTalkToBob} />);
    expect(screen.getByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
    expect(screen.getByText('Northside Auto Care · Portland, Oregon')).toBeInTheDocument();
    expect(screen.getByText(/Northside Auto Care's AI receptionist/)).toBeInTheDocument();
    expect(screen.getByText(/the way Northside Auto Care's customers would/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Services Blake found' })).not.toBeInTheDocument();
    expect(screen.queryByText('More details')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Talk to Blake' }));
    expect(onTalkToBob).toHaveBeenCalledOnce();
  });

  it('names a short service in the intro and skips sentence-length ones', () => {
    // portplastics.com on 2026-10-02: the intro read "things like port plastics delivers industrial plastic materials ...".
    const sentence = 'Port Plastics delivers industrial plastic materials and custom fabrication services to manufacturers nationwide.';
    const { rerender } = render(<MeetBob profile={{ ...preparedProfile, services: [{ name: sentence }, { name: 'CNC routing' }] }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/ready to help with things like CNC routing\./)).toBeInTheDocument();
    expect(screen.queryByText(/delivers industrial plastic/)).not.toBeInTheDocument();
    rerender(<MeetBob profile={{ ...preparedProfile, services: [{ name: sentence }] }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/Northside Auto Care's AI receptionist\./)).toBeInTheDocument();
    rerender(<MeetBob profile={preparedProfile} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/ready to help with things like vehicle inspections\./)).toBeInTheDocument();
    rerender(<MeetBob profile={{ ...preparedProfile, services: [{ name: 'Full-Service Fabrication' }] }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/ready to help with things like full-service fabrication\./)).toBeInTheDocument();
  });

  it('tells a business outside the target what Frontline offers and still lets them try Blake', async () => {
    const onTalkToBob = vi.fn();
    render(<MeetBob profile={preparedProfile} readiness="ready" businessFit={{ verdict: 'not_fit', businessType: 'plastics distributor' }} contactEmail="team@frontline.example" onTalkToBob={onTalkToBob} />);
    expect(screen.getByRole('heading', { name: 'Frontline is built for small service businesses' })).toBeInTheDocument();
    expect(screen.getByText(/small and medium service businesses in the US/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact the Frontline team' })).toHaveAttribute('href', expect.stringContaining('mailto:team@frontline.example'));
    expect(screen.queryByRole('button', { name: 'Talk to Blake' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try Blake anyway' }));
    expect(screen.getByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
  });

  it('shows Meet Blake as before for a fitting or unclear business, and no contact link without an address', () => {
    const { rerender } = render(<MeetBob profile={preparedProfile} readiness="ready" businessFit={{ verdict: 'unclear', businessType: '' }} onTalkToBob={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Meet Blake' })).toBeInTheDocument();
    rerender(<MeetBob profile={preparedProfile} readiness="ready" businessFit={{ verdict: 'not_fit', businessType: 'law firm' }} contactEmail="" onTalkToBob={() => {}} />);
    expect(screen.queryByRole('link', { name: 'Contact the Frontline team' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Blake anyway' })).toBeInTheDocument();
  });

  it('writes the business name as a natural possessive', () => {
    const { rerender } = render(<MeetBob profile={{ ...preparedProfile, businessName: 'Port Plastics' }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/Blake is Port Plastics' AI receptionist/)).toBeInTheDocument();
    expect(screen.getByText("Talk to Blake the way Port Plastics' customers would.")).toBeInTheDocument();
    rerender(<MeetBob profile={{ ...preparedProfile, businessName: 'Bayside Power Wash (Bayside)', location: '' }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.getByText(/Blake is Bayside Power Wash's AI receptionist/)).toBeInTheDocument();
    expect(screen.getByText('Bayside Power Wash (Bayside)')).toBeInTheDocument();
  });

  it('shows a truthful limited-details notice without exposing hours or gap detail on this screen', () => {
    render(<MeetBob profile={{ ...preparedProfile, hours: { basis: 'unknown' } }} readiness="limited_ready" onTalkToBob={() => {}} />);
    expect(screen.getByText('Some business details are missing.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is booked or sent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hours unconfirmed/)).not.toBeInTheDocument();
  });

  it('does not invent abilities when a preparation lacks a capability manifest', () => {
    const { capabilities, limits, ...apiProfile } = preparedProfile;
    expect(capabilities).toHaveLength(2);
    expect(limits).toHaveLength(1);
    render(<MeetBob profile={apiProfile} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Talk to Blake' })).not.toBeInTheDocument();
    expect(screen.getByText(/needs more business information/i)).toBeInTheDocument();
  });

  it('keeps Frontline Q&A separate when business evidence is insufficient', async () => {
    const onAskFrontline = vi.fn();
    const onRetryResearch = vi.fn();
    render(<MeetBob profile={preparedProfile} readiness="insufficient_context" onAskFrontline={onAskFrontline} onRetryResearch={onRetryResearch} />);
    expect(screen.queryByRole('button', { name: 'Talk to Blake' })).not.toBeInTheDocument();
    expect(screen.getByText(/appointment requests aren't available here/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ask Blake' }));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAskFrontline).toHaveBeenCalledOnce();
    expect(onRetryResearch).toHaveBeenCalledOnce();
  });

  it('fails closed when a ready payload lacks identity or services', () => {
    render(<MeetBob profile={{ businessName: 'Northside Auto Care', services: [] }} readiness="ready" onTalkToBob={() => {}} onAskFrontline={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Talk to Blake' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask Blake' })).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn't confirm the business or its services/)).toBeInTheDocument();
  });

  it('does not link unsafe source schemes', () => {
    render(<MeetBob profile={{ ...preparedProfile, services: [{ name: 'Inspection', sourceUrl: 'http://northside.example/services' }], hours: { label: 'Weekdays', basis: 'published', sourceUrl: 'data:text/plain,foo' } }} readiness="ready" onTalkToBob={() => {}} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('honors available modes for the v1 capability manifest', () => {
    const capabilityManifest = {
      knowledgeCoverage: 'partial',
      actionReadiness: 'intake_only',
      capabilities: [{ topic: 'Appointments', context: 'Apartment cleaning', canDoNow: 'Collect a preferred time', cannotDecide: 'Whether a slot is free', handoff: 'Show the request for team review' }],
    };
    const view = render(<MeetBob profile={preparedProfile} readiness="limited_ready" capabilityManifest={capabilityManifest} availableModes={['business_demo']} onTalkToBob={() => {}} />);
    expect(screen.getByRole('button', { name: 'Talk to Blake' })).toBeEnabled();
    view.rerender(<MeetBob profile={preparedProfile} readiness="limited_ready" capabilityManifest={capabilityManifest} availableModes={['frontline_qa']} onTalkToBob={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Talk to Blake' })).not.toBeInTheDocument();
  });
});

describe('Preparation progress', () => {
  it('shows a thank-you with a cycling plain-language status and no made-up percentage', () => {
    render(<PreparationProgress stage="researching" />);
    expect(screen.getByRole('heading', { name: 'Getting the receptionist ready.' })).toBeInTheDocument();
    expect(screen.getByText('Reading your website. This usually takes under a minute.')).toBeInTheDocument();
    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('counts the real time spent instead of rotating made-up steps', () => {
    vi.useFakeTimers();
    try {
      render(<PreparationProgress stage="researching" />);
      act(() => { vi.advanceTimersByTime(65_000); });
      expect(screen.getByText('1:05')).toBeInTheDocument();
      expect(screen.queryByText('Almost ready.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a quiet way to change the website while still preparing, without competing with the status', async () => {
    const onCancel = vi.fn();
    render(<PreparationProgress stage="researching" onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change website' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('gives a retry action after failed research', async () => {
    const onRetry = vi.fn();
    render(<PreparationProgress stage="failed_retryable" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't read that website");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('distinguishes unavailable research setup from a failed website research job', () => {
    render(<PreparationProgress stage="research_unavailable" />);
    expect(screen.getByRole('heading', { name: "Website reading isn't available right now" })).toBeInTheDocument();
    expect(screen.getByText(/contact the Frontline team/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't read that website")).not.toBeInTheDocument();
  });

  it('labels pre-admission capacity and preview setup errors separately', () => {
    const { rerender } = render(<PreparationProgress stage="research_busy" />);
    expect(screen.getByRole('heading', { name: 'Website reading is busy' })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't read that website")).not.toBeInTheDocument();
    rerender(<PreparationProgress stage="origin_mismatch" />);
    expect(screen.getByRole('heading', { name: "Website reading isn't available right now" })).toBeInTheDocument();
  });
});
