import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { accumulateFramesToMaps, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { buildSprayLedMapping } from '@boardsesh/spray-wall-geometry';
import { createLedPreviewSession, type LedPixel, type LedPreviewSession } from '@boardsesh/led-controller';
import { loadSprayLedDriver } from './spray-led-driver';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../privacy/privacy-cache';
import { hexToRgb, type HoldColorOverrides } from '../hold-color-overrides';
import { subscribeSprayLedConfiguration } from './spray-led-config-events';
import { sprayLedPhotoKey } from './spray-led-photo-key';
import { getSprayWall, sprayWallRemovalGeneration, subscribeToSprayWallWithdrawals } from './spray-wall-registry';
import { sprayPrivacyGeneration } from './spray-privacy-generation';

type RouteRuntime = { wallUuid: string; url: string; session: LedPreviewSession };
type RouteRequest = { frames: string; mirrored?: boolean; signal?: AbortSignal; pending: boolean };
type RouteWrite = (
  frames: string,
  mirrored?: boolean,
  signal?: AbortSignal,
  refreshSession?: LedPreviewSession,
) => Promise<boolean | null>;
const ABOVE_HOLD_BRIGHTNESS = 0.25;

/**
 * LAN writes share the normal wall commit path and require a deliberate wall
 * hold. As on a Bluetooth board, locking the phone or letting go of the wall
 * leaves the climb lit; only a clear, or a change that makes it wrong, ends it.
 */
export function useSprayLedRouteSender({
  boardName,
  layoutId,
  colorOverrides,
  lightAboveHolds = false,
  onInvalidated,
  onFailure,
}: {
  boardName?: string;
  layoutId?: number;
  colorOverrides?: HoldColorOverrides;
  lightAboveHolds?: boolean;
  onInvalidated: (retry?: boolean) => void;
  onFailure?: () => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('boards');
  const translation = useRef(t);
  translation.current = t;
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
  const upperLighting = useRef(lightAboveHolds);
  upperLighting.current = lightAboveHolds;
  const latestRoute = useRef<RouteRequest | null>(null);
  const acknowledgedRoute = useRef<RouteRequest | null>(null);
  const writeRoute = useRef<RouteWrite | null>(null);

  const stop = useCallback((lights: 'off' | 'leave' = 'off') => {
    requestGeneration.current++;
    missedWhileAway.current = false;
    const previous = runtime.current;
    runtime.current = null;
    latestRoute.current = null;
    acknowledgedRoute.current = null;
    if (previous) {
      void (lights === 'off' ? previous.session.close() : previous.session.detach()).catch(() => undefined);
    }
    if (mounted.current) invalidate.current();
  }, []);
  const release = useCallback(() => stop('leave'), [stop]);

  const previousUpperLighting = useRef(lightAboveHolds);
  useEffect(() => {
    if (previousUpperLighting.current === lightAboveHolds) return;
    previousUpperLighting.current = lightAboveHolds;
    if (boardName !== 'spray') return;
    const requested = latestRoute.current?.pending ? latestRoute.current : acknowledgedRoute.current;
    const session = runtime.current?.session;
    // A pending send reads the latest option itself and keeps its original acknowledgement.
    // A settled send may refresh only the same route while this session still owns the lights.
    if (!requested?.frames || requested.pending || requested.signal?.aborted || !session?.isOwner()) return;
    void writeRoute.current?.(requested.frames, requested.mirrored, requested.signal, session);
  }, [boardName, lightAboveHolds]);

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
    const credentials = subscribeToCredentialChanges(() => stop('leave'));
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
    async (
      frames: string,
      mirrored?: boolean,
      signal?: AbortSignal,
      refreshSession?: LedPreviewSession,
    ): Promise<boolean | null> => {
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
      const requested: RouteRequest = { frames, mirrored, signal, pending: true };
      latestRoute.current = requested;
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
        acknowledgedRoute.current = requested;
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
          { fetchSprayWallUuid },
          { loadSprayWallLedSettings },
          { loadSprayWallTnutLayout },
          { loadSprayLedRouteGeometry },
        ] = await Promise.all([
          import('./spray-wall-loader'),
          import('./use-spray-wall-led-settings'),
          import('./spray-wall-tnut-store'),
          import('./spray-led-route-geometry'),
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
        if (settings.controller.type === 'wled-ble') {
          const { explainSprayBluetooth } = await import('./spray-led-ble-primer');
          const accepted = await explainSprayBluetooth(
            {
              title: translation.current('sprayLed.bluetooth.title'),
              body: translation.current('sprayLed.bluetooth.hint'),
              // i18n-keep boards:sprayLed.bluetooth.allow
              allow: translation.current('sprayLed.bluetooth.allow'),
              // i18n-keep boards:sprayLed.bluetooth.notNow
              notNow: translation.current('sprayLed.bluetooth.notNow'),
            },
            signal,
          );
          if (!accepted || !isCurrent()) return false;
        }
        if (!settings.controller.url || mirrored) return fail();
        let current = runtime.current;
        if (!current || current.url !== settings.controller.url || current.wallUuid !== wallUuid) {
          const driver = await loadSprayLedDriver(settings.controller.type);
          if (!isCurrent()) return false;
          if (current) void current.session.close().catch(() => undefined);
          current = {
            wallUuid,
            url: settings.controller.url,
            session: createLedPreviewSession(driver, settings.controller.url),
          };
          runtime.current = current;
        }
        if (!isCurrent()) return false;
        if (!frames) return settled(await current.session.clear());
        const [geometry, layout] = await Promise.all([
          loadSprayLedRouteGeometry(queryClient, wallUuid, layoutId),
          loadSprayWallTnutLayout(wallUuid),
        ]);
        if (!isCurrent()) return false;
        if (!geometry || !layout?.wiring || layout.photoKey !== sprayLedPhotoKey(geometry)) return fail();
        const mapping = buildSprayLedMapping(layout, geometry.frame, geometry.holds);
        const byHold = new Map(mapping.holds.map((hold) => [hold.holdId, hold]));
        const litHolds = accumulateFramesToMaps(toFlatFrames(frames, 'spray'), 'spray')[0];
        if (!litHolds || Object.keys(litHolds).length === 0) return fail();
        let wrote = false;
        while (isCurrent()) {
          const upperLightingForWrite = upperLighting.current;
          const pixels = new Map<number, LedPixel>();
          const upperPixels = new Map<number, LedPixel>();
          const includeUpper = upperLightingForWrite && ['below', 'alternating'].includes(layout.ledPlacement ?? '');
          for (const [id, hold] of Object.entries(litHolds)) {
            const match = byHold.get(Number(id));
            if (!match?.indices.length) return fail();
            const override = colors.current?.[hold.state as keyof HoldColorOverrides];
            const rgb = hexToRgb(override ?? hold.color);
            if (!rgb) return fail();
            for (const index of match.indices) pixels.set(index, { index, color: [rgb.red, rgb.green, rgb.blue] });
            if (includeUpper) {
              for (const index of match.aboveIndices ?? []) {
                upperPixels.set(index, {
                  index,
                  color: [
                    Math.round(rgb.red * ABOVE_HOLD_BRIGHTNESS),
                    Math.round(rgb.green * ABOVE_HOLD_BRIGHTNESS),
                    Math.round(rgb.blue * ABOVE_HOLD_BRIGHTNESS),
                  ],
                });
              }
            }
          }
          // A route's main LED always wins over another hold's dim upper reference.
          for (const [index, pixel] of upperPixels) if (!pixels.has(index)) pixels.set(index, pixel);
          if (!isCurrent()) return false;
          if (refreshSession && (current.session !== refreshSession || !refreshSession.isOwner())) return false;
          if (wrote && !current.session.isOwner()) return false;
          const acknowledged = await current.session.show([...pixels.keys()], [...pixels.values()]);
          if (!acknowledged || !isCurrent()) return false;
          wrote = true;
          if (upperLighting.current === upperLightingForWrite) return settled(true);
        }
        return false;
      } catch {
        if (isCurrent()) {
          fail();
          // Away, the wall is left alone until the retry on return.
          if (!away.current) stop();
        }
        return false;
      } finally {
        requested.pending = false;
        signal?.removeEventListener('abort', abort);
      }
    },
    [boardName, layoutId, queryClient, stop],
  );
  writeRoute.current = send;

  return { send, release };
}
