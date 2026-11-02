import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreference, setPreference } from '../preference-store';

export type SprayWallLedSettings = {
  version: 1;
  enabled: boolean;
  controller: { type: 'wled'; url: string };
};

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

const storageKey = (wallUuid: string) => `sprayWallLedSettings:${wallUuid}`;
// A write can outlive its screen. Reopening must read after that write settles.
const pendingWrites = new Map<string, Promise<void>>();

function initialState(wallUuid: string): SettingsState {
  return { wallUuid, settings: null, loading: true, saving: false, error: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail closed on future versions or corruption; never replace them with defaults. */
function readSettings(stored: unknown): SprayWallLedSettings {
  if (stored === null) return { version: 1, enabled: false, controller: { type: 'wled', url: '' } };
  if (
    !isRecord(stored) ||
    stored.version !== 1 ||
    typeof stored.enabled !== 'boolean' ||
    !isRecord(stored.controller) ||
    stored.controller.type !== 'wled' ||
    typeof stored.controller.url !== 'string'
  ) {
    throw new Error('Invalid spray wall LED settings');
  }
  return {
    version: 1,
    enabled: stored.enabled,
    controller: { type: 'wled', url: stored.controller.url },
  };
}

/** A LAN controller belongs to this device and wall, never the shared board payload. */
export function useSprayWallLedSettings(wallUuid: string) {
  const [state, setState] = useState<SettingsState>(() => initialState(wallUuid));
  const sessionRef = useRef<SettingsSession | null>(null);

  const load = useCallback(async (session: SettingsSession) => {
    const generation = ++session.generation;
    session.loading = true;
    setState(initialState(session.wallUuid));
    try {
      await pendingWrites.get(session.wallUuid)?.catch(() => undefined);
      const stored = await getPreference<unknown>(storageKey(session.wallUuid), { strictParsing: true });
      const settings = readSettings(stored);
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
      // This ref changes before React renders, so two taps cannot enqueue two writes.
      session.saving = true;
      setState((previous) => ({ ...previous, saving: true, error: null }));
      try {
        const settings = readSettings(next);
        const write = setPreference(storageKey(wallUuid), settings);
        pendingWrites.set(wallUuid, write);
        try {
          await write;
        } finally {
          if (pendingWrites.get(wallUuid) === write) pendingWrites.delete(wallUuid);
        }
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
