import { eq, or, sql } from 'drizzle-orm';
import { userBoards } from '../../schema/app/boards';

export function boardMatchesSerial(serial: string) {
  // Tombstones retain controller identity. A reused serial may still match
  // several active walls; callers keep their existing disambiguation rules.
  return or(
    eq(userBoards.serialNumber, serial),
    sql`EXISTS (
    SELECT 1 FROM user_boards merged_source
    WHERE merged_source.merged_into_board_uuid = ${userBoards.uuid}
      AND merged_source.deleted_at IS NOT NULL
      AND merged_source.board_type = ${userBoards.boardType}
      AND merged_source.serial_number = ${serial}
  )`,
  )!;
}
