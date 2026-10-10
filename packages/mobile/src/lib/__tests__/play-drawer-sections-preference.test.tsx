// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { storage, read, write, reportError, addErrorBreadcrumb } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    read: vi.fn(async (key: string) => storage.get(key) ?? null),
    write: vi.fn(async (key: string, serialized: string) => {
      storage.set(key, serialized);
    }),
    reportError: vi.fn(),
    addErrorBreadcrumb: vi.fn(),
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: read, setItem: write } }));
vi.mock('../error-reporting', () => ({ reportError, addErrorBreadcrumb }));
vi.mock('../haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function storeSections(sections: Record<string, unknown>): void {
  storage.set('playDrawerSections', JSON.stringify({ version: 1, sections }));
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('play drawer section preferences', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    read.mockReset().mockImplementation(async (key: string) => storage.get(key) ?? null);
    write.mockReset().mockImplementation(async (key: string, serialized: string) => {
      storage.set(key, serialized);
    });
    reportError.mockClear();
    addErrorBreadcrumb.mockClear();
  });
  afterEach(cleanup);

  it('starts with seven visible sections and shares one read across consumers', async () => {
    const module = await import('../play-drawer-sections-preference');
    const first = renderHook(module.usePlayDrawerSectionsPreference);
    const second = renderHook(module.usePlayDrawerSectionsPreference);
    expect(first.result.current.ready).toBe(false);
    expect(Object.values(first.result.current.sections)).toEqual(Array(7).fill(true));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('accepts booleans and defaults missing or invalid fields to visible', async () => {
    storeSections({ logbook: false, betaVideos: false, setterNotes: 'false', community: null, unknown: false });
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sections).toEqual({
      ...module.DEFAULT_PLAY_DRAWER_SECTIONS,
      logbook: false,
      betaVideos: false,
    });
  });

  it.each(['{broken', JSON.stringify({ version: 2, sections: { logbook: false } }), 'null'])(
    'uses defaults for malformed or unknown versions: %s',
    async (serialized) => {
      storage.set('playDrawerSections', serialized);
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.sections).toEqual(module.DEFAULT_PLAY_DRAWER_SECTIONS);
    },
  );

  it('keeps recent choices while merging untouched fields from a late read', async () => {
    const gate = deferred<string>();
    read.mockImplementationOnce(() => gate.promise);
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    act(() => result.current.setSection('logbook', false));
    await act(async () => gate.resolve(JSON.stringify({ version: 1, sections: { logbook: true, community: false } })));
    expect(result.current.sections.logbook).toBe(false);
    expect(result.current.sections.community).toBe(false);
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections.community).toBe(false);
  });

  it('loads saved fields before an exported setter is used without a mounted hook', async () => {
    storeSections({ community: false });
    const module = await import('../play-drawer-sections-preference');
    module.setPlayDrawerSection('logbook', false);
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections).toMatchObject({
      community: false,
      logbook: false,
    });
  });

  it('makes failed reads usable and retries on a later mount', async () => {
    read.mockRejectedValueOnce(new Error('locked storage'));
    const module = await import('../play-drawer-sections-preference');
    const first = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(reportError).not.toHaveBeenCalled();
    expect(addErrorBreadcrumb).not.toHaveBeenCalled();
    first.unmount();
    storeSections({ similarClimbs: false });
    const second = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(second.result.current.sections.similarClimbs).toBe(false));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serializes rapid writes and restores the final choice after restart', async () => {
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    const firstWrite = deferred<void>();
    write.mockImplementationOnce(async (key: string, serialized: string) => {
      await firstWrite.promise;
      storage.set(key, serialized);
    });
    act(() => result.current.setAll(false));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.setAll(true);
      result.current.setSection('setterNotes', false);
    });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => firstWrite.resolve());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    cleanup();
    vi.resetModules();
    const restarted = await import('../play-drawer-sections-preference');
    const restored = renderHook(restarted.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(restored.result.current.ready).toBe(true));
    expect(restored.result.current.sections).toEqual({ ...restarted.DEFAULT_PLAY_DRAWER_SECTIONS, setterNotes: false });
  });

  it('reports write failures without poisoning subsequent updates', async () => {
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    write.mockRejectedValueOnce(new Error('disk full'));
    act(() => result.current.setAll(false));
    await waitFor(() =>
      expect(addErrorBreadcrumb).toHaveBeenCalledWith({
        category: 'preferences',
        message: 'Climb drawer preferences could not be saved',
        level: 'warning',
      }),
    );
    expect(reportError).not.toHaveBeenCalled();
    act(() => result.current.setAll(true));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections).toEqual(module.DEFAULT_PLAY_DRAWER_SECTIONS);
  });

  it('keeps Settings actions unavailable while loading and shares updates with drawer controls', async () => {
    const gate = deferred<string | null>();
    read.mockImplementationOnce(() => gate.promise);
    const { usePlayDrawerSectionControls } = await import('../../components/settings/use-play-drawer-section-controls');
    const settings = renderHook(usePlayDrawerSectionControls);
    const drawer = renderHook(usePlayDrawerSectionControls);
    expect(settings.result.current.settingsSection.rows).toHaveLength(1);
    expect(settings.result.current.settingsSection.rows[0]?.kind).toBe('info');
    act(() => drawer.result.current.hideAll());
    expect(drawer.result.current.controls.every((control) => control.enabled)).toBe(true);
    await act(async () => gate.resolve(null));
    expect(settings.result.current.settingsSection.rows).toHaveLength(9);
    act(() => drawer.result.current.hideAll());
    expect(settings.result.current.controls.every((control) => !control.enabled)).toBe(true);
    const logbookToggle = settings.result.current.settingsSection.rows[0];
    if (logbookToggle?.kind !== 'toggle') throw new Error('Expected logbook toggle');
    act(() => logbookToggle.onValueChange(true));
    expect(drawer.result.current.controls[0]).toMatchObject({ id: 'logbook', enabled: true });
    act(() => settings.result.current.showAll());
    expect(drawer.result.current.controls.every((control) => control.enabled)).toBe(true);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
  });
});
