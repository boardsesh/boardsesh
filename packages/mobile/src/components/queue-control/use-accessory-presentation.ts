// Bridges the board-connection state into the renderer-agnostic
// `deriveAccessoryContext` (from @boardsesh/play-view) and resolves the eyebrow
// caption text. Shared by the floating capsule (ClimbCapsule), the iOS 26 native
// platter row (NativeAccessoryClimbRow), and the bar's visibility gate
// (persistent-queue-bar). All reads are O(1) on the hot path.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { deriveAccessoryContext, type AccessoryContext, type AccessoryEyebrowKind } from '@boardsesh/play-view';
import { useBoardConnectionState } from '../ble/use-board-connection-state';

/** The raw now-playing context (tier / eyebrow kind / tick) for this device. */
export function useAccessoryPresentation(): AccessoryContext {
  const { boardConnection, holderDisplayName } = useBoardConnectionState();
  return useMemo(
    () => deriveAccessoryContext({ boardConnection, holderDisplayName }),
    [boardConnection, holderDisplayName],
  );
}

export type AccessoryEyebrow = {
  /** Localized eyebrow caption, e.g. "On the wall · live" / "Tara on the wall". */
  text: string;
  /** Which status this is — drives the caption colour (live = brand accent). */
  tone: AccessoryEyebrowKind;
  showTick: boolean;
  tier: AccessoryContext['tier'];
};

/**
 * Localizes an already-derived context into the eyebrow caption. Takes the
 * context as input so a component that already reads the connection state (e.g.
 * ClimbCapsule) can derive it once and not subscribe to that state twice.
 */
export function useAccessoryEyebrowText({ tier, eyebrow, showTick }: AccessoryContext): AccessoryEyebrow {
  const { t } = useTranslation('session');

  const text = useMemo(() => {
    switch (eyebrow.kind) {
      case 'live':
        return t('queueBar.nowPlaying.live');
      case 'peer':
        return eyebrow.name ? t('queueBar.nowPlaying.peer', { name: eyebrow.name }) : t('queueBar.nowPlaying.peerAnon');
      case 'upNext':
        return t('queueBar.nowPlaying.upNext');
    }
  }, [t, eyebrow.kind, eyebrow.name]);

  return { text, tone: eyebrow.kind, showTick, tier };
}

/** Convenience for components that don't already read the connection state. */
export function useAccessoryEyebrow(): AccessoryEyebrow {
  return useAccessoryEyebrowText(useAccessoryPresentation());
}
