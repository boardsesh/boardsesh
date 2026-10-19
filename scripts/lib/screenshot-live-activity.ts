/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionLocale } from './screenshot-presentation';
import type { LiveActivityExterior } from './screenshot-live-activity-exterior';

export const LIVE_ACTIVITY_FIXTURE_ROOT = fileURLToPath(
  new URL('../../app-stores/apple/live-activity-captures/', import.meta.url),
);
export const LIVE_ACTIVITY_MANIFEST = 'manifest.json';
export type LiveActivityBoardFamily = 'kilter' | 'tension' | 'moonboard';
export interface NativeCaptureSize {
  width: number;
  height: number;
}
export interface NativeCaptureRect extends NativeCaptureSize {
  x: number;
  y: number;
}
export interface LiveActivityFixture {
  file: string;
  sha256: string;
  sourcePngSha256: string;
  boardFamily: LiveActivityBoardFamily;
  appLocale: CaptionLocale;
  /** Actual native widget language; never inferred from the app or marketing caption. */
  widgetLocale: string;
  captureSurface: 'notification-center' | 'lock-screen';
  device: string;
  sourceBuild: string;
  /** Unknown for a TestFlight build unless its build metadata establishes the commit. */
  appSourceCommit: string | null;
  capturedAt: string;
  nativePixels: NativeCaptureSize;
  screenPoints: NativeCaptureSize;
  cropRect: NativeCaptureRect;
  /** Keep the complete native system surface, including its real clock and wallpaper. */
  captureFraming?: 'full-screen';
  lockScreenContext?: {
    wallpaper: string;
    deviceLocked: true;
    unrelatedNotificationsDismissed: true;
    liveActivityRect: NativeCaptureRect;
  };
  /** Notification Center is distinct from a continuously passcode-locked capture. */
  notificationCenterContext?: {
    wallpaper: string;
    unrelatedNotificationsDismissed: true;
    liveActivityRect: NativeCaptureRect;
    entryFromAuthenticatedApp: true;
    authenticationState: 'not-established';
  };
  /** Only exterior wallpaper alpha changes; all native card RGB remains untouched. */
  extraction?: LiveActivityExterior;
  content: {
    climbName: string;
    grade: string;
    /** One-based position printed by the native widget. */
    currentIndex: number;
    totalClimbs: number;
    nextEnabled: boolean;
  };
  controller: {
    connection: 'real-ble';
    presentedBoardFamily: LiveActivityBoardFamily;
    description: string;
    physicalWallLightingVerified: boolean;
    /** Reviewed development controller used with a different Aurora board family. */
    compatibility?: {
      protocol: 'aurora-uart';
      targetBoardFamily: 'tension';
      serialMismatchAccepted: true;
      verification: 'native-next-and-received-led-payload';
    };
  };
  review: {
    reviewedAt: string;
    reviewedBy: string;
    nativePixelsUnmodified: true;
    unrelatedNotificationsExcluded: true;
    appLocaleVerified: true;
    nextNavigationVerified: true;
  };
}
export interface LiveActivityFixtureManifest {
  version: 1;
  fixtures: Record<string, LiveActivityFixture>;
  /** Reviewed physical video sources, shared explicitly across output locales. */
  footage?: Partial<Record<'kilter' | 'tension', LiveActivityFootageSource>>;
}
export interface LiveActivityFootageSource {
  sha256: string;
  key: string;
  boardFamily: 'kilter' | 'tension';
  sourceLocale: CaptionLocale;
  nativeFixtureSourcePngSha256: string;
  frameCount: number;
  durationSeconds: number;
  reviewedAt: string;
  reviewedBy: string;
}
export interface LoadedLiveActivityFixture {
  pixels: Buffer;
  provenance: LiveActivityFixture;
  manifestSha256: string;
  /** The same PNG supplies its exterior-only alpha mask to native video cards. */
  maskPath: string;
}
export const nativeCaptureSha256 = (pixels: Buffer): string => createHash('sha256').update(pixels).digest('hex');

