import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const livekit = vi.hoisted(() => ({ handlers: {}, room: null }));
vi.mock('livekit-client', () => {
  class Room {
    constructor() {
      this.canPlayAudio = true;
      this.localParticipant = { identity: 'visitor', setMicrophoneEnabled: vi.fn(async () => {}) };
      livekit.room = this;
    }
    on(event, handler) { livekit.handlers[event] = handler; }
    registerTextStreamHandler() {}
    async connect() {}
    async startAudio() {}
    disconnect = vi.fn();
  }
  return { Room, RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', AudioPlaybackStatusChanged: 'audio', ActiveSpeakersChanged: 'speakers', Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected' }, Track: { Kind: { Audio: 'audio' } } };
});

import BrowserVoice from '../src/components/product/BrowserVoice.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); livekit.handlers = {}; livekit.room = null; });

it('shows keyboard-accessible live captions and a LiveKit-driven speaker cue without offering reconnect after a terminal close', async () => {
  const onEnd = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/v1/session') return { ok: true, status: 200, json: async () => ({ csrfToken: 'csrf' }) };
    if (path === '/v1/demos/11111111-1111-4111-8111-111111111111') return { ok: true, status: 200, json: async () => ({ demoId: '11111111-1111-4111-8111-111111111111', state: 'ended', reconnectAllowed: false, terminalReason: 'human_preference', stateRevision: 8 }) };
    throw new Error(`Unexpected ${path}`);
  }));
  render(<BrowserVoice connection={{ demoId: '11111111-1111-4111-8111-111111111111', participantToken: 'token', livekitUrl: 'wss://voice.example.test', tokenExpiresAt: '2099-01-01T00:00:00Z', setupDeadlineAt: '2099-01-01T00:00:00Z', hardEndAt: '2099-01-01T00:00:00Z' }} businessName="Bayside Power Wash" mode="business_demo" onEnd={onEnd} />);
  await waitFor(() => expect(screen.getByText(/Waiting for Blake’s audio/i)).toBeInTheDocument());
  const captions = screen.getByRole('region', { name: /Call captions/i });
  expect(captions).toHaveAttribute('tabindex', '0');
  livekit.handlers.speakers([{ isLocal: true }]);
  await screen.findByText('Hearing you');
  expect(document.querySelector('.browser-voice__speaker--caller')).toBeInTheDocument();
  livekit.handlers.disconnected();
  await waitFor(() => expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ reason: 'human_preference' })));
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});

it('keeps remote audio connected while the server finishes an escalation', async () => {
  let release = () => {};
  let serverEnding = false;
  const onEnd = vi.fn(() => new Promise((resolve) => { release = () => resolve(); }));
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session'
    ? { csrfToken: 'csrf' }
    : serverEnding ? { state: 'ending', reconnectAllowed: false, terminalReason: 'human_preference' }
      : { state: 'active', reconnectAllowed: true } })));
  render(<BrowserVoice connection={{ ...connection, hardEndAt: null }} businessName="Bayside" mode="business_demo" onEnd={onEnd} />);
  await screen.findByText(/Waiting for Blake’s audio/i);
  const room = livekit.room;
  serverEnding = true;
  await waitFor(() => expect(onEnd).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
  expect(onEnd).toHaveBeenCalledOnce();
  expect(room.disconnect).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(room.disconnect).toHaveBeenCalledOnce());
});

it('disconnects immediately when the visitor ends the call', async () => {
  const onEnd = vi.fn(() => new Promise(() => {}));
  render(<BrowserVoice connection={connection} businessName="Bayside" mode="business_demo" onEnd={onEnd} />);
  await screen.findByText(/Waiting for Blake’s audio/i);
  const room = livekit.room;
  await userEvent.click(screen.getByRole('button', { name: 'End call' }));
  expect(room.disconnect).toHaveBeenCalledOnce();
});

