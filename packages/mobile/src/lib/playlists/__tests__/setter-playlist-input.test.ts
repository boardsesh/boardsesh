import { describe, it, expect } from 'vitest';
import { setterPlaylistInput } from '../setter-playlist-input';

const woodsBoard = { boardName: 'woods', layoutId: 1, sizeId: 2, setIds: '1', angle: 40 };
const kilterBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

describe('setterPlaylistInput', () => {
  it('asks for every angle on Woods, so the page lists the whole catalogue (#5642)', () => {
    expect(setterPlaylistInput('marco', woodsBoard).crossAngleStats).toBe(true);
  });

  it('leaves the cross-angle opt-in off on Kilter, where it is the slow query', () => {
    expect(setterPlaylistInput('marco', kilterBoard)).not.toHaveProperty('crossAngleStats');
  });

  it('scopes to the setter and the board it was built for', () => {
    expect(setterPlaylistInput('marco', woodsBoard)).toMatchObject({
      ...woodsBoard,
      setter: ['marco'],
      sortBy: 'creation',
      sortOrder: 'desc',
    });
  });
});
