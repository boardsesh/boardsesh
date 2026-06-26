// Bridges the board-connection state into the renderer-agnostic
// `deriveAccessoryContext` (from @boardsesh/play-view) and resolves the eyebrow
// caption text. Shared by the floating capsule (ClimbCapsule), the iOS 26 native
// platter row (NativeAccessoryClimbRow), and the bar's visibility gate
// (persistent-queue-bar). All reads are O(1) on the hot path.

import { useMemo } from 'react';
import { type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { deriveAccessoryContext, type AccessoryContext, type AccessoryEyebrowKind } from '@boardsesh/play-view';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useAccessoryNowPlayingEnabled } from './use-accessory-now-playing-flag';

/**
 * The raw now-playing context (tier / eyebrow kind / tick) for this device. The
 * redesign flag is folded in here, so flag-off yields the pre-redesign context
 * (no eyebrow, tick always shown) at the single source.
 */
export function useAccessoryPresentation(): AccessoryContext {
  const { boardConnection, holderDisplayName } = useBoardConnectionState();
  const enabled = useAccessoryNowPlayingEnabled();
  return useMemo(
    () => deriveAccessoryContext({ boardConnection, holderDisplayName, enabled }),
    [boardConnection, holderDisplayName, enabled],
  );
}

export type AccessoryEyebrow = {
  /** Localized eyebrow caption, or `null` when the redesign is off (no eyebrow). */
  text: string | null;
  /** Which status this is — drives the caption colour (live = brand accent). */
  tone: AccessoryEyebrowKind | null;
  /** Whether the trailing tick shows (hidden for a peer's read-only climb). */
  showTick: boolean;
};

/**
 * Localizes an already-derived context into the eyebrow caption (+ tick gate).
 * Takes the context as input so a component that already reads the connection
 * state (e.g. ClimbCapsule) can derive it once and not subscribe to it twice.
 * A `null` eyebrow (redesign off) yields `text: null` — no caption.
 */
export function useAccessoryEyebrowFromContext({ eyebrow, showTick }: AccessoryContext): AccessoryEyebrow {
  const { t } = useTranslation('session');

  const text = useMemo(() => {
    if (!eyebrow) return null;
    switch (eyebrow.kind) {
      case 'live':
        return t('queueBar.nowPlaying.live');
      case 'peer':
        return eyebrow.name ? t('queueBar.nowPlaying.peer', { name: eyebrow.name }) : t('queueBar.nowPlaying.peerAnon');
      case 'upNext':
        return t('queueBar.nowPlaying.upNext');
      default:
        // A new AccessoryEyebrowKind without a case here is a compile error.
        eyebrow.kind satisfies never;
        return null;
    }
  }, [t, eyebrow]);

  const tone = eyebrow?.kind ?? null;
  // Stable identity so a future React.memo / context consumer doesn't churn.
  return useMemo(() => ({ text, tone, showTick }), [text, tone, showTick]);
}

/** Convenience for components that don't already read the connection state. */
export function useAccessoryEyebrow(): AccessoryEyebrow {
  return useAccessoryEyebrowFromContext(useAccessoryPresentation());
}

/**
 * The eyebrow caption colour: "live" runs hot in the brand accent; the quieter
 * peer / up-next states use the secondary label so they read as ambient status.
 * One place so the capsule and the native platter row can't drift.
 */
export function accessoryEyebrowColor(
  tone: AccessoryEyebrowKind | null,
  live: ColorValue,
  idle: ColorValue,
): ColorValue {
  return tone === 'live' ? live : idle;
}
