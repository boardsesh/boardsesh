import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { accumulateFramesToMaps, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { buildSprayLedMapping } from '@boardsesh/spray-wall-geometry';
import {
  createLedPreviewSession,
  getLedControllerDriver,
  type LedPixel,
  type LedPreviewSession,
} from '@boardsesh/led-controller';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../privacy/privacy-cache';
import { hexToRgb, type HoldColorOverrides } from '../hold-color-overrides';
import { subscribeSprayLedConfiguration } from './spray-led-config-events';
import { sprayLedPhotoKey } from './spray-led-photo-key';
import { lookPreviewSourceFromRenderData } from './spray-look-preview';
import { getSprayWall, sprayWallRemovalGeneration, subscribeToSprayWallWithdrawals } from './spray-wall-registry';
import { sprayPrivacyGeneration } from './spray-privacy-generation';

type RouteRuntime = { wallUuid: string; url: string; session: LedPreviewSession };

/**
 * LAN writes share the normal wall commit path and require a deliberate wall
 * hold. As on a Bluetooth board, locking the phone or letting go of the wall
 * leaves the climb lit; only a clear, or a change that makes it wrong, ends it.
 */
export function useSprayLedRouteSender({
  boardName,
  layoutId,
  colorOverrides,
  onInvalidated,
  onFailure,
}: {
  boardName?: string;
  layoutId?: number;
  colorOverrides?: HoldColorOverrides;
  onInvalidated: (retry?: boolean) => void;
  onFailure?: () => void;
}) {
  const queryClient = useQueryClient();
  const runtime = useRef<RouteRuntime | null>(null);
  const requestGeneration = useRef(0);
  // `inactive` (Control Center, a call overlay) still has the climber looking at
  // the app, the same split `isAppActive` makes for Bluetooth writes.
  const away = useRef(AppState.currentState === 'background');
  const missedWhileAway = useRef(false);
  // One toast per run of failures: an unreachable controller would otherwise
  // say so again on every climb.
  const failureShown = useRef(false);
  const mounted = useRef(true);
  const invalidate = useRef(onInvalidated);
  invalidate.current = onInvalidated;
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const currentConfig = `${boardName}:${layoutId}`;
  const config = useRef(currentConfig);
  config.current = currentConfig;
  const colors = useRef(colorOverrides);
  colors.current = colorOverrides;

  const stop = useCallback((lights: 'off' | 'leave' = 'off') => {
    requestGeneration.current++;
    missedWhileAway.current = false;
    const previous = runtime.current;
    runtime.current = null;
    if (previous) {
      void (lights === 'off' ? previous.session.close() : previous.session.detach()).catch(() => undefined);
    }
    if (mounted.current) invalidate.current();
  }, []);
  const release = useCallback(() => stop('leave'), [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop('leave');
    };
  }, [stop]);

  useEffect(() => {
    if (boardName !== 'spray') return;
    const configuration = subscribeSprayLedConfiguration((wallUuid) => {
      if (runtime.current && runtime.current.wallUuid !== wallUuid) return;
      stop();
      invalidate.current(true);
    });
    const credentials = subscribeToCredentialChanges(stop);
    const withdrawals = subscribeToSprayWallWithdrawals((withdrawnLayout) => {
      if (withdrawnLayout == null || withdrawnLayout === layoutId) stop();
    });
    const background = AppState.addEventListener('change', (next) => {
      away.current = next === 'background';
      if (away.current || !missedWhileAway.current) return;
      missedWhileAway.current = false;
      invalidate.current(true);
    });
    return () => {
      configuration();
      credentials();
      withdrawals();
      background.remove();
      stop('leave');
    };
  }, [boardName, layoutId, stop]);

  const send = useCallback(
    async (frames: string, mirrored?: boolean, signal?: AbortSignal): Promise<boolean | null> => {
      if (boardName !== 'spray' || layoutId === undefined) return null;
      const generation = ++requestGeneration.current;
      const credentials = getCredentialGeneration();
      const privacy = sprayPrivacyGeneration(layoutId);
      const removal = sprayWallRemovalGeneration(layoutId);
      const configuration = `${boardName}:${layoutId}`;
      const isCurrent = () =>
        mounted.current &&
        !signal?.aborted &&
        requestGeneration.current === generation &&
        config.current === configuration &&
        privacy === sprayPrivacyGeneration(layoutId) &&
        removal === sprayWallRemovalGeneration(layoutId) &&
        credentials === getCredentialGeneration();
      if (!isCurrent()) return false;
      let enabled = false;
      const fail = () => {
        if (!enabled || !isCurrent()) return false;
        // Nobody reads a toast on a locked phone. The write is retried on return.
        if (away.current) {
          missedWhileAway.current = true;
        } else if (!failureShown.current) {
          failureShown.current = true;
          failure.current?.();
        }
        return false;
      };
      const settled = (acknowledged: boolean) => {
        if (!acknowledged || !isCurrent()) return false;
        missedWhileAway.current = false;
        failureShown.current = false;
        return true;
      };
      const abort = () => {
        if (requestGeneration.current === generation) stop();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // Load network modules only for a spray-wall write, keeping native BLE's
        // existing boot/module graph independent of private spray-wall queries.
        const [
          { fetchSprayWallUuid, fetchSprayWallRenderData },
          { loadSprayWallLedSettings },
          { loadSprayWallTnutLayout },
        ] = await Promise.all([
          import('./spray-wall-loader'),
          import('./use-spray-wall-led-settings'),
          import('./spray-wall-tnut-store'),
        ]);
        const wallUuid = getSprayWall(layoutId)?.wallUuid ?? (await fetchSprayWallUuid(queryClient, layoutId));
        if (!isCurrent() || !wallUuid) return false;
        const settings = await loadSprayWallLedSettings(wallUuid);
        if (!isCurrent()) return false;
        if (!settings.enabled) {
          stop();
          return null;
        }
        enabled = true;
        if (!settings.controller.url || mirrored) return fail();
        let current = runtime.current;
        if (!current || current.url !== settings.controller.url || current.wallUuid !== wallUuid) {
          if (current) void current.session.close().catch(() => undefined);
          current = {
            wallUuid,
            url: settings.controller.url,
            session: createLedPreviewSession(getLedControllerDriver(settings.controller.type), settings.controller.url),
          };
          runtime.current = current;
        }
        if (!frames) return settled(await current.session.clear());
        const [payload, layout] = await Promise.all([
          fetchSprayWallRenderData(queryClient, wallUuid),
          loadSprayWallTnutLayout(wallUuid),
        ]);
        if (!isCurrent()) return false;
        if (!payload || payload.wall.layoutId !== layoutId || !layout?.wiring) return fail();
        const source = lookPreviewSourceFromRenderData(payload, {
          layoutId,
          versionId: payload.wall.currentVersion?.id,
        });
        if (!source || layout.photoKey !== sprayLedPhotoKey(source)) return fail();
        const holds = payload.holds.map(({ id, cx, cy, r, outline }) => ({ id, cx, cy, r, outline }));
        const mapping = buildSprayLedMapping(layout, source.frame, holds);
        const byHold = new Map(mapping.holds.map((hold) => [hold.holdId, hold]));
        const litHolds = accumulateFramesToMaps(toFlatFrames(frames, 'spray'), 'spray')[0];
        if (!litHolds || Object.keys(litHolds).length === 0) return fail();
        const pixels = new Map<number, LedPixel>();
        for (const [id, hold] of Object.entries(litHolds)) {
          const match = byHold.get(Number(id));
          if (!match?.indices.length) return fail();
          const override = colors.current?.[hold.state as keyof HoldColorOverrides];
          const rgb = hexToRgb(override ?? hold.color);
          if (!rgb) return fail();
          for (const index of match.indices) {
            pixels.set(index, { index, color: [rgb.red, rgb.green, rgb.blue] });
          }
        }
        if (!isCurrent()) return false;
        return settled(await current.session.show([...pixels.keys()], [...pixels.values()]));
      } catch {
        if (isCurrent()) {
          fail();
          // Away, the wall is left alone until the retry on return.
          if (!away.current) stop();
        }
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    [boardName, layoutId, queryClient, stop],
  );

  return { send, release };
}
