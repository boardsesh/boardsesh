import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import { getPreference, setPreference } from '../preference-store';
import { notifySprayLedConfiguration } from './spray-led-config-events';
import {
  readSprayWallLedSettings,
  sprayWallLedCacheGeneration,
  sprayWallLedSettingsKey,
  subscribeSprayWallLedServerChange,
  subscribeSprayWallLedUploadOutcome,
  type SprayWallLedSettings,
} from './spray-wall-led-cache';
import { markSprayWallLedSaveStarted, prepareSprayWallLedRead, queueSprayWallLedUpload } from './spray-wall-led-sync';

export type { SprayWallLedSettings } from './spray-wall-led-cache';

export type SprayWallLedSettingsError = 'load' | 'save' | null;

type SettingsState = {
  wallUuid: string;
  settings: SprayWallLedSettings | null;
  loading: boolean;
  saving: boolean;
  error: SprayWallLedSettingsError;
};

type SettingsSession = {
  wallUuid: string;
  active: boolean;
  loading: boolean;
  saving: boolean;
  generation: number;
  settings: SprayWallLedSettings | null;
};

// A write can outlive its screen. Reopening must read after that write settles.
const pendingWrites = new Map<string, Promise<void>>();

function initialState(wallUuid: string): SettingsState {
  return { wallUuid, settings: null, loading: true, saving: false, error: null };
}

/** A value that fails the local rule is no address at all, so nothing ever contacts it. */
function withLocalAddress(settings: SprayWallLedSettings): SprayWallLedSettings {
  if (!settings.controller.url) return settings;
  try {
    normalizeLocalControllerUrl(settings.controller.url);
    return settings;
  } catch {
    return { ...settings, controller: { ...settings.controller, url: '' } };
  }
}

/** The setup for this wall: the server's answer, or this phone's copy when the server can't say. */
export async function loadSprayWallLedSettings(wallUuid: string): Promise<SprayWallLedSettings> {
  await pendingWrites.get(wallUuid)?.catch(() => undefined);
  await prepareSprayWallLedRead(wallUuid, 'settings');
  return withLocalAddress(
    readSprayWallLedSettings(await getPreference<unknown>(sprayWallLedSettingsKey(wallUuid), { strictParsing: true })),
  );
}

/**
 * The controller settings for one wall. They save to the wall, so every climber
 * there can light it, and the phone keeps a copy for when there is no internet.
 */
export function useSprayWallLedSettings(wallUuid: string) {
  const [state, setState] = useState<SettingsState>(() => initialState(wallUuid));
  const sessionRef = useRef<SettingsSession | null>(null);

  const load = useCallback(async (session: SettingsSession) => {
    const generation = ++session.generation;
    session.loading = true;
    setState(initialState(session.wallUuid));
    try {
      const settings = await loadSprayWallLedSettings(session.wallUuid);
      if (!session.active || session.generation !== generation) return;
      session.settings = settings;
      session.loading = false;
      setState({ wallUuid: session.wallUuid, settings, loading: false, saving: false, error: null });
    } catch {
      if (!session.active || session.generation !== generation) return;
      session.settings = null;
      session.loading = false;
      setState({ wallUuid: session.wallUuid, settings: null, loading: false, saving: false, error: 'load' });
    }
  }, []);

  useEffect(() => {
    const session: SettingsSession = {
      wallUuid,
      active: true,
      loading: true,
      saving: false,
      generation: 0,
      settings: null,
    };
    sessionRef.current = session;
    void load(session);
    return () => {
      session.active = false;
    };
  }, [wallUuid, load]);

  const reload = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.active || session.wallUuid !== wallUuid || session.saving) return;
    void load(session);
  }, [wallUuid, load]);

  useEffect(() => {
    const unsubscribeServer = subscribeSprayWallLedServerChange((changedWallUuid) => {
      if (changedWallUuid === wallUuid) reload();
    });
    // A failed upload is the same "not saved" a failed write is. The next load retries it.
    const unsubscribeUploads = subscribeSprayWallLedUploadOutcome((changedWallUuid, outcome) => {
      if (changedWallUuid !== wallUuid) return;
      setState((previous) => {
        if (previous.wallUuid !== wallUuid) return previous;
        if (outcome === 'failed') return { ...previous, error: 'save' };
        return previous.error === 'save' ? { ...previous, error: null } : previous;
      });
    });
    return () => {
      unsubscribeServer();
      unsubscribeUploads();
    };
  }, [wallUuid, reload]);

  const save = useCallback(
    async (next: SprayWallLedSettings): Promise<boolean> => {
      const session = sessionRef.current;
      if (
        !session?.active ||
        session.wallUuid !== wallUuid ||
        session.loading ||
        session.saving ||
        session.settings === null ||
        pendingWrites.has(wallUuid)
      ) {
        return false;
      }
      const cacheGeneration = sprayWallLedCacheGeneration(wallUuid);
      // This ref changes before React renders, so two taps cannot enqueue two writes.
      session.saving = true;
      setState((previous) => ({ ...previous, saving: true, error: null }));
      try {
        const settings = readSprayWallLedSettings(next);
        if (settings.controller.url) normalizeLocalControllerUrl(settings.controller.url);
        const write = markSprayWallLedSaveStarted(wallUuid, 'settings', () =>
          setPreference(sprayWallLedSettingsKey(wallUuid), settings),
        );
        pendingWrites.set(wallUuid, write);
        try {
          await write;
        } finally {
          if (pendingWrites.get(wallUuid) === write) pendingWrites.delete(wallUuid);
        }
        if (sprayWallLedCacheGeneration(wallUuid) !== cacheGeneration) throw new Error('LED save withdrawn');
        notifySprayLedConfiguration(wallUuid);
        queueSprayWallLedUpload(wallUuid, 'settings');
        if (!session.active) return false;
        session.settings = settings;
        setState({ wallUuid, settings, loading: false, saving: false, error: null });
        return true;
      } catch {
        if (session.active) {
          setState({ wallUuid, settings: session.settings, loading: false, saving: false, error: 'save' });
        }
        return false;
      } finally {
        session.saving = false;
      }
    },
    [wallUuid],
  );

  const visibleState = state.wallUuid === wallUuid ? state : initialState(wallUuid);
  return {
    settings: visibleState.settings,
    loading: visibleState.loading,
    saving: visibleState.saving,
    error: visibleState.error,
    reload,
    save,
  };
}
