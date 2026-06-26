import { describe, it, expect } from 'vitest';
import { deriveAccessoryContext } from '../accessory-context';

describe('deriveAccessoryContext', () => {
  it('disconnected → resume tier with an up-next eyebrow and a usable tick', () => {
    const context = deriveAccessoryContext({ boardConnection: 'disconnected', holderDisplayName: null, enabled: true });
    expect(context.tier).toBe('resume');
    expect(context.eyebrow).toEqual({ kind: 'upNext', name: null });
    expect(context.showTick).toBe(true);
  });

  it('connectedByMe → now-playing tier with a live eyebrow and the tick enabled', () => {
    const context = deriveAccessoryContext({
      boardConnection: 'connectedByMe',
      holderDisplayName: null,
      enabled: true,
    });
    expect(context.tier).toBe('nowPlaying');
    expect(context.eyebrow).toEqual({ kind: 'live', name: null });
    expect(context.showTick).toBe(true);
  });

  it('heldByPeer → now-playing tier, names the peer, and hides the tick', () => {
    const context = deriveAccessoryContext({ boardConnection: 'heldByPeer', holderDisplayName: 'Tara', enabled: true });
    expect(context.tier).toBe('nowPlaying');
    expect(context.eyebrow).toEqual({ kind: 'peer', name: 'Tara' });
    expect(context.showTick).toBe(false);
  });

  it('heldByPeer with no resolved name keeps the peer kind and a null name', () => {
    const context = deriveAccessoryContext({ boardConnection: 'heldByPeer', holderDisplayName: null, enabled: true });
    expect(context.eyebrow).toEqual({ kind: 'peer', name: null });
    expect(context.showTick).toBe(false);
  });

  it('ignores a stray holder name when you are the one driving', () => {
    const context = deriveAccessoryContext({
      boardConnection: 'connectedByMe',
      holderDisplayName: 'Tara',
      enabled: true,
    });
    expect(context.eyebrow).toEqual({ kind: 'live', name: null });
  });

  it('disabled → no eyebrow and the tick always shows, regardless of board state', () => {
    for (const boardConnection of ['disconnected', 'connectedByMe', 'heldByPeer'] as const) {
      const context = deriveAccessoryContext({ boardConnection, holderDisplayName: 'Tara', enabled: false });
      expect(context.eyebrow).toBeNull();
      expect(context.showTick).toBe(true);
    }
  });

  it('only the peer state suppresses the tick (when enabled)', () => {
    const states = ['disconnected', 'connectedByMe', 'heldByPeer'] as const;
    const tickByState = Object.fromEntries(
      states.map((boardConnection) => [
        boardConnection,
        deriveAccessoryContext({ boardConnection, holderDisplayName: 'x', enabled: true }).showTick,
      ]),
    );
    expect(tickByState).toEqual({ disconnected: true, connectedByMe: true, heldByPeer: false });
  });
});
