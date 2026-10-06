import { describe, expect, it, vi } from 'vitest';

vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../spray-wall-loader', () => ({ requestMissingSprayArt: vi.fn(), sprayWallArtQueryKey: () => ['k'] }));

const { SPRAY_ART_MAX_POLLS, SPRAY_ART_PENDING_POLL_MS, sprayArtRefetchInterval } =
  await import('../use-spray-wall-art');

describe('sprayArtRefetchInterval', () => {
  it('polls a live wall while its art is NONE or PENDING', () => {
    expect(sprayArtRefetchInterval('NONE', 1, true)).toBe(SPRAY_ART_PENDING_POLL_MS);
    expect(sprayArtRefetchInterval('PENDING', 1, true)).toBe(SPRAY_ART_PENDING_POLL_MS);
  });

  it.each(['READY', 'FAILED', 'REFUSED'] as const)('stops on %s', (status) => {
    expect(sprayArtRefetchInterval(status, 1, true)).toBe(false);
  });

  it('never polls a draft', () => {
    expect(sprayArtRefetchInterval('NONE', 1, false)).toBe(false);
    expect(sprayArtRefetchInterval('PENDING', 1, false)).toBe(false);
  });

  it(`stops after ${SPRAY_ART_MAX_POLLS} reads`, () => {
    expect(sprayArtRefetchInterval('PENDING', SPRAY_ART_MAX_POLLS, true)).toBe(SPRAY_ART_PENDING_POLL_MS);
    expect(sprayArtRefetchInterval('PENDING', SPRAY_ART_MAX_POLLS + 1, true)).toBe(false);
  });
});
