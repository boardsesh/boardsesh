import type { BoardName } from '@boardsesh/shared-schema';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';

export type OpeningLayoutIdentity = Readonly<{
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  climbUuid: string;
  frames: string;
  viewportWidth: number;
  viewportHeight: number;
  fontScale: number;
  pixelRatio: number;
  locale: string;
  insets: Readonly<{ top: number; right: number; bottom: number; left: number }>;
  preferencesFingerprint: string;
  firstSectionId: string | null;
  presentation: 'sheet' | 'pane';
  paneInset: number;
  headerFingerprint: string;
  controlsFingerprint: string;
  lostBanner: boolean;
  playbackFingerprint: string;
}>;

export type OpeningLayoutMeasurements = Readonly<{
  viewportHeight: number;
  headerBottomY: number;
  firstSectionHeaderHeight: number;
  containerSize: Readonly<{ width: number; height: number }>;
}>;

const OPENING_LAYOUT_LIMIT = 32;
const KEY_PREFIX = 'opening-layout-v1:';
type CachedLayout = {
  measurements: OpeningLayoutMeasurements;
  credentialGeneration: number;
};
const layouts = new Map<string, CachedLayout>();

const positive = (measurement: unknown): measurement is number =>
  typeof measurement === 'number' && Number.isFinite(measurement) && measurement > 0;
const nonnegative = (measurement: unknown): measurement is number =>
  typeof measurement === 'number' && Number.isFinite(measurement) && measurement >= 0;
const nonempty = (identifier: unknown): identifier is string => typeof identifier === 'string' && identifier.length > 0;

/** Complete model only: missing preferences or an unmeasured viewport cannot reuse geometry. */
export function buildOpeningLayoutKey(identity: OpeningLayoutIdentity): string | undefined {
  if (
    !identity ||
    !nonempty(identity.boardName) ||
    !positive(identity.layoutId) ||
    !positive(identity.sizeId) ||
    !nonempty(identity.setIds) ||
    !positive(identity.boardWidth) ||
    !positive(identity.boardHeight) ||
    !nonempty(identity.climbUuid) ||
    typeof identity.frames !== 'string' ||
    !positive(identity.viewportWidth) ||
    !positive(identity.viewportHeight) ||
    !positive(identity.fontScale) ||
    !positive(identity.pixelRatio) ||
    !nonempty(identity.locale) ||
    !identity.insets ||
    !Object.values(identity.insets).every(nonnegative) ||
    !['top', 'right', 'bottom', 'left'].every((edge) =>
      nonnegative(identity.insets[edge as keyof OpeningLayoutIdentity['insets']]),
    ) ||
    !nonempty(identity.preferencesFingerprint) ||
    !(identity.firstSectionId === null || nonempty(identity.firstSectionId)) ||
    !['sheet', 'pane'].includes(identity.presentation) ||
    !nonnegative(identity.paneInset) ||
    !nonempty(identity.headerFingerprint) ||
    !nonempty(identity.controlsFingerprint) ||
    typeof identity.lostBanner !== 'boolean' ||
    !nonempty(identity.playbackFingerprint)
  )
    return undefined;
  // An ordered tuple makes key equality independent of caller object insertion
  // order. Only primitive identity fields are retained; never climb objects.
  return (
    KEY_PREFIX +
    JSON.stringify([
      identity.boardName,
      identity.layoutId,
      identity.sizeId,
      identity.setIds,
      identity.boardWidth,
      identity.boardHeight,
      identity.climbUuid,
      identity.frames,
      identity.viewportWidth,
      identity.viewportHeight,
      identity.fontScale,
      identity.pixelRatio,
      identity.locale,
      identity.insets.top,
      identity.insets.right,
      identity.insets.bottom,
      identity.insets.left,
      identity.preferencesFingerprint,
      identity.firstSectionId,
      identity.presentation,
      identity.paneInset,
      identity.headerFingerprint,
      identity.controlsFingerprint,
      identity.lostBanner,
      identity.playbackFingerprint,
      getCredentialGeneration(),
    ])
  );
}

export function readOpeningLayout(key: string | undefined): OpeningLayoutMeasurements | undefined {
  if (!key) return undefined;
  const entry = layouts.get(key);
  if (!entry) return undefined;
  if (entry.credentialGeneration !== getCredentialGeneration()) {
    layouts.delete(key);
    return undefined;
  }
  layouts.delete(key);
  layouts.set(key, entry);
  return entry.measurements;
}

export function rememberOpeningLayout(key: string | undefined, measurements: OpeningLayoutMeasurements): boolean {
  if (
    !key?.startsWith(KEY_PREFIX) ||
    !measurements ||
    !positive(measurements.viewportHeight) ||
    !positive(measurements.headerBottomY) ||
    !measurements.containerSize ||
    !positive(measurements.containerSize.width) ||
    !positive(measurements.containerSize.height)
  )
    return false;
  let tuple: unknown;
  try {
    tuple = JSON.parse(key.slice(KEY_PREFIX.length));
  } catch {
    return false;
  }
  if (!Array.isArray(tuple) || tuple.length !== 26 || tuple[25] !== getCredentialGeneration()) return false;
  const identity = {
    boardName: tuple[0],
    layoutId: tuple[1],
    sizeId: tuple[2],
    setIds: tuple[3],
    boardWidth: tuple[4],
    boardHeight: tuple[5],
    climbUuid: tuple[6],
    frames: tuple[7],
    viewportWidth: tuple[8],
    viewportHeight: tuple[9],
    fontScale: tuple[10],
    pixelRatio: tuple[11],
    locale: tuple[12],
    insets: { top: tuple[13], right: tuple[14], bottom: tuple[15], left: tuple[16] },
    preferencesFingerprint: tuple[17],
    firstSectionId: tuple[18],
    presentation: tuple[19],
    paneInset: tuple[20],
    headerFingerprint: tuple[21],
    controlsFingerprint: tuple[22],
    lostBanner: tuple[23],
    playbackFingerprint: tuple[24],
  } as OpeningLayoutIdentity;
  if (buildOpeningLayoutKey(identity) !== key) return false;
  const hasSection = tuple[18] !== null;
  if (
    (hasSection
      ? !positive(measurements.firstSectionHeaderHeight)
      : !nonnegative(measurements.firstSectionHeaderHeight)) ||
    measurements.headerBottomY + measurements.firstSectionHeaderHeight >= measurements.viewportHeight
  )
    return false;
  const immutable = Object.freeze({
    viewportHeight: measurements.viewportHeight,
    headerBottomY: measurements.headerBottomY,
    firstSectionHeaderHeight: measurements.firstSectionHeaderHeight,
    containerSize: Object.freeze({
      width: measurements.containerSize.width,
      height: measurements.containerSize.height,
    }),
  });
  layouts.delete(key);
  if (layouts.size >= OPENING_LAYOUT_LIMIT) {
    const oldest = layouts.keys().next().value;
    if (oldest !== undefined) layouts.delete(oldest);
  }
  layouts.set(key, {
    measurements: immutable,
    credentialGeneration: getCredentialGeneration(),
  });
  return true;
}

export function clearOpeningLayoutCache(): void {
  layouts.clear();
}

// Withdraw before asynchronous query cleanup, including an already captured key.
subscribeToCredentialChanges(clearOpeningLayoutCache);
