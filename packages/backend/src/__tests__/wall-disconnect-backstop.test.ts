/**
 * Tests for the room manager's WS-close crash backstop publishing a
 * session-scoped `WallDisconnected` event.
 *
 * When a connection that held a board-writer slot closes (crash / unclean
 * disconnect) without first calling `reportWallDisconnect`, the backstop
 * (`clearBoardWriterForConnection`) frees the wall AND — when that connection
 * was bound to a session — tells the session's members the wall connection
 * dropped via `WallDisconnected { disconnectedByParticipantId: null }`, so their
 * "climb is lit" lightbulb clears even though the device couldn't send the
 * mutation. `null` flags it as a system/crash backstop, not an explicit report.
 *
 * The board-writer slot lives in Redis (clearBoardWriterIf). We spy on the
 * pubsub singleton's Redis-backed methods so the test runs without Redis and
 * focuses on the room-manager fan-out logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import type { BoardLayersSnapshot } from '@boardsesh/shared-schema';
import { commitBoardLayersForConnection } from '../graphql/resolvers/board-presence/mutations';
import { roomManager } from '../services/room-manager';
import { pubsub } from '../pubsub/index';
import { createBarrier, handleLater } from './helpers/concurrency';

describe('room manager WallDisconnected crash backstop', () => {
  let clearBoardWriterIfSpy: ReturnType<typeof vi.spyOn>;
  let nextBoardSeqSpy: ReturnType<typeof vi.spyOn>;
  let publishBoardPresenceSpy: ReturnType<typeof vi.spyOn>;
  let publishSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    roomManager.reset();
    // Spy on the singleton pubsub directly — the room manager grabs the
    // `pubsub` reference at import time, so module-mocking can race the
    // singleton; spying on existing methods avoids that ordering hazard.
    nextBoardSeqSpy = vi.spyOn(pubsub, 'nextBoardSeq').mockResolvedValue(7);
    publishBoardPresenceSpy = vi.spyOn(pubsub, 'publishBoardPresenceEvent').mockImplementation(() => {});
    publishSessionSpy = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    roomManager.reset();
  });

  it('publishes WallDisconnected to the session when a board-writer connection in a session closes', async () => {
    // The compare-and-delete cleared a real hold (this connection still held it).
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);
    vi.spyOn(pubsub, 'getBoardWriter').mockResolvedValue('emitter-1');

    const connectionId = 'conn-backstop-1';
    await roomManager.registerClient(connectionId);
    // Bind the connection to a session (the in-memory client record is what the
    // backstop reads sessionId from).
    const client = roomManager.getClient(connectionId);
    expect(client).toBeDefined();
    client!.sessionId = 'session-backstop-1';
    roomManager.noteBoardWriter(connectionId, 4242, 'emitter-1');

    await roomManager.clearBoardWriterForConnection(connectionId);

    // Board-presence "wall went free" event still fires.
    expect(clearBoardWriterIfSpy).toHaveBeenCalledWith('4242', 'emitter-1', undefined);
    expect(publishBoardPresenceSpy).toHaveBeenCalledWith('4242', {
      __typename: 'BoardConnectionChanged',
      holder: null,
      seq: 7,
    });
    // And the session-scoped wall-disconnect signal fires with null (crash backstop).
    expect(publishSessionSpy).toHaveBeenCalledWith('session-backstop-1', {
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: null,
    });

    await roomManager.removeClient(connectionId);
  });

  it('does NOT publish WallDisconnected when the dropped board-writer connection has no session', async () => {
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);
    vi.spyOn(pubsub, 'getBoardWriter').mockResolvedValue('emitter-2');

    const connectionId = 'conn-backstop-2';
    await roomManager.registerClient(connectionId);
    // No sessionId set (sessionId stays null) — board-only connection.
    roomManager.noteBoardWriter(connectionId, 5555, 'emitter-2');

    await roomManager.clearBoardWriterForConnection(connectionId);

    // Board-presence event still fires, but no session-scoped event.
    expect(publishBoardPresenceSpy).toHaveBeenCalledOnce();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });

  it('marks a confirmed layer roster stale when its writer connection closes', async () => {
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);
    vi.spyOn(pubsub, 'getBoardWriter').mockResolvedValue('quantum-layer-emitter');
    const currentSnapshot = {
      boardId: 5656,
      layers: [],
      observedAt: '2026-08-30T00:00:00.000Z',
      stale: false,
      seq: 6,
    };
    vi.spyOn(pubsub, 'getBoardLayers').mockResolvedValue(currentSnapshot);
    const staleBoardLayersSpy = vi
      .spyOn(pubsub, 'markBoardLayersStaleIfOwned')
      .mockImplementation(async (_boardId, _emitterId, snapshot) => ({ snapshot, changed: true }));

    const connectionId = 'conn-quantum-layers-backstop';
    await roomManager.registerClient(connectionId);
    roomManager.noteBoardWriter(connectionId, currentSnapshot.boardId, 'quantum-layer-emitter', 'quantum-layer-claim');

    await roomManager.clearBoardWriterForConnection(connectionId);

    expect(staleBoardLayersSpy).toHaveBeenCalledWith('5656', 'quantum-layer-claim', {
      ...currentSnapshot,
      observedAt: expect.any(String),
      stale: true,
      seq: 7,
    });
    expect(publishBoardPresenceSpy).toHaveBeenCalledWith('5656', {
      __typename: 'BoardLayersChanged',
      snapshot: expect.objectContaining({ stale: true, seq: 7 }),
    });

    await roomManager.removeClient(connectionId);
  });

  it('compensates a layer commit that resolves after WS-close cleanup already ran', async () => {
    const boardId = 5757;
    const boardKey = String(boardId);
    const connectionId = 'conn-quantum-deferred-commit';
    const emitterId = 'quantum-deferred-emitter';
    const claimToken = `layer-connection:${connectionId}`;
    const proposedSnapshot: BoardLayersSnapshot = {
      boardId,
      layers: [],
      observedAt: '2026-08-30T00:00:00.000Z',
      stale: false,
      seq: 6,
    };
    let currentWriter: { emitterId: string; claimToken: string } | null = null;
    let currentLayers: BoardLayersSnapshot | null = null;
    let currentLayerOwner: string | null = null;
    const commitEntered = createBarrier();
    const acceptCommit = createBarrier();

    vi.spyOn(pubsub, 'commitBoardLayers').mockImplementation(
      async (_boardKey, snapshot, committingEmitterId, committingClaimToken) => {
        commitEntered.release();
        await acceptCommit.promise;
        const previousWriter = currentWriter;
        currentWriter = { emitterId: committingEmitterId, claimToken: committingClaimToken };
        currentLayers = snapshot;
        currentLayerOwner = committingClaimToken;
        return {
          snapshot,
          accepted: true,
          previousWriter: previousWriter?.emitterId ?? null,
          previousClaimToken: previousWriter?.claimToken ?? null,
        };
      },
    );
    vi.spyOn(pubsub, 'getBoardWriter').mockImplementation(async () => currentWriter?.emitterId ?? null);
    vi.spyOn(pubsub, 'getBoardLayers').mockImplementation(async () => currentLayers);
    clearBoardWriterIfSpy = vi
      .spyOn(pubsub, 'clearBoardWriterIf')
      .mockImplementation(async (_boardKey, clearingEmitterId, clearingClaimToken) => {
        if (currentWriter?.emitterId !== clearingEmitterId || currentWriter.claimToken !== clearingClaimToken) {
          return false;
        }
        currentWriter = null;
        return true;
      });
    vi.spyOn(pubsub, 'markBoardLayersStaleIfOwned').mockImplementation(
      async (_boardKey, expectedOwner, staleSnapshot) => {
        if (currentLayers === null) return null;
        if (currentLayerOwner !== expectedOwner) return { snapshot: currentLayers, changed: false };
        currentLayers = staleSnapshot;
        return { snapshot: staleSnapshot, changed: true };
      },
    );

    await roomManager.registerClient(connectionId);
    const reportPromise = commitBoardLayersForConnection({
      boardId,
      proposedSnapshot,
      emitterId,
      layerClaimToken: claimToken,
      connectionId,
      userId: null,
    });
    handleLater(reportPromise);
    await commitEntered.promise;

    // The close path sees no pre-commit note and returns. The client record is
    // deliberately retained until after commit resolution to pin the smaller
    // race where onDisconnect has resumed but removeClient has not run yet.
    await roomManager.clearBoardWriterForConnection(connectionId);
    acceptCommit.release();

    await expect(reportPromise).resolves.toMatchObject({ stale: true, seq: 7 });
    expect(currentWriter).toBeNull();
    expect(currentLayers).toMatchObject({ stale: true, seq: 7 });
    expect(clearBoardWriterIfSpy).toHaveBeenCalledWith(boardKey, emitterId, claimToken);
    expect(publishBoardPresenceSpy).toHaveBeenNthCalledWith(1, boardKey, {
      __typename: 'BoardConnectionChanged',
      holder: null,
      seq: 7,
    });
    expect(publishBoardPresenceSpy).toHaveBeenNthCalledWith(2, boardKey, {
      __typename: 'BoardLayersChanged',
      snapshot: expect.objectContaining({ stale: true, seq: 7 }),
    });
    expect(publishBoardPresenceSpy).toHaveBeenCalledTimes(2);

    await roomManager.removeClient(connectionId);
  });

  it("does not let an old same-user connection's compensation clear a reconnect", async () => {
    const boardId = 5858;
    const boardKey = String(boardId);
    const emitterId = 'shared-quantum-user';
    const oldConnectionId = 'conn-quantum-old';
    const newConnectionId = 'conn-quantum-new';
    const oldClaimToken = `layer-connection:${oldConnectionId}`;
    const newClaimToken = `layer-connection:${newConnectionId}`;
    const oldSnapshot: BoardLayersSnapshot = {
      boardId,
      layers: [],
      observedAt: '2026-08-30T00:00:00.000Z',
      stale: false,
      seq: 6,
    };
    const newSnapshot: BoardLayersSnapshot = {
      ...oldSnapshot,
      observedAt: '2026-08-30T00:01:00.000Z',
      seq: 8,
    };
    let currentWriter: { emitterId: string; claimToken: string } | null = null;
    let currentLayers: BoardLayersSnapshot | null = null;
    let currentLayerOwner: string | null = null;
    const oldClearEntered = createBarrier();
    const finishOldClear = createBarrier();

    vi.spyOn(pubsub, 'commitBoardLayers').mockImplementation(
      async (_boardKey, snapshot, committingEmitterId, committingClaimToken) => {
        const previousWriter = currentWriter;
        currentWriter = { emitterId: committingEmitterId, claimToken: committingClaimToken };
        currentLayers = snapshot;
        currentLayerOwner = committingClaimToken;
        return {
          snapshot,
          accepted: true,
          previousWriter: previousWriter?.emitterId ?? null,
          previousClaimToken: previousWriter?.claimToken ?? null,
        };
      },
    );
    vi.spyOn(pubsub, 'getBoardWriter').mockImplementation(async () => currentWriter?.emitterId ?? null);
    vi.spyOn(pubsub, 'getBoardLayers').mockImplementation(async () => currentLayers);
    clearBoardWriterIfSpy = vi
      .spyOn(pubsub, 'clearBoardWriterIf')
      .mockImplementation(async (_boardKey, clearingEmitterId, clearingClaimToken) => {
        if (clearingClaimToken === oldClaimToken) {
          oldClearEntered.release();
          await finishOldClear.promise;
        }
        if (currentWriter?.emitterId !== clearingEmitterId || currentWriter.claimToken !== clearingClaimToken) {
          return false;
        }
        currentWriter = null;
        return true;
      });
    const staleSpy = vi
      .spyOn(pubsub, 'markBoardLayersStaleIfOwned')
      .mockImplementation(async (_boardKey, expectedOwner, staleSnapshot) => {
        if (currentLayers === null) return null;
        if (currentLayerOwner !== expectedOwner) return { snapshot: currentLayers, changed: false };
        currentLayers = staleSnapshot;
        return { snapshot: staleSnapshot, changed: true };
      });

    await roomManager.registerClient(oldConnectionId, undefined, emitterId);
    await roomManager.clearBoardWriterForConnection(oldConnectionId);
    await roomManager.removeClient(oldConnectionId);
    const oldReportPromise = commitBoardLayersForConnection({
      boardId,
      proposedSnapshot: oldSnapshot,
      emitterId,
      layerClaimToken: oldClaimToken,
      connectionId: oldConnectionId,
      userId: emitterId,
    });
    handleLater(oldReportPromise);
    await oldClearEntered.promise;

    await roomManager.registerClient(newConnectionId, undefined, emitterId);
    await expect(
      commitBoardLayersForConnection({
        boardId,
        proposedSnapshot: newSnapshot,
        emitterId,
        layerClaimToken: newClaimToken,
        connectionId: newConnectionId,
        userId: emitterId,
      }),
    ).resolves.toEqual(newSnapshot);

    finishOldClear.release();
    await expect(oldReportPromise).resolves.toEqual(oldSnapshot);
    expect(currentWriter).toEqual({ emitterId, claimToken: newClaimToken });
    expect(currentLayers).toEqual(newSnapshot);
    expect(staleSpy).not.toHaveBeenCalled();
    expect(publishBoardPresenceSpy).not.toHaveBeenCalledWith(boardKey, {
      __typename: 'BoardConnectionChanged',
      holder: null,
      seq: 7,
    });

    await roomManager.removeClient(newConnectionId);
  });

  it('does NOT publish WallDisconnected when the connection no longer held the board (always-take hand-off)', async () => {
    // Compare-and-delete returns false: another emitter has taken over, so this
    // connection's drop must not fire either the board or the session event.
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(false);
    vi.spyOn(pubsub, 'getBoardWriter').mockResolvedValue('emitter-3');

    const connectionId = 'conn-backstop-3';
    await roomManager.registerClient(connectionId);
    const client = roomManager.getClient(connectionId);
    client!.sessionId = 'session-backstop-3';
    roomManager.noteBoardWriter(connectionId, 6666, 'emitter-3');

    await roomManager.clearBoardWriterForConnection(connectionId);

    expect(clearBoardWriterIfSpy).toHaveBeenCalledWith('6666', 'emitter-3', undefined);
    // A sequence is reserved before compare-and-delete so any successful
    // handoff that races this old disconnect receives a newer value.
    expect(nextBoardSeqSpy).toHaveBeenCalledWith('6666');
    expect(publishBoardPresenceSpy).not.toHaveBeenCalled();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });

  it('is a safe no-op when the connection never held a board', async () => {
    clearBoardWriterIfSpy = vi.spyOn(pubsub, 'clearBoardWriterIf').mockResolvedValue(true);

    const connectionId = 'conn-backstop-4';
    await roomManager.registerClient(connectionId);
    const client = roomManager.getClient(connectionId);
    client!.sessionId = 'session-backstop-4';
    // No noteBoardWriter call — no hold recorded.

    await roomManager.clearBoardWriterForConnection(connectionId);

    expect(clearBoardWriterIfSpy).not.toHaveBeenCalled();
    expect(publishBoardPresenceSpy).not.toHaveBeenCalled();
    expect(publishSessionSpy).not.toHaveBeenCalled();

    await roomManager.removeClient(connectionId);
  });
});
