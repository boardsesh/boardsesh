import type { BoardName } from '@boardsesh/shared-schema';
import { getRenderedOverlay } from '../overlay-index';
import { getPrivacyCredentialGeneration, getPrivacyRevocationGeneration } from '../privacy/privacy-cache';
import { sprayPrivacyGeneration } from '../spray/spray-privacy-generation';
import { sprayCacheToken } from '../spray/spray-wall-registry';

export type BoardArtReadiness = 'loading' | 'ready' | 'failed';

export type ReadyBoardArtIdentity = Readonly<{
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  frames: string;
  renderSignature: string;
  colorScheme: string;
}>;

/** No component callbacks or mutable renderer state may cross the route boundary. */
export type ReadyBoardArtSnapshot = ReadyBoardArtIdentity &
  Readonly<{
    climbUuid: string;
    mirrored: boolean;
    quality: 'full' | 'thumbnail';
    overlayCacheKey: string;
    overlayUri: string;
    overlayGeneration: number;
    overlayLoadKey: string;
    backgroundPaths: readonly string[];
    backgroundBaseColor?: string;
    privacyGeneration: number;
    credentialGeneration: number;
    sprayGeneration: string;
    sprayVersion: string;
  }>;

/** Owned by one recycled row; only the immutable return value leaves that row. */
export type ReadyBoardArtSource = Readonly<{ read: () => ReadyBoardArtSnapshot | undefined }>;

export function captureReadyBoardArt(
  artwork: Omit<
    ReadyBoardArtSnapshot,
    'privacyGeneration' | 'credentialGeneration' | 'sprayGeneration' | 'sprayVersion'
  >,
): ReadyBoardArtSnapshot {
  return Object.freeze({
    ...artwork,
    backgroundPaths: Object.freeze([...artwork.backgroundPaths]),
    privacyGeneration: getPrivacyRevocationGeneration(),
    credentialGeneration: getPrivacyCredentialGeneration(),
    sprayGeneration: artwork.boardName === 'spray' ? sprayPrivacyGeneration(artwork.layoutId) : '',
    sprayVersion: sprayCacheToken(artwork.boardName, artwork.layoutId),
  });
}

export function isReadyBoardArtCurrent(
  snapshot: ReadyBoardArtSnapshot | undefined,
  expected: Pick<ReadyBoardArtIdentity, 'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'frames'> &
    Partial<Pick<ReadyBoardArtIdentity, 'renderSignature' | 'colorScheme'>> & {
      mirrored?: boolean;
      climbUuid?: string;
    },
): snapshot is ReadyBoardArtSnapshot {
  if (!snapshot) return false;
  if (
    snapshot.boardName !== expected.boardName ||
    snapshot.layoutId !== expected.layoutId ||
    snapshot.sizeId !== expected.sizeId ||
    snapshot.setIds !== expected.setIds ||
    snapshot.frames !== expected.frames ||
    (expected.mirrored !== undefined && snapshot.mirrored !== expected.mirrored) ||
    (expected.climbUuid !== undefined && snapshot.climbUuid !== expected.climbUuid) ||
    (expected.renderSignature !== undefined && snapshot.renderSignature !== expected.renderSignature) ||
    (expected.colorScheme !== undefined && snapshot.colorScheme !== expected.colorScheme) ||
    snapshot.privacyGeneration !== getPrivacyRevocationGeneration() ||
    snapshot.credentialGeneration !== getPrivacyCredentialGeneration() ||
    snapshot.sprayVersion !== sprayCacheToken(snapshot.boardName, snapshot.layoutId) ||
    (snapshot.boardName === 'spray' && snapshot.sprayGeneration !== sprayPrivacyGeneration(snapshot.layoutId))
  )
    return false;
  const entry = getRenderedOverlay(snapshot.overlayCacheKey);
  return entry?.uri === snapshot.overlayUri && entry.generation === snapshot.overlayGeneration;
}
