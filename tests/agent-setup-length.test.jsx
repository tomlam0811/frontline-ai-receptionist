// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentSetup from '../src/components/product/AgentSetup.jsx';
import { frontlineApi } from '../src/lib/frontline-api.js';

const agent = { agentId: 'agt_1', claimState: 'claimed', version: '1.0', setupVersion: 3, businessName: 'Bayside Power Washing', setup: { supportedCapabilities: [], selectedCapabilityIds: [], missingContext: '' } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('setup business details length', () => {
  it('shows a count near the limit and blocks a save over 8,000 characters with a clear message', async () => {
    vi.spyOn(frontlineApi, 'getAgent').mockResolvedValue(agent);
    const save = vi.spyOn(frontlineApi, 'saveAgentSetup').mockResolvedValue({});
    render(<AgentSetup resource={{ kind: 'agent', id: 'agt_1' }} onRestart={() => {}} />);
    const box = await screen.findByLabelText('Business details');
    fireEvent.change(box, { target: { value: 'a'.repeat(8200) } });
    expect(screen.getByText(/8,200 of 8,000 characters/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));
    await waitFor(() => expect(screen.getByText(/8,200 characters\. Shorten them to 8,000 or fewer/)).toBeTruthy());
    expect(save).not.toHaveBeenCalled();
  });

  it('saves normally under the limit', async () => {
    vi.spyOn(frontlineApi, 'getAgent').mockResolvedValue(agent);
    const save = vi.spyOn(frontlineApi, 'saveAgentSetup').mockResolvedValue({ agentId: 'agt_1', version: '1.0', setupVersion: 4, setup: { state: 'saved' } });
    render(<AgentSetup resource={{ kind: 'agent', id: 'agt_1' }} onRestart={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Business details'), { target: { value: 'We also do gutters.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
  });
});
