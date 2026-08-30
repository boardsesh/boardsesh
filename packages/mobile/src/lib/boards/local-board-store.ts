import { getPreference, removePreference, setPreference } from '../preference-store';
import { isLocalBoard, type LocalBoard } from './local-board';

const LOCAL_BOARD_KEY = 'boardsesh_local_board_v1';
const PENDING_LOCAL_BOARD_SETUP_KEY = 'boardsesh_pending_local_board_setup_v1';

export type PendingLocalBoardSetup = {
  version: 1;
  board: LocalBoard;
  phase: 'awaiting-consent' | 'downloading';
};

function isPendingLocalBoardSetup(value: unknown): value is PendingLocalBoardSetup {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PendingLocalBoardSetup>;
  return (
    candidate.version === 1 &&
    (candidate.phase === 'awaiting-consent' || candidate.phase === 'downloading') &&
    isLocalBoard(candidate.board)
  );
}

export async function getLocalBoard(): Promise<LocalBoard | null> {
  const stored = await getPreference<unknown>(LOCAL_BOARD_KEY);
  return isLocalBoard(stored) ? stored : null;
}

export function saveLocalBoard(board: LocalBoard): Promise<void> {
  return setPreference(LOCAL_BOARD_KEY, board);
}

export async function getPendingLocalBoardSetup(): Promise<PendingLocalBoardSetup | null> {
  const stored = await getPreference<unknown>(PENDING_LOCAL_BOARD_SETUP_KEY);
  return isPendingLocalBoardSetup(stored) ? stored : null;
}

export function savePendingLocalBoardSetup(setup: PendingLocalBoardSetup): Promise<void> {
  return setPreference(PENDING_LOCAL_BOARD_SETUP_KEY, setup);
}

export function clearPendingLocalBoardSetup(): Promise<void> {
  return removePreference(PENDING_LOCAL_BOARD_SETUP_KEY);
}
