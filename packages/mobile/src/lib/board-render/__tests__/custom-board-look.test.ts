import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

const { DEFAULT_BOARDSESH_RENDER_SETTINGS } = await import('../../board-render-settings');
const { clearCustomBoardLook, loadCustomBoardLook, rememberCustomBoardLook } = await import('../custom-board-look');

beforeEach(() => storage.clear());
afterEach(() => storage.clear());

describe('custom board look', () => {
  it('is null until the climber has tuned something', async () => {
    expect(await loadCustomBoardLook()).toBeNull();
  });

  it('survives a preset being applied over the live settings', async () => {
    // The whole point: applying a preset overwrites every Boardsesh field, so
    // without a copy kept aside, trying "Subtle" to compare would destroy a
    // tuned look with no undo.
    const tuned = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowReach: 1.45, veil: 'strong' as const };
    await rememberCustomBoardLook(tuned);

    expect(await loadCustomBoardLook()).toMatchObject({ glowReach: 1.45, veil: 'strong' });
  });

  it('sanitises what it hands back', async () => {
    // A bundle written by a newer build — or hand-edited — can carry anything,
    // and a NaN reach reaches the Rust renderer as a config it silently falls
    // back on.
    storage.set('boardLookCustomSettings', JSON.stringify({ glowReach: 999, veil: 'not-a-veil' }));

    const restored = await loadCustomBoardLook();

    expect(restored?.glowReach).toBe(2); // clamped to the slider's max
    expect(restored?.veil).toBe(DEFAULT_BOARDSESH_RENDER_SETTINGS.veil);
  });

  it('is forgotten by a reset', async () => {
    await rememberCustomBoardLook(DEFAULT_BOARDSESH_RENDER_SETTINGS);

    await clearCustomBoardLook();

    expect(await loadCustomBoardLook()).toBeNull();
  });
});