const connection = { demoId: '11111111-1111-4111-8111-111111111111', participantToken: 'token', livekitUrl: 'wss://voice.example.test', tokenExpiresAt: '2099-01-01T00:00:00Z', setupDeadlineAt: '2099-01-01T00:00:00Z', hardEndAt: '2099-01-01T00:00:00Z' };

it.each([null, {}, { state: 'active' }, { state: 'provisioning', reconnectAllowed: true }])('requires explicit active authorization after an ambiguous status %j', async (status) => {
  /** @type {{state?: string, reconnectAllowed?: boolean, terminalReason?: string} | null} */
  let currentStatus = status;
  vi.stubGlobal('fetch', vi.fn(async (path) => {
    if (path === '/v1/session') return { ok: true, json: async () => ({ csrfToken: 'csrf' }) };
    if (!currentStatus) throw new Error('Network unavailable');
    return { ok: true, json: async () => currentStatus };
  }));
  const onEnd = vi.fn(async () => {});
  render(<BrowserVoice connection={connection} businessName="Bayside" mode="business_demo" onEnd={onEnd} />);
  await screen.findByText(/Waiting for Blake’s audio/i);
  const originalRoom = livekit.room;
  livekit.handlers.disconnected();
  await screen.findByRole('button', { name: 'Check again' });
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'End call' })).toBeInTheDocument();
  currentStatus = { state: 'active', reconnectAllowed: true };
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByRole('button', { name: 'Reconnect' });
  // The session ends after the status retry, before the user clicks Reconnect.
  currentStatus = { state: 'ended', reconnectAllowed: false, terminalReason: 'human_preference' };
  await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ reason: 'human_preference' })));
  expect(livekit.room).toBe(originalRoom);
});

it('reconnects only after a fresh active status allows it', async () => {
  const fetchMock = vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session' ? { csrfToken: 'csrf' } : { state: 'active', reconnectAllowed: true } }));
  vi.stubGlobal('fetch', fetchMock);
  render(<BrowserVoice connection={connection} businessName="Bayside" mode="business_demo" onEnd={() => {}} />);
  await screen.findByText(/Waiting for Blake’s audio/i);
  const originalRoom = livekit.room;
  livekit.handlers.disconnected();
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  await screen.findByText(/Waiting for Blake’s audio/i);
  expect(livekit.room).not.toBe(originalRoom);
  expect(fetchMock.mock.calls.filter(([path]) => path === `/v1/demos/${connection.demoId}`)).toHaveLength(2);
});

it('honors terminal status before accepting its hard deadline', async () => {
  const onEnd = vi.fn(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session' ? { csrfToken: 'csrf' } : { state: 'ended', reconnectAllowed: false, terminalReason: 'human_preference', hardEndAt: '2099-01-01T00:00:00Z' } })));
  render(<BrowserVoice connection={{ ...connection, hardEndAt: null }} businessName="Bayside" mode="business_demo" onEnd={onEnd} />);
  await waitFor(() => expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ reason: 'human_preference' })));
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
});

it('allows an authorized reconnect after the initial setup window expires', async () => {
  const initialTime = Date.parse('2026-09-24T10:00:00Z');
  const now = vi.spyOn(Date, 'now').mockReturnValue(initialTime);
  vi.stubGlobal('fetch', vi.fn(async (path) => ({ ok: true, json: async () => path === '/v1/session' ? { csrfToken: 'csrf' } : { state: 'active', reconnectAllowed: true } })));
  render(<BrowserVoice connection={{ ...connection, setupDeadlineAt: new Date(initialTime + 20_000).toISOString(), hardEndAt: new Date(initialTime + 180_000).toISOString() }} businessName="Bayside" mode="business_demo" onEnd={() => {}} />);
  await screen.findByText(/Waiting for Blake’s audio/i);
  const originalRoom = livekit.room;
  now.mockReturnValue(initialTime + 30_000);
  livekit.handlers.disconnected();
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
  await screen.findByText(/Waiting for Blake’s audio/i);
  expect(livekit.room).not.toBe(originalRoom);
  expect(screen.queryByText('The connection timed out')).not.toBeInTheDocument();
});
