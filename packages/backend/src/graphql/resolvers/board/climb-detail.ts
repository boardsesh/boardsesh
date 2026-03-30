import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { getClimbByUuid } from '../../../db/queries/climbs/index';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas';

export const climbDetailQuery = {
  climbDetail: async (
    _: unknown,
    { boardName, layoutId, sizeId, setIds, angle, climbUuid }: {
      boardName: string;
      layoutId: number;
      sizeId: number;
      setIds: string;
      angle: number;
      climbUuid: string;
    },
  ): Promise<Climb | null> => {
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}`);
    }

    if (layoutId <= 0) throw new Error('Invalid layoutId: must be positive');
    if (sizeId <= 0) throw new Error('Invalid sizeId: must be positive');

    const climb = await getClimbByUuid({
      board_name: boardName as BoardName,
      layout_id: layoutId,
      size_id: sizeId,
      angle,
      climb_uuid: climbUuid,
    });

    return climb;
  },
};
