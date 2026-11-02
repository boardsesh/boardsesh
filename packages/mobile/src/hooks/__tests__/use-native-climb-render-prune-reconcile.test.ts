// Issue #5882: the overlay index handed out PNGs the native pruner had deleted.
//
// The warm-up indexes every PNG in `{cache}/board-thumbnails` at JS start. Both
// native modules then prune that directory down to 200 MB inside the first
// render of the launch, and never say which files went. Before the fix nothing
// re-checked the index, so every climb whose PNG was pruned mounted a dead URI
// for the rest of the session: a failed image load, a `cache_entry_missing`
// report, and a re-render.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Imported by path — see cache-dir-io.test.ts for why.
import { __resetFileSystem, __seedFileSystem } from '../../../test/expo-file-system-stub';

const { addErrorBreadcrumb } = vi.hoisted(() => ({ addErrorBreadcrumb: vi.fn() }));
vi.mock('../../lib/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/error-reporting')>()),
  addErrorBreadcrumb,
}));
vi.mock('../../providers/theme-provider', () => ({ useAppColorScheme: () => 'light' }));
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: vi.fn(() => null) }));
vi.mock('../../lib/background-image-cache', () => ({
  ensureBackgroundsCached: vi.fn().mockResolvedValue(null),
  tryGetBackgroundPathsSync: vi.fn().mockReturnValue(null),
}));
vi.mock('../../../modules/board-renderer/src/index', () => {
  throw new Error('Native module not available');
});

import { RENDERER_VERSION } from '../renderer-version';

const { getOrStartInflightRender, _getRenderedOverlayForTests, _resetWarmupForTests, _runWarmupForTests } =
  await import('../use-native-climb-render');

const DIR = 'cache/board-thumbnails';
const KEY_PRUNED = `v${RENDERER_VERSION}_kilter_1_10_24_aaaaaaaa`;
const KEY_KEPT = `v${RENDERER_VERSION}_kilter_1_10_24_bbbbbbbb`;
const KEY_FIRST_RENDER = `v${RENDERER_VERSION}_kilter_1_10_24_cccccccc`;
const KEY_SECOND_RENDER = `v${RENDERER_VERSION}_kilter_1_10_24_dddddddd`;

function png(cacheKey: string): string {
  return `${cacheKey}.png`;
}

beforeEach(() => {
  addErrorBreadcrumb.mockClear();
  __resetFileSystem();
  _resetWarmupForTests();
});

afterEach(() => {
  __resetFileSystem();
  _resetWarmupForTests();
});

describe('reconciling the overlay index after the native prune', () => {
  it('forgets a warm-up key whose PNG the first native render pruned', async () => {
    __seedFileSystem({ [DIR]: { [png(KEY_PRUNED)]: { size: 10 }, [png(KEY_KEPT)]: { size: 10 } } });
    _runWarmupForTests();
    expect(_getRenderedOverlayForTests(KEY_PRUNED)).toBeDefined();
    expect(_getRenderedOverlayForTests(KEY_KEPT)).toBeDefined();

    // Native's first render: prune KEY_PRUNED, then write and return its own PNG.
    __seedFileSystem({ [DIR]: { [png(KEY_KEPT)]: { size: 10 }, [png(KEY_FIRST_RENDER)]: { size: 10 } } });
    await getOrStartInflightRender(KEY_FIRST_RENDER, () => Promise.resolve(`${DIR}/${png(KEY_FIRST_RENDER)}`));

    await vi.waitFor(() => expect(_getRenderedOverlayForTests(KEY_PRUNED)).toBeUndefined());
    expect(_getRenderedOverlayForTests(KEY_KEPT)?.uri).toBe(`${DIR}/${png(KEY_KEPT)}`);
    expect(_getRenderedOverlayForTests(KEY_FIRST_RENDER)?.uri).toBe(`${DIR}/${png(KEY_FIRST_RENDER)}`);
    await vi.waitFor(() =>
      expect(addErrorBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Overlay index checked after native prune',
          data: { forgottenKeys: 1 },
        }),
      ),
    );
  });

  it('keeps the first render’s own result even if the walk cannot see its file', async () => {
    // The directory listing lags the write it just made, or the OS purged it.
    await getOrStartInflightRender(KEY_FIRST_RENDER, () => Promise.resolve(`${DIR}/${png(KEY_FIRST_RENDER)}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(_getRenderedOverlayForTests(KEY_FIRST_RENDER)).toBeDefined();
  });

  it('checks the directory once per launch, not on every render', async () => {
    __seedFileSystem({ [DIR]: { [png(KEY_FIRST_RENDER)]: { size: 10 } } });
    await getOrStartInflightRender(KEY_FIRST_RENDER, () => Promise.resolve(`${DIR}/${png(KEY_FIRST_RENDER)}`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Native prunes once per launch, so later renders have nothing to catch up
    // on and must not pay for a directory walk. Emptying the directory makes a
    // second walk visible: it would forget the first render's key.
    __seedFileSystem({ [DIR]: {} });
    await getOrStartInflightRender(KEY_SECOND_RENDER, () => Promise.resolve(`${DIR}/${png(KEY_SECOND_RENDER)}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(_getRenderedOverlayForTests(KEY_FIRST_RENDER)).toBeDefined();
    expect(_getRenderedOverlayForTests(KEY_SECOND_RENDER)).toBeDefined();
  });
});
