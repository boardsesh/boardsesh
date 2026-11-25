// Every gym screen is registered twice: on the root stack and, as a one-line
// re-export, in the board picker's modal stack. A root route pushed from inside
// the picker is presented as a second sheet (expo-router presents a route with
// no `presentation` as a modal when a modal sits under it), so each opener has
// to pick the copy in the stack it stands in.
import { describe, expect, it } from 'vitest';
import { gymAnalyticsHref, gymEditHref, gymMapHref, gymPageHref, gymPageStackForSegments } from '../gym-page-route';

describe('gymPageStackForSegments', () => {
  it.each([
    [['boards'], 'boards'],
    [['boards', 'gyms'], 'boards'],
    [['boards', 'gym', '[gym]'], 'boards'],
    [['gyms'], 'root'],
    [['gyms', '[gym]'], 'root'],
    [['(tabs)', 'home'], 'root'],
    [[], 'root'],
  ] as const)('reads %j as the %s stack', (segments, stack) => {
    expect(gymPageStackForSegments(segments)).toBe(stack);
  });
});

describe('the gym screens per stack', () => {
  it('opens the map, the page, the editor and the insights inside the picker', () => {
    expect(gymMapHref('boards', { from: 'picker' })).toEqual({ pathname: '/boards/gyms', params: { from: 'picker' } });
    expect(gymPageHref('gym-1', 'boards')).toEqual({ pathname: '/boards/gym/[gym]', params: { gym: 'gym-1' } });
    expect(gymEditHref('gym-1', 'boards')).toEqual({ pathname: '/boards/gyms/edit', params: { gymUuid: 'gym-1' } });
    expect(gymAnalyticsHref('gym-1', 'boards')).toEqual({
      pathname: '/boards/gyms/analytics',
      params: { gymUuid: 'gym-1' },
    });
  });

  it('opens the root copies from the root stack', () => {
    expect(gymMapHref('root')).toEqual({ pathname: '/gyms', params: {} });
    expect(gymPageHref('gym-1', 'root')).toEqual({ pathname: '/gyms/[gym]', params: { gym: 'gym-1' } });
    expect(gymEditHref('gym-1', 'root')).toEqual({ pathname: '/gyms/edit', params: { gymUuid: 'gym-1' } });
    expect(gymAnalyticsHref('gym-1', 'root')).toEqual({ pathname: '/gyms/analytics', params: { gymUuid: 'gym-1' } });
  });
});
