import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURE_STORE_WRITE_OPTIONS } from '../secure-store-options';

const secureStore = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('expo-secure-store', () => secureStore);

describe('access-mode-store', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStore.getItem.mockReset();
    secureStore.setItem.mockReset();
  });

  it('restores an explicit local profile choice', async () => {
    secureStore.getItem.mockReturnValue('local');
    const { readPersistedAccessMode } = await import('../access-mode-store');

    expect(readPersistedAccessMode()).toBe('local');
  });

  it.each([null, 'offline', '', 3])('defaults invalid persisted value %j to account mode', async (storedMode) => {
    secureStore.getItem.mockReturnValue(storedMode);
    const { readPersistedAccessMode } = await import('../access-mode-store');

    expect(readPersistedAccessMode()).toBe('account');
  });

  it('defaults a failed secure-store read to account mode', async () => {
    secureStore.getItem.mockImplementation(() => {
      throw new Error('keychain unavailable');
    });
    const { readPersistedAccessMode } = await import('../access-mode-store');

    expect(readPersistedAccessMode()).toBe('account');
  });

  it('persists mode independently from authentication credentials', async () => {
    const { writePersistedAccessMode } = await import('../access-mode-store');

    writePersistedAccessMode('local');

    expect(secureStore.setItem).toHaveBeenCalledWith('boardsesh_access_mode_v1', 'local', SECURE_STORE_WRITE_OPTIONS);
  });

  it('restores only an explicitly verified local catalog', async () => {
    secureStore.getItem.mockReturnValueOnce('true').mockReturnValueOnce('false');
    const { readPersistedLocalCatalogReady } = await import('../access-mode-store');

    expect(readPersistedLocalCatalogReady()).toBe(true);
    expect(readPersistedLocalCatalogReady()).toBe(false);
  });

  it('persists the durable-catalog gate separately from access mode', async () => {
    const { writePersistedLocalCatalogReady } = await import('../access-mode-store');

    writePersistedLocalCatalogReady(true);

    expect(secureStore.setItem).toHaveBeenCalledWith(
      'boardsesh_local_catalog_ready_v1',
      'true',
      SECURE_STORE_WRITE_OPTIONS,
    );
  });

  it('persists the post-sign-in local import prompt separately', async () => {
    secureStore.getItem.mockReturnValue('true');
    const { readPendingLocalProfileImportPrompt, writePendingLocalProfileImportPrompt } =
      await import('../access-mode-store');

    expect(readPendingLocalProfileImportPrompt()).toBe(true);
    writePendingLocalProfileImportPrompt(false);

    expect(secureStore.setItem).toHaveBeenCalledWith(
      'boardsesh_local_profile_import_prompt_v1',
      'false',
      SECURE_STORE_WRITE_OPTIONS,
    );
  });
});
