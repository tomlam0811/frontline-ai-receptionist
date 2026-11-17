import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const livekit = vi.hoisted(() => ({ room: null }));
vi.mock('livekit-client', () => {
  class Room {
    constructor() {
      this.canPlayAudio = true;
      this.localParticipant = { identity: 'caller', setMicrophoneEnabled: vi.fn(async () => {}) };
      livekit.room = this;
    }
    on() {}
    registerTextStreamHandler() {}
    async connect() {}
    async startAudio() {}
    disconnect = vi.fn();
  }
  return { Room, RoomEvent: {}, Track: { Kind: { Audio: 'audio' } } };
});

import CallStage from '../src/components/owner/CallStage.jsx';

afterEach(() => { cleanup(); livekit.room = null; });

const connection = { demoId: '11111111-1111-4111-8111-111111111111', participantToken: 'token', livekitUrl: 'wss://voice.example.test', tokenExpiresAt: '2099-01-01T00:00:00Z', setupDeadlineAt: '2099-01-01T00:00:00Z' };

// Tom's 2026-10-02 calls: the goodbye stopped a moment after it started, because the page ended the call on the server
// (closing the room) as soon as it saw the call ending.
it('lets the goodbye finish before ending the call on the server', async () => {
  let state = 'active';
  const getStatus = vi.fn(async () => ({ ended: state !== 'active', closing: state === 'ending' }));
  const onEnd = vi.fn(async () => {});
  render(<CallStage connection={connection} label="Call with Blake" getStatus={getStatus} onEnd={onEnd} pollMs={20} name="Blake" />);
  await waitFor(() => expect(livekit.room).not.toBeNull());
  const room = livekit.room;
  state = 'ending';
  await waitFor(() => expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false));
  await new Promise((resolve) => { setTimeout(resolve, 150); });
  expect(onEnd).not.toHaveBeenCalled();
  expect(room.disconnect).not.toHaveBeenCalled();
  state = 'ended';
  await waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
  await waitFor(() => expect(room.disconnect).toHaveBeenCalled());
});
