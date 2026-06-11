import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { ANGLES, normaliseSetIds } from '@boardsesh/board-config';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '../custom-board-options';
import { GUEST_BOARD_UUID_PREFIX, isGuestActiveBoard } from './guest-board-id';

export { GUEST_BOARD_UUID_PREFIX, isGuestActiveBoard };

type GuestBoardInput = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number;
  displayName?: string | null;
  layoutName?: string | null;
  sizeName?: string | null;
  sizeDescription?: string | null;
  setNames?: string[] | null;
  totalAscents?: number;
};

function resolveGuestAngle(boardName: BoardName, requestedAngle: number | undefined): number {
  const supportedAngles = ANGLES[boardName] ?? [];
  if (requestedAngle != null && supportedAngles.includes(requestedAngle)) return requestedAngle;
  if (supportedAngles.includes(40)) return 40;
  return supportedAngles[0] ?? 0;
}

function slugPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'board'
  );
}

export function createGuestActiveBoard(input: GuestBoardInput): UserBoard {
  const setIds = normaliseSetIds(input.setIds);
  const selectedSetIds = new Set(setIds.split(','));
  const layout = input.layoutName
    ? null
    : getBoardLayouts(input.boardName).find((candidate) => candidate.id === input.layoutId);
  const size = input.sizeName
    ? null
    : getBoardSizesForLayoutId(input.boardName, input.layoutId).find((candidate) => candidate.id === input.sizeId);
  const setNames =
    input.setNames ??
    getBoardSetsForLayoutAndSize(input.boardName, input.layoutId, input.sizeId)
      .filter((set) => selectedSetIds.has(String(set.id)))
      .map((set) => set.name);
  const layoutName = input.layoutName ?? layout?.name ?? null;
  const sizeName = input.sizeName ?? size?.name ?? null;
  const sizeDescription = input.sizeDescription ?? size?.description ?? null;
  const displayName = input.displayName?.trim() || layoutName || input.boardName;
  const uuid = `${GUEST_BOARD_UUID_PREFIX}${input.boardName}:${input.layoutId}:${input.sizeId}:${setIds}`;

  return {
    uuid,
    slug: `guest-${slugPart(input.boardName)}-${input.layoutId}-${input.sizeId}-${setIds.replace(/,/g, '-')}`,
    ownerId: '',
    ownerDisplayName: undefined,
    ownerAvatarUrl: undefined,
    boardType: input.boardName,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setIds,
    name: displayName,
    description: null,
    locationName: null,
    latitude: null,
    longitude: null,
    isPublic: true,
    isUnlisted: false,
    hideLocation: true,
    isOwned: false,
    angle: resolveGuestAngle(input.boardName, input.angle),
    isAngleAdjustable: (ANGLES[input.boardName] ?? []).length > 1,
    createdAt: '1970-01-01T00:00:00.000Z',
    layoutName,
    sizeName,
    sizeDescription,
    setNames,
    totalAscents: input.totalAscents ?? 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    gymId: null,
    gymUuid: null,
    gymName: null,
    distanceMeters: null,
    serialNumber: null,
  };
}
