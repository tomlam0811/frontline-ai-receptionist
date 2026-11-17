import { describe, expect, it } from 'vitest';
import { createLiveKitAdapter } from '../../server/livekit-adapter.js';

// PO-C18: a reconnect token for the same room. The token is signed for real; no LiveKit server is contacted.
const config = { livekitUrl: 'wss://voice.test', apiKey: 'test-key', apiSecret: 'test-secret-that-is-long-enough-for-hs256' };
const demo = { id: 'demo-abc', roomName: 'frontline-demo-demo-abc' };
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

describe('issueParticipantToken', () => {
  it('signs a join token for the demo room and the demo visitor only', async () => {
    const adapter = createLiveKitAdapter(config);
    const issued = await adapter.issueParticipantToken(demo);
    expect(issued).toMatchObject({ livekitUrl: 'wss://voice.test', participantToken: expect.any(String) });
    const claims = claimsOf(issued.participantToken);
    expect(claims).toMatchObject({ iss: 'test-key', sub: 'visitor-demo-abc', video: { roomJoin: true, room: 'frontline-demo-demo-abc', canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false, roomRecord: false, canPublishSources: ['microphone'] } });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(7 * 60);
    const expiry = Date.parse(issued.tokenExpiresAt);
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 7 * 60_000);
  });

  it('issues a new token each time for the same room', async () => {
    const adapter = createLiveKitAdapter(config);
    const first = await adapter.issueParticipantToken(demo);
    const second = await adapter.issueParticipantToken({ ...demo });
    expect(claimsOf(first.participantToken).video.room).toBe(claimsOf(second.participantToken).video.room);
  });

  it('refuses an unsafe room or demo id, and does nothing when voice is not configured', async () => {
    const adapter = createLiveKitAdapter(config);
    await expect(adapter.issueParticipantToken({ id: 'demo-abc', roomName: 'room with spaces' })).rejects.toThrow('Invalid room name');
    await expect(adapter.issueParticipantToken({ id: '../x', roomName: 'frontline-demo-x' })).rejects.toThrow('Invalid demo ID');
    const unconfigured = createLiveKitAdapter({ livekitUrl: '', apiKey: '', apiSecret: '' });
    await expect(unconfigured.issueParticipantToken(demo)).rejects.toThrow('voice_unavailable');
  });
});
