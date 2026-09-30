import type { Climb } from '@boardsesh/shared-schema';
import { describeRequestError } from '../api/graphql-client';
import { useAuth } from '../auth/auth-provider';
import { useBoard } from '../board/board-provider';
import { difficultyIdFromGrade } from '../grades/grades';
import { useSession } from '../session/session-provider';
import { buildTickInput, type TickDetails } from './tick-input';
import { useDeleteTick, useSaveTick } from './use-ticks';

export type LoggedTick = { tickId: string; serverUuid: string; climbUuid: string };
export type LogResult = ({ ok: true } & LoggedTick) | { ok: false; message: string };

/**
 * Save a climb to the Boardsesh logbook and count it in the running session
 * (starting one if needed). Shared by the climb screen and the workout runner.
 */
export function useLogClimb() {
  const { status } = useAuth();
  const { board } = useBoard();
  const session = useSession();
  const saveTick = useSaveTick();
  const deleteTick = useDeleteTick();

  const log = async (climb: Climb, details: TickDetails): Promise<LogResult> => {
    if (status !== 'signedIn') return { ok: false, message: 'Sign in to save climbs to your logbook.' };
    if (!board) return { ok: false, message: 'Set up your board first.' };
    const input = buildTickInput(board, climb, details, new Date());
    try {
      const saved = await saveTick.mutateAsync(input);
      const tickId = session.addTick({
        serverUuid: saved.uuid,
        climbUuid: climb.uuid,
        climbName: climb.name,
        difficultyId: details.difficulty ?? difficultyIdFromGrade(climb.difficulty),
        status: details.status,
        attempts: input.attemptCount,
      });
      return { ok: true, tickId, serverUuid: saved.uuid, climbUuid: climb.uuid };
    } catch (error) {
      return { ok: false, message: describeRequestError(error) };
    }
  };

  /** Take a just-logged tick back out of the logbook and the session. */
  const undo = async (logged: LoggedTick): Promise<boolean> => {
    if (!board) return false;
    try {
      await deleteTick.mutateAsync({
        uuid: logged.serverUuid,
        boardType: board.boardName,
        climbUuid: logged.climbUuid,
      });
      session.removeTick(logged.tickId);
      return true;
    } catch {
      return false;
    }
  };

  return {
    log,
    undo,
    canLog: status === 'signedIn' && board !== null,
    isLogging: saveTick.isPending,
    isUndoing: deleteTick.isPending,
  };
}