function record(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
function positiveInteger(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0;
}
function size(candidate: unknown): candidate is NativeCaptureSize {
  return record(candidate) && positiveInteger(candidate.width) && positiveInteger(candidate.height);
}
function hash(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
}
function text(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}
function timestamp(candidate: unknown): candidate is string {
  return text(candidate) && Number.isFinite(Date.parse(candidate));
}

function controllerMatchesCapture(controller: Record<string, unknown>, boardFamily: LiveActivityBoardFamily): boolean {
  const compatibility = controller.compatibility;
  if (compatibility === undefined) return controller.presentedBoardFamily === boardFamily;
  // Keep the advertised identity honest. Only the reviewed Tension capture on
  // our Kilter-presenting Aurora development controller has navigation proof.
  return (
    boardFamily === 'tension' &&
    controller.presentedBoardFamily === 'kilter' &&
    controller.physicalWallLightingVerified === false &&
    record(compatibility) &&
    compatibility.protocol === 'aurora-uart' &&
    compatibility.targetBoardFamily === 'tension' &&
    compatibility.serialMismatchAccepted === true &&
    compatibility.verification === 'native-next-and-received-led-payload'
  );
}

/** Validate identity before reading pixels; another family or locale is never a fallback. */
export function validateLiveActivityFixture(
  candidate: unknown,
  boardFamily: LiveActivityBoardFamily,
  locale: CaptionLocale,
): LiveActivityFixture {
  const invalid = () => new Error(`Invalid native Live Activity provenance for ${boardFamily}/${locale}`);
  if (!record(candidate) || candidate.boardFamily !== boardFamily || candidate.appLocale !== locale) throw invalid();
  const { nativePixels, screenPoints, cropRect, content, controller, review } = candidate;
  if (
    !text(candidate.file) ||
    !/^[\w.-]+\.png$/.test(candidate.file) ||
    !hash(candidate.sha256) ||
    !hash(candidate.sourcePngSha256) ||
    !text(candidate.widgetLocale) ||
    !['notification-center', 'lock-screen'].includes(String(candidate.captureSurface)) ||
    !text(candidate.device) ||
    !/^TestFlight\d+\.\d+\.\d+\(\d+\)$/.test(String(candidate.sourceBuild)) ||
    !(
      candidate.appSourceCommit === null ||
      (text(candidate.appSourceCommit) && /^[a-f0-9]{40}$/.test(candidate.appSourceCommit))
    ) ||
    !timestamp(candidate.capturedAt) ||
    !size(nativePixels) ||
    !size(screenPoints) ||
    !size(cropRect) ||
    !record(cropRect) ||
    !Number.isSafeInteger(cropRect.x) ||
    !Number.isSafeInteger(cropRect.y) ||
    Number(cropRect.x) < 0 ||
    Number(cropRect.y) < 0 ||
    Number(cropRect.x) + cropRect.width > nativePixels.width ||
    Number(cropRect.y) + cropRect.height > nativePixels.height ||
    !record(content) ||
    !text(content.climbName) ||
    !text(content.grade) ||
    !positiveInteger(content.currentIndex) ||
    !positiveInteger(content.totalClimbs) ||
    content.currentIndex > content.totalClimbs ||
    typeof content.nextEnabled !== 'boolean' ||
    content.nextEnabled !== content.currentIndex < content.totalClimbs ||
    !record(controller) ||
    controller.connection !== 'real-ble' ||
    !controllerMatchesCapture(controller, boardFamily) ||
    !text(controller.description) ||
    typeof controller.physicalWallLightingVerified !== 'boolean' ||
    !record(review) ||
    !timestamp(review.reviewedAt) ||
    !text(review.reviewedBy) ||
    review.nativePixelsUnmodified !== true ||
    review.unrelatedNotificationsExcluded !== true ||
    review.appLocaleVerified !== true ||
    review.nextNavigationVerified !== true
  )
    throw invalid();
  const extraction = candidate.extraction;
  const lockScreenContext = candidate.lockScreenContext;
  const notificationCenterContext = candidate.notificationCenterContext;
  const fullContext = candidate.captureSurface === 'lock-screen' ? lockScreenContext : notificationCenterContext;
  if (candidate.captureFraming !== undefined) {
    if (
      candidate.captureFraming !== 'full-screen' ||
      cropRect.x !== 0 ||
      cropRect.y !== 0 ||
      cropRect.width !== nativePixels.width ||
      cropRect.height !== nativePixels.height ||
      candidate.sha256 !== candidate.sourcePngSha256 ||
      extraction !== undefined ||
      !record(fullContext) ||
      !text(fullContext.wallpaper) ||
      fullContext.unrelatedNotificationsDismissed !== true ||
      !record(fullContext.liveActivityRect) ||
      !size(fullContext.liveActivityRect) ||
      !Number.isSafeInteger(fullContext.liveActivityRect.x) ||
      !Number.isSafeInteger(fullContext.liveActivityRect.y) ||
      Number(fullContext.liveActivityRect.x) < 0 ||
      Number(fullContext.liveActivityRect.y) < 0 ||
      Number(fullContext.liveActivityRect.x) + fullContext.liveActivityRect.width > nativePixels.width ||
      Number(fullContext.liveActivityRect.y) + fullContext.liveActivityRect.height > nativePixels.height ||
      (candidate.captureSurface === 'lock-screen'
        ? fullContext.deviceLocked !== true || notificationCenterContext !== undefined
        : lockScreenContext !== undefined ||
          fullContext.deviceLocked !== undefined ||
          fullContext.entryFromAuthenticatedApp !== true ||
          fullContext.authenticationState !== 'not-established')
    )
      throw invalid();
  } else if (lockScreenContext !== undefined || notificationCenterContext !== undefined) throw invalid();
  if (
    extraction !== undefined &&
    (!record(extraction) ||
      extraction.method !== 'edge-connected-native-exterior-alpha' ||
      extraction.maxBackgroundRed !== 3 ||
      extraction.borderGuardPixels !== 1 ||
      !positiveInteger(extraction.transparentPixels) ||
      !hash(extraction.nativeCropSha256) ||
      !hash(extraction.alphaSha256))
  )
    throw invalid();
  // Explicit allowlist: raw accessibility snapshots and notification contents
  // supplied during local capture must never enter committed fixture metadata.
  return {
    file: candidate.file,
    sha256: candidate.sha256,
    sourcePngSha256: candidate.sourcePngSha256,
    boardFamily,
    appLocale: locale,
    widgetLocale: candidate.widgetLocale,
    captureSurface: candidate.captureSurface as LiveActivityFixture['captureSurface'],
    device: candidate.device,
    sourceBuild: String(candidate.sourceBuild),
    appSourceCommit: candidate.appSourceCommit as string | null,
    capturedAt: candidate.capturedAt,
    nativePixels: { width: nativePixels.width, height: nativePixels.height },
    screenPoints: { width: screenPoints.width, height: screenPoints.height },
    cropRect: { x: Number(cropRect.x), y: Number(cropRect.y), width: cropRect.width, height: cropRect.height },
    ...(candidate.captureFraming === 'full-screen' && record(fullContext) && record(fullContext.liveActivityRect)
      ? {
          captureFraming: 'full-screen' as const,
          ...(candidate.captureSurface === 'lock-screen'
            ? {
                lockScreenContext: {
                  wallpaper: String(fullContext.wallpaper),
                  deviceLocked: true as const,
                  unrelatedNotificationsDismissed: true as const,
                  liveActivityRect: {
                    x: Number(fullContext.liveActivityRect.x),
                    y: Number(fullContext.liveActivityRect.y),
                    width: fullContext.liveActivityRect.width as number,
                    height: fullContext.liveActivityRect.height as number,
                  },
                },
              }
            : {
                notificationCenterContext: {
                  wallpaper: String(fullContext.wallpaper),
                  unrelatedNotificationsDismissed: true as const,
                  entryFromAuthenticatedApp: true as const,
                  authenticationState: 'not-established' as const,
                  liveActivityRect: {
                    x: Number(fullContext.liveActivityRect.x),
                    y: Number(fullContext.liveActivityRect.y),
                    width: fullContext.liveActivityRect.width as number,
                    height: fullContext.liveActivityRect.height as number,
                  },
                },
              }),
        }
      : {}),
    ...(record(extraction)
      ? {
          extraction: {
            method: 'edge-connected-native-exterior-alpha' as const,
            maxBackgroundRed: 3 as const,
            borderGuardPixels: 1 as const,
            transparentPixels: Number(extraction.transparentPixels),
            nativeCropSha256: String(extraction.nativeCropSha256),
            alphaSha256: String(extraction.alphaSha256),
          },
        }
      : {}),
    content: {
      climbName: content.climbName,
      grade: content.grade,
      currentIndex: content.currentIndex,
      totalClimbs: content.totalClimbs,
      nextEnabled: content.nextEnabled,
    },
    controller: {
      connection: 'real-ble',
      presentedBoardFamily: controller.presentedBoardFamily as LiveActivityBoardFamily,
      description: controller.description,
      physicalWallLightingVerified: controller.physicalWallLightingVerified,
      ...(record(controller.compatibility)
        ? {
            compatibility: {
              protocol: 'aurora-uart' as const,
              targetBoardFamily: 'tension' as const,
              serialMismatchAccepted: true as const,
              verification: 'native-next-and-received-led-payload' as const,
            },
          }
        : {}),
    },
    review: {
      reviewedAt: review.reviewedAt,
      reviewedBy: review.reviewedBy,
      nativePixelsUnmodified: true,
      unrelatedNotificationsExcluded: true,
      appLocaleVerified: true,
      nextNavigationVerified: true,
    },
  };
}

export function readLiveActivityManifest(root = LIVE_ACTIVITY_FIXTURE_ROOT): LiveActivityFixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(root, LIVE_ACTIVITY_MANIFEST), 'utf8'));
  if (!record(parsed) || parsed.version !== 1 || !record(parsed.fixtures))
    throw new Error('Invalid native Live Activity fixture manifest');
  const fixtures: Record<string, LiveActivityFixture> = {};
  for (const [identity, candidate] of Object.entries(parsed.fixtures)) {
    const match = /^(kilter|tension|moonboard)\/(en-US|es|fr|de)$/.exec(identity);
    if (!match) throw new Error(`Unsupported native Live Activity fixture identity: ${identity}`);
    fixtures[identity] = validateLiveActivityFixture(
      candidate,
      match[1] as LiveActivityBoardFamily,
      match[2] as CaptionLocale,
    );
  }
  const footage: LiveActivityFixtureManifest['footage'] = {};
  if (parsed.footage !== undefined) {
    if (!record(parsed.footage)) throw new Error('Invalid retained Live Activity footage');
    for (const [family, candidate] of Object.entries(parsed.footage)) {
      if (
        !['kilter', 'tension'].includes(family) ||
        !record(candidate) ||
        candidate.boardFamily !== family ||
        !hash(candidate.sha256) ||
        candidate.key !== `sources/live-activity/${candidate.sha256}.zip` ||
        !['en-US', 'es', 'fr', 'de'].includes(String(candidate.sourceLocale)) ||
        !hash(candidate.nativeFixtureSourcePngSha256) ||
        !positiveInteger(candidate.frameCount) ||
        typeof candidate.durationSeconds !== 'number' ||
        !Number.isFinite(candidate.durationSeconds) ||
        candidate.durationSeconds < 6 ||
        !timestamp(candidate.reviewedAt) ||
        !text(candidate.reviewedBy) ||
        fixtures[`${family}/${String(candidate.sourceLocale)}`]?.sourcePngSha256 !==
          candidate.nativeFixtureSourcePngSha256
      )
        throw new Error(`Invalid retained Live Activity footage for ${family}`);
      footage[family as 'kilter' | 'tension'] = candidate as unknown as LiveActivityFootageSource;
    }
  }
  return { version: 1, fixtures, ...(parsed.footage !== undefined ? { footage } : {}) };
}

