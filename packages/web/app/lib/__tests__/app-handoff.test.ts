import { describe, it, expect } from 'vite-plus/test';
import { buildAppHandoffUrl, buildAppCreateClimbUrl } from '../app-handoff';

/**
 * The "Climb this" hand-off (#4369) is APP_URL plus the same pathname, with any
 * locale prefix stripped. It replaces `mapToExpoWebTarget`, which returned
 * `null` for every `/b` and named-slug form — the `/b` case below is that gap.
 */
const CLIMB_PATH = '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-ABC123';
const EXPECTED_CLIMB_URL = `https://app.boardsesh.com${CLIMB_PATH}`;

describe('buildAppHandoffUrl', () => {
  it('joins APP_URL to a canonical climb-view path', () => {
    expect(buildAppHandoffUrl(CLIMB_PATH)).toBe(EXPECTED_CLIMB_URL);
  });

  /**
   * The reason the helper takes no locale argument: the app has no `/es`, `/fr`
   * or `/de` routes, and a caller that had to thread the active locale could
   * leak one into the URL by forgetting to.
   */
  it('strips every supported locale prefix, not just one', () => {
    for (const prefix of ['/es', '/fr', '/de']) {
      expect(buildAppHandoffUrl(`${prefix}${CLIMB_PATH}`)).toBe(EXPECTED_CLIMB_URL);
    }
  });

  it('maps a bare locale root to the app root', () => {
    expect(buildAppHandoffUrl('/fr')).toBe('https://app.boardsesh.com/');
  });

  it('carries a /b board-slug path through instead of dropping it', () => {
    expect(buildAppHandoffUrl('/b/my-kilter/40/list')).toBe('https://app.boardsesh.com/b/my-kilter/40/list');
  });

  it('adds exactly one leading slash to a path that has none', () => {
    expect(buildAppHandoffUrl('kilter/original/12x12-square/screw_bolt/40/list')).toBe(
      'https://app.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list',
    );
  });

  it('drops a query string or fragment, keeping the pathname contract', () => {
    expect(buildAppHandoffUrl('/kilter/original/12x12-square/screw_bolt/40/list?sort=new&page=2')).toBe(
      'https://app.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list',
    );
    expect(buildAppHandoffUrl(`/es${CLIMB_PATH}#beta`)).toBe(EXPECTED_CLIMB_URL);
  });

  it('never produces a protocol-relative double slash', () => {
    const paths = [
      CLIMB_PATH,
      `/es${CLIMB_PATH}`,
      '/fr',
      '/b/my-kilter/40/list',
      'kilter/original/12x12-square/screw_bolt/40/list',
    ];
    for (const path of paths) {
      expect(new URL(buildAppHandoffUrl(path)).pathname.startsWith('//')).toBe(false);
    }
  });

  it('is idempotent on a path that carries no locale prefix', () => {
    expect(buildAppHandoffUrl(CLIMB_PATH)).toBe(buildAppHandoffUrl(`/es${CLIMB_PATH}`));
  });
});

describe('create-climb handoff rules', () => {
  const board = { boardName: 'woods' as const, layoutId: 1, sizeId: 2, setIds: [1], angle: 40 };

  it.each([
    { characteristics: [] },
    { characteristics: ['no_match', 'any_feet'] },
    { characteristics: ['campus', 'no_kickboard'] },
  ])('preserves explicit rule metadata: $characteristics', ({ characteristics }) => {
    const url = new URL(buildAppCreateClimbUrl(board, { frames: 'p0r4p1r3', characteristics }));
    expect(JSON.parse(url.searchParams.get('forkCharacteristics')!)).toEqual(characteristics);
    expect(url.searchParams.get('sizeId')).toBe('2');
  });

  it('keeps unknown rules absent for the legacy fallback', () => {
    const url = new URL(buildAppCreateClimbUrl(board, { description: 'No match\nOld climb', characteristics: null }));
    expect(url.searchParams.has('forkCharacteristics')).toBe(false);
    expect(url.searchParams.get('forkDescription')).toBe('No match\nOld climb');
  });
});
