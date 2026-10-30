import { describe, expect, it } from 'vite-plus/test';
import { boardEditPermissions, buildBoardUpdateInput, type EditableBoard } from '../board-edit-input';
import type { BoardFormFieldValues } from '../board-form';

const board: EditableBoard = {
  uuid: 'moonboard-uuid',
  slug: 'bowlo-moonboard',
  ownerId: 'owner',
  boardType: 'moonboard',
  name: 'MoonBoard',
  description: 'The upstairs wall',
  locationName: 'Bowlo',
  latitude: 51,
  longitude: 4,
  isPublic: true,
  isUnlisted: false,
  hideLocation: true,
  isOwned: false,
  angle: 40,
  isAngleAdjustable: false,
  layoutId: 1,
  sizeId: 1,
  setIds: '20,1',
  serialNumber: 'SERIAL',
};

function formFields(source: EditableBoard = board): BoardFormFieldValues {
  return {
    ...source,
    description: source.description ?? '',
    locationName: source.locationName ?? '',
    serialNumber: source.serialNumber ?? '',
    hasLeds: source.hasLeds ?? true,
  };
}

describe('buildBoardUpdateInput', () => {
  it('renames without resubmitting projected locations, credentials, defaults, or reordered sets', () => {
    expect(
      buildBoardUpdateInput(
        board,
        { ...formFields(), name: ' Bowlo MoonBoard ', setIds: '1,20' },
        boardEditPermissions(board, 'admin'),
      ),
    ).toEqual({ boardUuid: board.uuid, name: 'Bowlo MoonBoard' });
  });

  it('clears changed nullable fields explicitly', () => {
    expect(
      buildBoardUpdateInput(
        board,
        {
          ...formFields(),
          description: ' ',
          locationName: '',
          latitude: null,
          longitude: null,
          serialNumber: '',
        },
        boardEditPermissions(board, 'owner'),
      ),
    ).toEqual({
      boardUuid: board.uuid,
      description: null,
      locationName: null,
      latitude: null,
      longitude: null,
      serialNumber: null,
    });
  });

  it('omits owner-only privacy and credentials even when a nonowner supplies changed fields', () => {
    expect(
      buildBoardUpdateInput(
        board,
        {
          ...formFields(),
          name: 'Renamed',
          isPublic: false,
          isUnlisted: true,
          hideLocation: false,
          serialNumber: '',
        },
        boardEditPermissions(board, 'admin'),
      ),
    ).toEqual({ boardUuid: board.uuid, name: 'Renamed' });
  });

  it('accepts permitted owner privacy and catalogue setup edits', () => {
    expect(
      buildBoardUpdateInput(
        board,
        {
          ...formFields(),
          isPublic: false,
          hideLocation: false,
          angle: 25,
          hasLeds: false,
          layoutId: 2,
        },
        boardEditPermissions(board, 'owner'),
      ),
    ).toEqual({
      boardUuid: board.uuid,
      isPublic: false,
      hideLocation: false,
      angle: 25,
      hasLeds: false,
      layoutId: 2,
    });
  });

  it('keeps spray configuration, hardware, angle, credentials, and privacy out of the generic mutation', () => {
    const sprayBoard = { ...board, boardType: 'spray' };
    expect(
      buildBoardUpdateInput(
        sprayBoard,
        {
          ...formFields(sprayBoard),
          name: 'Renamed spray wall',
          layoutId: 99,
          sizeId: 99,
          setIds: '99',
          hasLeds: false,
          isAngleAdjustable: true,
          angle: 25,
          isPublic: false,
          serialNumber: 'OTHER',
        },
        boardEditPermissions(sprayBoard, 'owner'),
      ),
    ).toEqual({ boardUuid: board.uuid, name: 'Renamed spray wall' });
  });

  it('normalizes empty/null/default fields symmetrically and leaves untouched fields omitted', () => {
    const sparseBoard = {
      ...board,
      description: null,
      locationName: undefined,
      latitude: undefined,
      longitude: null,
      serialNumber: null,
    };
    expect(
      buildBoardUpdateInput(sparseBoard, formFields(sparseBoard), boardEditPermissions(sparseBoard, 'owner')),
    ).toEqual({ boardUuid: board.uuid });
  });
});
