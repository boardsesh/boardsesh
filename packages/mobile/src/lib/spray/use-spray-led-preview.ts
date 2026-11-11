import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  createLedPreviewSession,
  getLedControllerDriver,
  LedControllerError,
  type LedControllerErrorCode,
  type LedPreviewSession,
} from '@boardsesh/led-controller';
import { useSprayWallLedSettings, type SprayWallLedSettings } from './use-spray-wall-led-settings';

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
  const url = settings?.controller.url ?? '';
  const controllerType = settings?.controller.type ?? 'wled';
  const runtime = useRef<PreviewRuntime | null>(null);
  const [state, setState] = useState<SprayLedPreviewState>('idle');
  const [error, setError] = useState<LedControllerErrorCode | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setState('idle');
    setError(null);
    setAvailable(false);
    if (!enabled || !url) return;
    let session: LedPreviewSession;
    try {
      session = createLedPreviewSession(getLedControllerDriver(controllerType), url);
    } catch {
      return;
    }
    const current: PreviewRuntime = { session, active: true, generation: 0 };
    runtime.current = current;
    setAvailable(true);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      const generation = ++current.generation;
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
  }, [wallUuid, enabled, url, controllerType]);

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
      try {
        const completed = await operation(current, generation);
        if (current.active && current.generation === generation) setState(completed ? finishedState : 'idle');
        return completed;
      } catch (failure) {
        if (current.active && current.generation === generation) {
          setState('idle');
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
  const lightAll = useCallback(() => run('sending', (current) => current.session.lightAll(), 'lit'), [run]);
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

  return { available, state, error, show, lightAll, clear, stop, chase };
}