export function loadLiveActivityFixture(
  boardFamily: LiveActivityBoardFamily,
  locale: CaptionLocale,
  root = LIVE_ACTIVITY_FIXTURE_ROOT,
): LoadedLiveActivityFixture {
  const manifestBytes = readFileSync(join(root, LIVE_ACTIVITY_MANIFEST));
  const manifest = readLiveActivityManifest(root);
  const candidate = manifest.fixtures[`${boardFamily}/${locale}`];
  if (!candidate)
    throw new Error(
      `Missing reviewed native Live Activity fixture: ${boardFamily}/${locale}. Capture and review it locally; CI cannot capture Live Activities.`,
    );
  const provenance = validateLiveActivityFixture(candidate, boardFamily, locale);
  const pixels = readFileSync(join(root, provenance.file));
  if (nativeCaptureSha256(pixels) !== provenance.sha256)
    throw new Error(`Native Live Activity fixture hash mismatch: ${provenance.file}`);
  if (
    pixels.length < 26 ||
    !pixels.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    pixels.readUInt32BE(16) !== provenance.cropRect.width ||
    pixels.readUInt32BE(20) !== provenance.cropRect.height
  )
    throw new Error(`Native Live Activity crop dimensions mismatch: ${provenance.file}`);
  if (provenance.captureFraming !== 'full-screen' && !provenance.extraction)
    throw new Error(`Native Live Activity fixture needs reviewed exterior alpha extraction: ${provenance.file}`);
  if (provenance.captureFraming !== 'full-screen' && (pixels[24] !== 8 || pixels[25] !== 6))
    throw new Error(`Native Live Activity fixture is missing its reviewed exterior alpha: ${provenance.file}`);
  if (provenance.captureFraming === 'full-screen' && (pixels[24] !== 8 || ![2, 6].includes(pixels[25])))
    throw new Error(`Native Lock Screen fixture has an unsupported native PNG format: ${provenance.file}`);
  return {
    pixels,
    provenance,
    manifestSha256: nativeCaptureSha256(manifestBytes),
    maskPath: join(root, provenance.file),
  };
}

/** Whole-phone marketing recipes must never reuse the earlier cropped-card evidence. */
export function loadFullScreenLiveActivityFixture(
  boardFamily: LiveActivityBoardFamily,
  locale: CaptionLocale,
  root = LIVE_ACTIVITY_FIXTURE_ROOT,
): LoadedLiveActivityFixture {
  const fixture = loadLiveActivityFixture(boardFamily, locale, root);
  if (fixture.provenance.captureFraming !== 'full-screen')
    throw new Error(
      `Whole-phone Live Activity recipe requires a reviewed complete native system screen: ${boardFamily}/${locale}. Regenerate the physical capture locally; cropped cards are not supported.`,
    );
  return fixture;
}
