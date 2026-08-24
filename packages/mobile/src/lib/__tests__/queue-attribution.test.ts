import { describe, it, expect } from 'vitest';
import type { QueueItemUser } from '@boardsesh/queue';
import { resolveQueueRowAttribution } from '../queue-attribution';

const peer: QueueItemUser = { id: 'peer-1', username: 'Mina', avatarUrl: 'https://cdn/mina.png' };
const viewer = { showAddedBy: true, viewerUserId: 'me' };

describe('resolveQueueRowAttribution', () => {
  it('renders nothing when attribution is switched off (no session)', () => {
    expect(resolveQueueRowAttribution(peer, { showAddedBy: false, viewerUserId: 'me' })).toBeNull();
  });

  it('renders nothing for a legacy item with no addedByUser', () => {
    expect(resolveQueueRowAttribution(undefined, viewer)).toBeNull();
  });

  it('renders nothing when the server sent an explicit null', () => {
    expect(resolveQueueRowAttribution(null, viewer)).toBeNull();
  });

  it('renders nothing for an empty username even with an avatar', () => {
    expect(
      resolveQueueRowAttribution({ id: 'peer-1', username: '', avatarUrl: 'https://cdn/x.png' }, viewer),
    ).toBeNull();
  });

  it('renders nothing for a whitespace-only username', () => {
    expect(resolveQueueRowAttribution({ id: 'peer-1', username: '   ', avatarUrl: null }, viewer)).toBeNull();
  });

  it('renders nothing for the viewers own add', () => {
    expect(resolveQueueRowAttribution({ id: 'me', username: 'Marco', avatarUrl: null }, viewer)).toBeNull();
  });

  it('still renders when the viewer id is unknown', () => {
    expect(
      resolveQueueRowAttribution(
        { id: 'me', username: 'Marco', avatarUrl: null },
        {
          showAddedBy: true,
          viewerUserId: null,
        },
      ),
    ).toEqual({ name: 'Marco', avatarUrl: null });
  });

  it('renders a peer with no avatar as initials-only attribution', () => {
    expect(resolveQueueRowAttribution({ id: 'peer-1', username: 'Mina', avatarUrl: null }, viewer)).toEqual({
      name: 'Mina',
      avatarUrl: null,
    });
  });

  it('normalises an absent avatarUrl to null', () => {
    expect(resolveQueueRowAttribution({ id: 'peer-1', username: 'Mina' }, viewer)).toEqual({
      name: 'Mina',
      avatarUrl: null,
    });
  });

  it('returns the peers name and avatar', () => {
    expect(resolveQueueRowAttribution(peer, viewer)).toEqual({ name: 'Mina', avatarUrl: 'https://cdn/mina.png' });
  });

  it('does not leak the user id into the render payload', () => {
    const resolved = resolveQueueRowAttribution(peer, viewer);
    expect(resolved && Object.keys(resolved).sort()).toEqual(['avatarUrl', 'name']);
  });
});
