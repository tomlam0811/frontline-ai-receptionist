// The browser `livekit-client` Room needs WebRTC, which jsdom does not have. Component tests replace only this
// module (`vi.mock('livekit-client', () => import('./fake-livekit.js'))`). Everything else in those tests is real.

export const fakeRooms = [];
export const fakeLivekit = {
  failConnect: false,
  microphoneError: null,
  reset() { fakeRooms.length = 0; this.failConnect = false; this.microphoneError = null; },
};

export const RoomEvent = {
  TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed', AudioPlaybackStatusChanged: 'audioPlaybackChanged',
  ActiveSpeakersChanged: 'activeSpeakersChanged', Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected',
};
export const Track = { Kind: { Audio: 'audio' } };

export class Room {
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.streams = {};
    this.canPlayAudio = true;
    this.connected = false;
    this.disconnects = 0;
    this.microphone = [];
    this.localParticipant = {
      identity: 'visitor-local',
      setMicrophoneEnabled: async (on) => {
        if (fakeLivekit.microphoneError) throw Object.assign(new Error('blocked'), { name: fakeLivekit.microphoneError });
        this.microphone.push(on);
      },
    };
    fakeRooms.push(this);
  }
  on(event, handler) { (this.handlers[event] ??= []).push(handler); return this; }
  emit(event, ...args) { for (const handler of this.handlers[event] ?? []) handler(...args); }
  registerTextStreamHandler(topic, handler) { this.streams[topic] = handler; }
  /** Delivers a final caption from `identity`, like the voice worker's transcription stream. */
  caption(identity, text, segment = 's1') {
    return this.streams['lk.transcription']?.({ readAll: async () => text, info: { attributes: { 'lk.transcription_final': 'true', 'lk.segment_id': segment } } }, { identity });
  }
  async connect(url, token) {
    this.url = url; this.token = token;
    if (fakeLivekit.failConnect) throw new Error('cannot join');
    this.connected = true;
  }
  async startAudio() {}
  disconnect() { this.connected = false; this.disconnects += 1; }
}
