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

  it('starts with the seven sections below the climb visible and Active holds off, sharing one read', async () => {
    const module = await import('../play-drawer-sections-preference');
    const first = renderHook(module.usePlayDrawerSectionsPreference);
    const second = renderHook(module.usePlayDrawerSectionsPreference);
    expect(first.result.current.ready).toBe(false);
    const { activeHolds, ...belowFold } = first.result.current.sections;
    expect(activeHolds).toBe(false);
    expect(Object.values(belowFold)).toEqual(Array(7).fill(true));
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

  it('reads Active holds as off from a record saved before it existed, and keeps a saved on', async () => {
    storeSections({ logbook: false, community: true });
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sections).toEqual({ ...module.DEFAULT_PLAY_DRAWER_SECTIONS, logbook: false });
    expect(result.current.sections.activeHolds).toBe(false);
    cleanup();
    vi.resetModules();
    storeSections({ activeHolds: true });
    const restarted = await import('../play-drawer-sections-preference');
    const restored = renderHook(restarted.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(restored.result.current.ready).toBe(true));
    expect(restored.result.current.sections.activeHolds).toBe(true);
  });

  it.each([
    ['a fresh install', null],
    [
      'a record from main before Active holds',
      {
        version: 1,
        sections: { logbook: false },
        order: ['logbook', 'climberLogs', 'setterNotes', 'betaVideos', 'boardseshGrade', 'community', 'similarClimbs'],
      },
    ],
    [
      'a record from an earlier preview that stored every switch',
      {
        version: 1,
        sections: {
          activeHolds: false,
          logbook: true,
          climberLogs: true,
          setterNotes: true,
          betaVideos: true,
          boardseshGrade: true,
          community: true,
          similarClimbs: true,
        },
      },
    ],
  ])('keeps Active holds hidden after %s', async (_case, record) => {
    if (record) storage.set('playDrawerSections', JSON.stringify(record));
    const module = await import('../play-drawer-sections-preference');
    const { visiblePlayDrawerSections } = await import('../../components/play-drawer/play-drawer-sections');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sections.activeHolds).toBe(false);
    expect(
      visiblePlayDrawerSections({
        sections: result.current.sections,
        order: result.current.order,
        isAuthenticated: true,
        boardseshGradeEnabled: true,
        description: 'Start left',
        screenshotMode: false,
      }),
    ).not.toContain('activeHolds');
  });

  it('switches Active holds with Show all and Hide all', async () => {
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setAll(true));
    expect(result.current.sections.activeHolds).toBe(true);
    expect(module.isDefaultPlayDrawerLayout(result.current)).toBe(false);
    act(() => result.current.setAll(false));
    expect(Object.values(result.current.sections).every((visible) => !visible)).toBe(true);
    act(() => result.current.restoreDefaults());
    expect(result.current.sections.activeHolds).toBe(false);
    expect(module.isDefaultPlayDrawerLayout(result.current)).toBe(true);
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
    expect(restored.result.current.sections).toEqual({
      ...restarted.DEFAULT_PLAY_DRAWER_SECTIONS,
      activeHolds: true,
      setterNotes: false,
    });
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
    // Only the switch that differs from its default is stored.
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections).toEqual({ activeHolds: true });
  });

  it('stores only switches that differ from their defaults, so a later default still applies', async () => {
    storage.set('playDrawerSections', JSON.stringify({ version: 1, sections: { logbook: true, laterSection: false } }));
    const module = await import('../play-drawer-sections-preference');
    const { result } = renderHook(module.usePlayDrawerSectionsPreference);
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setSection('community', false));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // A default-valued switch read from an older record is dropped; one this bundle does not know stays.
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections).toEqual({
      laterSection: false,
      community: false,
    });
    act(() => result.current.setSection('community', true));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(JSON.parse(storage.get('playDrawerSections') ?? '{}').sections).toEqual({ laterSection: false });
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
    // Still the defaults: the read has not answered, so Hide all did nothing.
    expect(drawer.result.current.controls.every((control) => control.visible === (control.id !== 'activeHolds'))).toBe(
      true,
    );
    await act(async () => gate.resolve(null));
    expect(settings.result.current.settingsSection.rows).toHaveLength(11);
    expect(settings.result.current.settingsSection.rows[0]).toMatchObject({
      kind: 'toggle',
      key: 'activeHolds',
      label: 'mobile.settings.climbDrawer.sections.activeHolds',
      value: false,
    });
    act(() => drawer.result.current.hideAll());
    expect(settings.result.current.controls.every((control) => !control.visible)).toBe(true);
    const logbookToggle = settings.result.current.settingsSection.rows.find((row) => row.key === 'logbook');
    if (logbookToggle?.kind !== 'toggle') throw new Error('Expected logbook toggle');
    act(() => logbookToggle.onValueChange(true));
    expect(drawer.result.current.controls.find((control) => control.id === 'logbook')).toMatchObject({
      visible: true,
    });
    act(() => settings.result.current.showAll());
    expect(drawer.result.current.controls.every((control) => control.visible)).toBe(true);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
  });

  describe('order', () => {
    const MOVED_ORDER = [
      'activeHolds',
      'similarClimbs',
      'logbook',
      'climberLogs',
      'setterNotes',
      'betaVideos',
      'boardseshGrade',
      'community',
    ];

    function storedRecord(): Record<string, unknown> {
      return JSON.parse(storage.get('playDrawerSections') ?? '{}');
    }

    it("reads a record without an order, as an older bundle wrote it, in today's order", async () => {
      storeSections({ community: false });
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.order).toEqual(module.DEFAULT_PLAY_DRAWER_SECTION_ORDER);
      expect(result.current.sections.community).toBe(false);
    });

    it('reads a saved order, dropping unknown ids and slotting missing ones in at their default place', async () => {
      storage.set(
        'playDrawerSections',
        JSON.stringify({
          version: 1,
          sections: {},
          order: ['similarClimbs', 'retired', 'community', 'logbook', 'logbook', 'betaVideos'],
        }),
      );
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      // Active holds, missing from an order saved before it existed, leads like its default.
      expect(result.current.order).toEqual([
        'activeHolds',
        'similarClimbs',
        'community',
        'logbook',
        'climberLogs',
        'setterNotes',
        'betaVideos',
        'boardseshGrade',
      ]);
    });

    it('moves a section one place, hidden or not, and saves the order beside the switches', async () => {
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      act(() => result.current.setSection('similarClimbs', false));
      for (let step = 0; step < 6; step += 1)
        act(() => {
          result.current.move('similarClimbs', -1);
        });
      expect(result.current.order).toEqual(MOVED_ORDER);
      expect(result.current.sections.similarClimbs).toBe(false);
      await waitFor(() => expect(storedRecord().order).toEqual(MOVED_ORDER));
      expect(storedRecord()).toMatchObject({ version: 1, sections: { similarClimbs: false } });
    });

    it('does nothing at either end', async () => {
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      const before = result.current.order;
      act(() => {
        result.current.move('activeHolds', -1);
        result.current.move('similarClimbs', 1);
      });
      expect(result.current.order).toBe(before);
      expect(write).not.toHaveBeenCalled();
    });

    it('keeps a move made before the read lands, and still fills the switches from it', async () => {
      const gate = deferred<string>();
      read.mockImplementationOnce(() => gate.promise);
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      act(() => {
        result.current.move('logbook', 1);
      });
      await act(async () =>
        gate.resolve(
          JSON.stringify({
            version: 1,
            sections: { community: false },
            order: ['community', 'logbook', 'climberLogs'],
          }),
        ),
      );
      expect(result.current.order.slice(0, 3)).toEqual(['activeHolds', 'climberLogs', 'logbook']);
      expect(result.current.sections.community).toBe(false);
    });

    it('writes back fields and sections this bundle does not know', async () => {
      storage.set(
        'playDrawerSections',
        JSON.stringify({ version: 1, sections: { logbook: false, laterSection: true }, later: { kept: true } }),
      );
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      act(() => {
        result.current.move('community', -1);
      });
      await waitFor(() => expect(write).toHaveBeenCalled());
      expect(storedRecord()).toMatchObject({
        version: 1,
        later: { kept: true },
        sections: { logbook: false, laterSection: true },
      });
    });

    it('restores the default switches and order together', async () => {
      storage.set(
        'playDrawerSections',
        JSON.stringify({ version: 1, sections: { logbook: false }, order: MOVED_ORDER }),
      );
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(module.isDefaultPlayDrawerLayout(result.current)).toBe(false);
      act(() => result.current.restoreDefaults());
      expect(result.current.sections).toEqual(module.DEFAULT_PLAY_DRAWER_SECTIONS);
      expect(result.current.order).toEqual(module.DEFAULT_PLAY_DRAWER_SECTION_ORDER);
      expect(module.isDefaultPlayDrawerLayout(result.current)).toBe(true);
      // The default order is left out, so a later release's default order still applies.
      // Neither the default switches nor the default order are stored, so later defaults still apply.
      await waitFor(() => expect(storedRecord().sections).toEqual({}));
      expect(storedRecord()).not.toHaveProperty('order');
    });

    it('saves no order for a switch flip while the order is the default', async () => {
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      act(() => result.current.setSection('community', false));
      await waitFor(() => expect(storedRecord().sections).toMatchObject({ community: false }));
      expect(storedRecord()).not.toHaveProperty('order');
    });

    it("keeps a later release's section in its place through a write, as after an OTA rollback", async () => {
      storage.set(
        'playDrawerSections',
        JSON.stringify({
          version: 1,
          sections: { crewNotes: true, community: false },
          order: [
            'activeHolds',
            'similarClimbs',
            'crewNotes',
            'logbook',
            'climberLogs',
            'setterNotes',
            'betaVideos',
            'boardseshGrade',
            'community',
          ],
        }),
      );
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.order).not.toContain('crewNotes');
      act(() => {
        result.current.move('community', -1);
      });
      await waitFor(() => expect(write).toHaveBeenCalled());
      expect(storedRecord()).toMatchObject({
        sections: { crewNotes: true, community: false },
        order: [
          'activeHolds',
          'similarClimbs',
          'crewNotes',
          'logbook',
          'climberLogs',
          'setterNotes',
          'betaVideos',
          'community',
          'boardseshGrade',
        ],
      });
      // Back to this release's default order, the later release's section still holds its place.
      act(() => result.current.restoreDefaults());
      await waitFor(() => expect(storedRecord().sections).toEqual({ crewNotes: true }));
      expect(storedRecord().order).toEqual([
        'activeHolds',
        'logbook',
        'climberLogs',
        'setterNotes',
        'betaVideos',
        'boardseshGrade',
        'community',
        'similarClimbs',
        'crewNotes',
      ]);
    });

    it('keeps a restore made after a failed read, for the switches and the order alike', async () => {
      read.mockRejectedValueOnce(new Error('locked storage'));
      const module = await import('../play-drawer-sections-preference');
      const { result } = renderHook(module.usePlayDrawerSectionsPreference);
      await waitFor(() => expect(result.current.ready).toBe(true));
      storage.set(
        'playDrawerSections',
        JSON.stringify({ version: 1, sections: { logbook: false }, order: MOVED_ORDER }),
      );
      act(() => result.current.restoreDefaults());
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(write).toHaveBeenCalled());
      expect(result.current.sections).toEqual(module.DEFAULT_PLAY_DRAWER_SECTIONS);
      expect(result.current.order).toEqual(module.DEFAULT_PLAY_DRAWER_SECTION_ORDER);
      expect(storedRecord().sections).toEqual({});
      expect(storedRecord()).not.toHaveProperty('order');
    });

    it('lists Settings rows in the saved order, with Restore defaults only when something changed', async () => {
      storage.set('playDrawerSections', JSON.stringify({ version: 1, sections: {}, order: MOVED_ORDER }));
      const { usePlayDrawerSectionControls } =
        await import('../../components/settings/use-play-drawer-section-controls');
      const { result } = renderHook(usePlayDrawerSectionControls);
      await waitFor(() => expect(result.current.ready).toBe(true));
      const rows = result.current.settingsSection.rows;
      expect(rows.slice(0, 8).map((row) => row.key)).toEqual(MOVED_ORDER);
      // Active holds is a section like the rest: it moves too.
      expect(result.current.controls.every((control) => control.movable)).toBe(true);
      const restore = rows.find((row) => row.key === 'restoreDefaults');
      if (restore?.kind !== 'button') throw new Error('Expected a Restore defaults button');
      expect(restore.disabled).toBe(false);
      act(() => restore.onPress());
      expect(result.current.controls.map((control) => control.id)).toEqual([
        'activeHolds',
        'logbook',
        'climberLogs',
        'setterNotes',
        'betaVideos',
        'boardseshGrade',
        'community',
        'similarClimbs',
      ]);
      expect(result.current.canRestoreDefaults).toBe(false);
      const restoreAfter = result.current.settingsSection.rows.find((row) => row.key === 'restoreDefaults');
      expect(restoreAfter?.kind === 'button' && restoreAfter.disabled).toBe(true);
    });

    it('ignores moves from the controls until storage has answered', async () => {
      const gate = deferred<string | null>();
      read.mockImplementationOnce(() => gate.promise);
      const { usePlayDrawerSectionControls } =
        await import('../../components/settings/use-play-drawer-section-controls');
      const { result } = renderHook(usePlayDrawerSectionControls);
      act(() => {
        result.current.onMove('similarClimbs', -1);
      });
      expect(result.current.controls.at(-1)?.id).toBe('similarClimbs');
      await act(async () => gate.resolve(null));
      act(() => {
        result.current.onMove('similarClimbs', -1);
      });
      expect(result.current.controls.at(-2)?.id).toBe('similarClimbs');
    });
  });
});
