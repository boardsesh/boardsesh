import type { ClimbOverlaySwapLookProbe } from '../../../lib/board-render/gpu-native-capability';
import { SWAP_LOOK_NATIVE_VERSION } from '../../play-drawer/swap-look';
import type { BoardMotionVariant, LabLookStatus, LabRenderStatus } from '../types';
import { SWAP_LOOK_LAB_MODE } from '../variants/look-variant';

/**
 * Why Android's probe left the look off ("probe timeout after 1000 ms; next
 * launch retries"), or null when it did not: no probe (iOS, older binaries),
 * or the program built.
 */
export function swapLookProbeText(probe: ClimbOverlaySwapLookProbe | null | undefined): string | null {
  if (!probe) return null;
  const step = probe.failure ? ` (${probe.failure})` : '';
  switch (probe.result) {
    case 'timeout':
      return `probe timeout after ${Math.round(probe.ms)} ms; next launch retries`;
    case 'failed':
      return `look shader rejected by this GPU${step}`;
    case 'cached-failed':
      return `look shader rejected by this GPU${step}; kept until the app or GPU driver updates`;
    case 'built':
    case 'cached-built':
      return null;
  }
}

/** "look on (24 holds)", "look off (Reduce Motion)", …: whether the native look is drawing. */
export function formatLook(look: LabLookStatus): string {
  const reach = 'reachOff' in look && look.reachOff ? ` · reach off (${look.reachOff})` : '';
  switch (look.state) {
    case 'unsupported': {
      const probe = swapLookProbeText(look.probe);
      return probe ? `look off (${probe})` : `look off (unsupported build: swapLookVersion ${look.swapLookVersion})`;
    }
    case 'waiting':
      return 'look sent, no answer yet';
    case 'off':
      return `look off (${look.reason})`;
    case 'ready':
      return `look ready${reach}`;
    case 'on':
      return `look on (${look.holds} holds)${reach}`;
  }
}

/** "GPU · API 7 · prepare 42 ms · upload 3 ms · look on (24 holds)", "PNG · <reason>" or "Loading…". */
export function formatStatus(status: LabRenderStatus): string {
  switch (status.path) {
    case 'loading':
      return 'Loading…';
    case 'gpu':
      return [
        'GPU',
        `API ${status.apiVersion}`,
        status.prepareMs === null ? null : `prepare ${Math.round(status.prepareMs)} ms`,
        status.uploadMs === null ? null : `upload ${Math.round(status.uploadMs)} ms`,
        status.look ? formatLook(status.look) : null,
      ]
        .filter((part) => part !== null)
        .join(' · ');
    case 'png':
      return `PNG · ${status.reason}`;
  }
}

export type VariantAvailability = { available: true } | { available: false; reason: string };

/**
 * Whether this binary can run `variant`. The one native lab mode is the swap
 * look (`swapLookVersion`, iOS and Android); any other mode is unavailable.
 */
export function variantAvailability(
  variant: BoardMotionVariant,
  nativeApiVersion: number,
  swapLookVersion = 0,
): VariantAvailability {
  if (variant.requiresNativeLab === SWAP_LOOK_LAB_MODE) {
    if (swapLookVersion < SWAP_LOOK_NATIVE_VERSION) {
      return {
        available: false,
        reason: `needs the native swap look (swapLookVersion ${SWAP_LOOK_NATIVE_VERSION}); this build has ${swapLookVersion}`,
      };
    }
  } else if (variant.requiresNativeLab) {
    return { available: false, reason: `needs native lab mode "${variant.requiresNativeLab}"` };
  }
  if (variant.requiresNativeApi !== undefined && variant.requiresNativeApi > nativeApiVersion) {
    return {
      available: false,
      reason: `needs native API ${variant.requiresNativeApi}, this build has ${nativeApiVersion}`,
    };
  }
  return { available: true };
}

export function captionText(variant: BoardMotionVariant): string {
  return `${variant.letter} · ${variant.name}`;
}
