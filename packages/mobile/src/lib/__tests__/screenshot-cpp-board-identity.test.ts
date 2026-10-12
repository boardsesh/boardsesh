import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveScreenshotCppBoard, screenshotCppBoardMatches } from '../screenshot-cpp-board-identity';

const correct = {
  uuid: 'verified-board',
  name: "Test User's Kilter Homewall 7×10",
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '27,26',
  angle: 40,
  createdAt: '2026-10-11T23:00:00Z',
};
const wrong = { ...correct, uuid: 'old-board', sizeId: 19, setIds: '27' };
const identity = { boardType: 'kilter', layoutId: 8, sizeId: 17, setIds: [26, 27], angle: 40 };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('verified CPP native board identity', () => {
  it('selects the exact geometry despite duplicate names and roster ordering', () => {
    expect(resolveScreenshotCppBoard([wrong, correct], correct.name, identity)).toBe(correct);
    expect(resolveScreenshotCppBoard([correct, wrong], correct.name, identity)).toBe(correct);
    expect(screenshotCppBoardMatches(wrong, correct.name, identity)).toBe(false);
  });

  it('requires the verified UUID when the account has two matching configurations', () => {
    const copied = { ...correct, uuid: 'copied-board' };
    expect(resolveScreenshotCppBoard([correct, copied], correct.name, identity)).toBeNull();
    expect(resolveScreenshotCppBoard([copied, correct], correct.name, { ...identity, uuid: correct.uuid })).toBe(
      correct,
    );
    expect(resolveScreenshotCppBoard([wrong], correct.name, { ...identity, uuid: correct.uuid })).toBeNull();
  });

  it('resolves screenshotBoardIndex using the same command identity and never positional fallback', async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_CPP_URL', 'http://localhost:19870/cpp');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_BOARDS', `${correct.name}|${correct.name}`);
    vi.stubEnv(
      'EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS',
      JSON.stringify({
        'hero-2': { selector: correct.name, identity: { ...identity, uuid: correct.uuid }, route: '/climbs' },
      }),
    );
    const { resolveScreenshotBoard } = await import('../screenshot-board-selection');
    expect(resolveScreenshotBoard([wrong, correct], 1)).toBe(correct);
    expect(resolveScreenshotBoard([wrong], 1)).toBeNull();
    expect(resolveScreenshotBoard([wrong, correct], 0)).toBeNull();
  });

  it('keeps spray wall aliases bound to their verified real UUID', () => {
    const wall = { ...correct, uuid: 'real-liz', name: 'Home Spray Wall', boardType: 'spray' };
    const copy = { ...wall, uuid: 'unrelated-spray' };
    expect(resolveScreenshotCppBoard([copy, wall], wall.name, { uuid: wall.uuid, boardType: 'spray' })).toBe(wall);
  });
});
