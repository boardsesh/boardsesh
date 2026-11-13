import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  createLedPreviewSession,
  getLedControllerDriver,
  LedControllerError,
  type LedControllerErrorCode,
  type LedPreviewSession,
} from '@boardsesh/led-controller';
import { wiredLedCount } from '@boardsesh/spray-wall-geometry';
import { subscribeSprayLedConfiguration } from './spray-led-config-events';
import { loadSprayWallTnutLayout } from './spray-wall-tnut-store';
import { useSprayWallLedSettings, type SprayWallLedSettings } from './use-spray-wall-led-settings';
import './spray-led-ble-transport-loader';

export type SprayLedPreviewState = 'idle' | 'sending' | 'lit' | 'chasing' | 'stopping';
type PreviewRuntime = { session: LedPreviewSession; active: boolean; generation: number };

/** No controller traffic until the user selects LEDs or starts a lighting test. */
export function useSprayLedPreview(wallUuid: string) {
  return useSprayLedPreviewForSettings(wallUuid, useSprayWallLedSettings(wallUuid));
}

/** Reuse the editor's live settings so a newly confirmed URL is immediately available. */
export function useSprayLedPreviewForSettings(
  wallUuid: string,
  { settings, loading }: { settings: SprayWallLedSettings | null; loading: boolean },
) {
  const enabled = !loading && settings?.enabled === true;
  // The Wi-Fi address, or `ble:` and the name the wall's Bluetooth controller advertises.
  const url = settings?.controller.url ?? '';
  const controllerType = settings?.controller.type ?? 'wled';
  const brightness = settings?.brightness;
  const autoOffMinutes = settings?.autoOffMinutes;
  const runtime = useRef<PreviewRuntime | null>(null);
  const [state, setState] = useState<SprayLedPreviewState>('idle');
  const [error, setError] = useState<LedControllerErrorCode | null>(null);
  const [available, setAvailable] = useState(false);
  // What the wall shows, so the screen can draw it: every LED after Light all,
  // or the one LED the row-by-row test has reached.
  const [allLit, setAllLit] = useState(false);
  const [chaseIndex, setChaseIndex] = useState<number | null>(null);
  // A Bluetooth controller reports no cable length: "Light all" lights the
  // LEDs the saved layout wires, and only falls back to the driver's 500
  // when there is no wiring yet.
  const [ledCount, setLedCount] = useState<number | undefined>(undefined);
  const bluetooth = controllerType === 'ble';

  useEffect(() => {
    setLedCount(undefined);
    if (!bluetooth || !enabled) return;
    let active = true;
    const load = () => {
      void loadSprayWallTnutLayout(wallUuid)
        .then((layout) => {
          if (active) setLedCount(layout?.wiring ? wiredLedCount(layout.wiring) || undefined : undefined);
        })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = subscribeSprayLedConfiguration((changed) => {
      if (changed === wallUuid) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [wallUuid, bluetooth, enabled]);

  useEffect(() => {
    setState('idle');
    setError(null);
    setAvailable(false);
    setAllLit(false);
    setChaseIndex(null);
    if (!enabled || !url) return;
    let session: LedPreviewSession;
    try {
      session = createLedPreviewSession(getLedControllerDriver(controllerType), url, {
        brightness,
        autoOffMinutes,
        ledCount,
      });
    } catch {
      return;
    }
    const current: PreviewRuntime = { session, active: true, generation: 0 };
    runtime.current = current;
    setAvailable(true);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      const generation = ++current.generation;
      setAllLit(false);
      setChaseIndex(null);
      void session
        .stop()
        .then(() => {
          if (current.active && current.generation === generation) setState('idle');
        })
        .catch((failure: unknown) => {
          if (current.active && current.generation === generation) {
            setState('idle');
            setError(failure instanceof LedControllerError ? failure.code : 'unavailable');
          }
        });
    });
    return () => {
      current.active = false;
      current.generation++;
      if (runtime.current === current) runtime.current = null;
      subscription.remove();
      void session.close().catch(() => undefined);
    };
  }, [wallUuid, enabled, url, controllerType, brightness, autoOffMinutes, ledCount]);

  const run = useCallback(
    async (
      nextState: SprayLedPreviewState,
      operation: (current: PreviewRuntime, generation: number) => Promise<boolean>,
      finishedState: SprayLedPreviewState,
    ) => {
      const current = runtime.current;
      if (!current?.active) return false;
      const generation = ++current.generation;
      setError(null);
      setState(nextState);
      setAllLit(false);
      setChaseIndex(null);
      try {
        const completed = await operation(current, generation);
        if (current.active && current.generation === generation) {
          setState(completed ? finishedState : 'idle');
          // A finished or interrupted row test no longer lights one LED.
          setChaseIndex(null);
        }
        return completed;
      } catch (failure) {
        if (current.active && current.generation === generation) {
          setState('idle');
          setChaseIndex(null);
          setError(failure instanceof LedControllerError ? failure.code : 'unavailable');
        }
        return false;
      }
    },
    [],
  );
  const show = useCallback(
    (indices: readonly number[]) =>
      run('sending', (current) => current.session.show(indices), indices.length ? 'lit' : 'idle'),
    [run],
  );
  const lightAll = useCallback(
    () =>
      run(
        'sending',
        async (current, generation) => {
          const completed = await current.session.lightAll();
          if (completed && current.active && current.generation === generation) setAllLit(true);
          return completed;
        },
        'lit',
      ),
    [run],
  );
  const clear = useCallback(() => run('stopping', (current) => current.session.clear(), 'idle'), [run]);
  const stop = useCallback(() => run('stopping', (current) => current.session.stop(), 'idle'), [run]);
  const chase = useCallback(
    (indices: readonly number[]) => {
      const ordered = [...indices];
      return run(
        'chasing',
        async (current, generation) => {
          for (const [position, index] of ordered.entries()) {
            if (!current.active || current.generation !== generation) return false;
            if (position > 0 && !current.session.isOwner()) return false;
            const started = Date.now();
            if (!(await current.session.show([index]))) return false;
            if (current.active && current.generation === generation) setChaseIndex(index);
            const delay = Math.max(0, 100 - (Date.now() - started));
            if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
          if (!current.active || current.generation !== generation) return false;
          return current.session.stop();
        },
        'idle',
      );
    },
    [run],
  );

  // Why lighting is off: a Bluetooth Spraywall needs its controller found in the LED settings, not a WLED address.
  const unavailableMessage =
    controllerType === 'ble'
      ? ('sprayLedSetup.lightingUnavailableBle' as const)
      : ('sprayLedSetup.lightingUnavailable' as const);

  return { available, state, error, allLit, chaseIndex, show, lightAll, clear, stop, chase, unavailableMessage };
}
