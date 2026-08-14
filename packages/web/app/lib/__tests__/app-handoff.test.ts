import { describe, it, expect } from 'vite-plus/test';
import { buildAppHandoffUrl } from '../app-handoff';

/**
 * The "Climb this" hand-off (#4369) is APP_URL plus the same pathname, with the
 * locale prefix stripped. It replaces `mapToExpoWebTarget`, which returned
 * `null` for every `/b` and named-slug form — case 4 below is exactly that gap.
 */
const CLIMB_PATH = '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-ABC123';
const EXPECTED_CLIMB_URL = `https://app.boardsesh.com${CLIMB_PATH}`;

describe('buildAppHandoffUrl', () => {
  it('joins APP_URL to a canonical climb-view path on the default locale', () => {
    expect(buildAppHandoffUrl(CLIMB_PATH)).toBe(EXPECTED_CLIMB_URL);
  });

  it('strips the locale prefix so a Spanish reader lands on the same climb', () => {
    expect(buildAppHandoffUrl(`/es${CLIMB_PATH}`, 'es')).toBe(EXPECTED_CLIMB_URL);
  });

  it('maps a bare locale root to the app root', () => {
    expect(buildAppHandoffUrl('/fr', 'fr')).toBe('https://app.boardsesh.com/');
  });

  it('carries a /b board-slug path through instead of dropping it', () => {
    expect(buildAppHandoffUrl('/b/my-kilter/40/list')).toBe('https://app.boardsesh.com/b/my-kilter/40/list');
  });

  it('adds exactly one leading slash to a path that has none', () => {
    expect(buildAppHandoffUrl('kilter/original/12x12-square/screw_bolt/40/list')).toBe(
      'https://app.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/list',
    );
  });

  it('never produces a protocol-relative double slash', () => {
    const paths: [string, 'en-US' | 'es' | 'fr' | 'de'][] = [
      [CLIMB_PATH, 'en-US'],
      [`/es${CLIMB_PATH}`, 'es'],
      ['/fr', 'fr'],
      ['/b/my-kilter/40/list', 'en-US'],
      ['kilter/original/12x12-square/screw_bolt/40/list', 'en-US'],
    ];
    for (const [path, locale] of paths) {
      expect(new URL(buildAppHandoffUrl(path, locale)).pathname.startsWith('//')).toBe(false);
    }
  });

  it('is idempotent on a path that carries no locale prefix', () => {
    expect(buildAppHandoffUrl(CLIMB_PATH, 'de')).toBe(EXPECTED_CLIMB_URL);
  });
});
