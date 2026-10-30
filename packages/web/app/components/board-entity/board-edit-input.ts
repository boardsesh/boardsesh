import type { UpdateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import type { BoardFormFieldValues } from './board-form';

/** The editing fields shared by ordinary board reads and the admin projection. */
export type EditableBoard = Pick<
  UserBoard,
  | 'uuid'
  | 'slug'
  | 'ownerId'
  | 'boardType'
  | 'name'
  | 'description'
  | 'locationName'
  | 'latitude'
  | 'longitude'
  | 'isPublic'
  | 'isUnlisted'
  | 'hideLocation'
  | 'isOwned'
  | 'angle'
  | 'isAngleAdjustable'
  | 'hasLeds'
  | 'layoutId'
  | 'sizeId'
  | 'setIds'
  | 'serialNumber'
>;

export type BoardEditPermissions = {
  privacy: boolean;
  credentials: boolean;
  setup: boolean;
  angle: boolean;
};

export function boardEditPermissions(board: EditableBoard, viewerUserId: string | null): BoardEditPermissions {
  const isOwner = !!viewerUserId && board.ownerId === viewerUserId;
  const isCatalogueBoard = board.boardType !== 'spray';
  return {
    privacy: isOwner && isCatalogueBoard,
    credentials: isOwner && isCatalogueBoard,
    setup: isCatalogueBoard,
    angle: isCatalogueBoard,
  };
}

function normalizedSets(setIds: string | undefined): string {
  return (setIds ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .sort((first, second) => first - second)
    .join(',');
}

/** Omission preserves redacted or projected fields; null deliberately clears. */
export function buildBoardUpdateInput(
  board: EditableBoard,
  fields: BoardFormFieldValues,
  permissions: BoardEditPermissions,
): UpdateBoardInput {
  const input: UpdateBoardInput = { boardUuid: board.uuid };
  const name = fields.name.trim();
  const slug = fields.slug?.trim();
  const description = fields.description.trim() || null;
  const locationName = fields.locationName.trim() || null;
  if (name !== board.name.trim()) input.name = name;
  if (slug && slug !== board.slug) input.slug = slug;
  if (description !== (board.description?.trim() || null)) input.description = description;
  if (locationName !== (board.locationName?.trim() || null)) input.locationName = locationName;
  if ((fields.latitude ?? null) !== (board.latitude ?? null)) input.latitude = fields.latitude ?? null;
  if ((fields.longitude ?? null) !== (board.longitude ?? null)) input.longitude = fields.longitude ?? null;
  if (fields.isOwned !== board.isOwned) input.isOwned = fields.isOwned;

  if (permissions.privacy) {
    if (fields.isPublic !== board.isPublic) input.isPublic = fields.isPublic;
    if (fields.isUnlisted !== board.isUnlisted) input.isUnlisted = fields.isUnlisted;
    if (fields.hideLocation !== board.hideLocation) input.hideLocation = fields.hideLocation;
  }
  if (permissions.credentials) {
    const serialNumber = fields.serialNumber?.trim() || null;
    if (serialNumber !== (board.serialNumber?.trim() || null)) input.serialNumber = serialNumber;
  }
  if (permissions.angle && fields.angle !== undefined && fields.angle !== board.angle) input.angle = fields.angle;
  if (permissions.setup) {
    if (fields.hasLeds !== undefined && fields.hasLeds !== (board.hasLeds ?? true)) input.hasLeds = fields.hasLeds;
    if (fields.isAngleAdjustable !== undefined && fields.isAngleAdjustable !== board.isAngleAdjustable)
      input.isAngleAdjustable = fields.isAngleAdjustable;
    if (fields.layoutId !== undefined && fields.layoutId !== board.layoutId) input.layoutId = fields.layoutId;
    if (fields.sizeId !== undefined && fields.sizeId !== board.sizeId) input.sizeId = fields.sizeId;
    if (fields.setIds !== undefined && normalizedSets(fields.setIds) !== normalizedSets(board.setIds))
      input.setIds = fields.setIds;
  }
  return input;
}
