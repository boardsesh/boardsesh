import { describe, expect, it } from 'vite-plus/test';
import { SaveClimbInputSchema, UpdateClimbInputSchema } from '../validation/schemas';

/**
 * The server's ceiling on `framesPace`, guarded in both directions.
 *
 * The number is load-bearing across two packages that can't import each other:
 * the mobile authoring control offers seconds-per-frame up to `MAX_PACE_MS`
 * (`@boardsesh/playback-react`), and a save carrying that pace has to survive
 * this schema. Drop the ceiling below the control's and a setter's slowest
 * route is rejected at save time with nothing on screen explaining why; the
 * catalogue already holds synced Aurora routes paced at exactly 60s.
 */
const MAX_FRAMES_PACE_MS = 60_000;

const saveClimb = (framesPace: number) =>
  SaveClimbInputSchema.safeParse({
    boardType: 'kilter',
    layoutId: 1,
    name: 'Endurance lap',
    isDraft: false,
    frames: 'p1r12',
    framesCount: 4,
    framesPace,
    angle: 40,
  });

const updateClimb = (framesPace: number) =>
  UpdateClimbInputSchema.safeParse({ uuid: 'climb-1', boardType: 'kilter', framesPace });

describe.each([
  { name: 'save climb', parse: saveClimb },
  { name: 'update climb', parse: updateClimb },
])('$name frames pace bounds', ({ parse }) => {
  it('accepts the slowest pace the authoring control can produce', () => {
    expect(parse(MAX_FRAMES_PACE_MS).success).toBe(true);
  });

  it('accepts a pace synced in above the old 30s ceiling', () => {
    expect(parse(45_000).success).toBe(true);
  });

  it('rejects a pace past the ceiling', () => {
    expect(parse(MAX_FRAMES_PACE_MS + 1).success).toBe(false);
  });

  it('rejects a negative pace', () => {
    expect(parse(-1).success).toBe(false);
  });

  it('keeps 0 legal — it means "use the default"', () => {
    expect(parse(0).success).toBe(true);
  });
});
