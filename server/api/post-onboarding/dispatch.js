import { inOwnerScope } from './database.js';
import { updateDemo } from './demo-store.js';
import { problem } from './errors.js';

// Starts the voice room for a demo that already has its reservation, and undoes the start
// safely if it fails. Shared by owner tests and shared guest calls so the failure rules
// exist once: the reservation is released only when the room is confirmed gone.

export function assertConnection(demo, connection) {
  if (connection.roomName !== demo.roomName || connection.participantIdentity !== `visitor-${demo.id}` || typeof connection.participantToken !== 'string' || typeof connection.livekitUrl !== 'string' || !Number.isFinite(Date.parse(connection.tokenExpiresAt)) || Date.parse(connection.tokenExpiresAt) > Date.now() + 7 * 60_000) throw new Error('voice dispatch response is incomplete');
}


/**
 * @param {{db: any, scopeId: string, demo: any, voice: any, failureMessage?: string, onRelease?: (tx: any) => Promise<any>}} input
 * `onRelease` runs in the same transaction that releases the paid reservation (a share link uses it to
 * return the grant to `unused`).
 */
export async function dispatchVoice({ db, scopeId, demo, voice, onRelease, failureMessage = "This can't start right now." }) {
  try {
    const connection = await voice.start(demo, { id: demo.reservationId, approved: true });
    assertConnection(demo, connection);
    await updateDemo(db, scopeId, demo.id, (current) => {
      if (current.state !== 'dispatching' || Date.parse(current.setupDeadlineAt) <= Date.now() + 5_000) throw new Error('setup deadline elapsed before dispatch completed');
      return { state: 'waiting', dispatchId: connection.dispatchId, participantIdentity: connection.participantIdentity };
    });
    return { demoId: demo.id, livekitUrl: connection.livekitUrl, participantToken: connection.participantToken, tokenExpiresAt: connection.tokenExpiresAt, setupDeadlineAt: demo.setupDeadlineAt };
  } catch {
    let roomDeleted = false;
    try { await voice.end(demo); roomDeleted = true; } catch { /* keep the reservation until the room is confirmed gone */ }
    if (roomDeleted) {
      try {
        await inOwnerScope(db, scopeId, async (tx) => {
          if (onRelease) await onRelease(tx);
          await tx.query("SELECT settle_voice_start($1::uuid,'released')", [demo.reservationId]);
        });
        await updateDemo(db, scopeId, demo.id, () => ({ state: 'failed', voiceCleanupCompleted: true }));
      } catch { /* the reservation TTL and the watchdog are the fallback */ }
    }
    throw problem(503, 'voice_unavailable', failureMessage);
  }
}
