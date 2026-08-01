import { describe, expect, it } from 'vite-plus/test';
import { PlaybackStateInputSchema } from '../validation/schemas';

const GRAPHQL_INT_MAX = 2_147_483_647;
const validPlaybackState = {
  climbUuid: '11111111-1111-1111-1111-111111111111',
  frameIndex: 0,
  isPlaying: true,
  speed: 1,
  paceMs: 200,
};

function playbackStateWith(overrides: Record<string, unknown>): unknown {
  return { ...validPlaybackState, ...overrides };
}

describe('PlaybackStateInputSchema', () => {
  it('accepts the shipped playback control and GraphQL Int boundaries', () => {
    expect(PlaybackStateInputSchema.parse(playbackStateWith({ speed: 0.5 })).speed).toBe(0.5);
    expect(
      PlaybackStateInputSchema.parse(
        playbackStateWith({
          climbUuid: 'c'.repeat(64),
          frameIndex: GRAPHQL_INT_MAX,
          speed: 10,
          paceMs: GRAPHQL_INT_MAX,
          clientId: 'c'.repeat(128),
        }),
      ),
    ).toMatchObject({
      climbUuid: 'c'.repeat(64),
      frameIndex: GRAPHQL_INT_MAX,
      speed: 10,
      paceMs: GRAPHQL_INT_MAX,
      clientId: 'c'.repeat(128),
    });
  });

  it.each([
    ['negative frame index', { frameIndex: -1 }],
    ['fractional frame index', { frameIndex: 0.5 }],
    ['frame index above GraphQL Int maximum', { frameIndex: GRAPHQL_INT_MAX + 1 }],
    ['speed below the control minimum', { speed: 0.49 }],
    ['speed above the control maximum', { speed: 10.01 }],
    ['pace below the engine floor', { paceMs: 199 }],
    ['fractional pace', { paceMs: 200.5 }],
    ['pace above GraphQL Int maximum', { paceMs: GRAPHQL_INT_MAX + 1 }],
    ['empty climb identifier', { climbUuid: '' }],
    ['overlong climb identifier', { climbUuid: 'c'.repeat(65) }],
    ['empty client identifier', { clientId: '' }],
    ['overlong client identifier', { clientId: 'c'.repeat(129) }],
  ])('rejects %s', (_description, overrides) => {
    expect(PlaybackStateInputSchema.safeParse(playbackStateWith(overrides)).success).toBe(false);
  });

  it.each([
    ['NaN frame index', { frameIndex: Number.NaN }],
    ['infinite frame index', { frameIndex: Infinity }],
    ['NaN speed', { speed: Number.NaN }],
    ['infinite speed', { speed: Infinity }],
    ['negative infinite speed', { speed: -Infinity }],
    ['NaN pace', { paceMs: Number.NaN }],
    ['infinite pace', { paceMs: Infinity }],
  ])('rejects %s', (_description, overrides) => {
    expect(PlaybackStateInputSchema.safeParse(playbackStateWith(overrides)).success).toBe(false);
  });

  it.each([
    ['string frame index', { frameIndex: '0' }],
    ['string speed', { speed: '1' }],
    ['string pace', { paceMs: '200' }],
    ['string playing state', { isPlaying: 'true' }],
    ['numeric climb identifier', { climbUuid: 1 }],
    ['numeric client identifier', { clientId: 1 }],
  ])('does not coerce a %s', (_description, overrides) => {
    expect(PlaybackStateInputSchema.safeParse(playbackStateWith(overrides)).success).toBe(false);
  });

  it.each(['climbUuid', 'frameIndex', 'isPlaying', 'speed', 'paceMs'] as const)(
    'rejects a missing required %s field',
    (missingField) => {
      const incompleteState = Object.fromEntries(
        Object.entries(validPlaybackState).filter(([fieldName]) => fieldName !== missingField),
      );
      expect(PlaybackStateInputSchema.safeParse(incompleteState).success).toBe(false);
    },
  );

  it('accepts an omitted or null client identifier for connection-id fallback', () => {
    expect(PlaybackStateInputSchema.safeParse(validPlaybackState).success).toBe(true);
    expect(PlaybackStateInputSchema.safeParse(playbackStateWith({ clientId: null })).success).toBe(true);
  });
});
