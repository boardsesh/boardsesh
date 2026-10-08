// Which climb actions a climber is offered, as a pure function of the climb, its
// board and who is looking. One rule for both menus: `useClimbActions` (the
// reaction overlay) builds its items from it, and the iOS native context menu
// (`ClimbContextMenu`) shows or hides its items from it, so the two can never
// offer different actions for the same climb.

import type { AuroraBoardName, Climb } from '@boardsesh/shared-schema';
import { getBoardCapabilities, toAuroraBoardName } from '@boardsesh/board-config';
import { canEditClimb } from '@boardsesh/create-climb-react';
import { ownClimbIsReportable } from '../play-drawer/can-report-climb';
import { canDeleteClimb } from './delete-climb-rules';

export type ClimbActionId =
  | 'preview'
  | 'queue'
  | 'openQueue'
  | 'playNext'
  | 'playlist'
  | 'favorite'
  | 'tick'
  | 'editEntry'
  | 'betaVideo'
  | 'edit'
  | 'fork'
  | 'share'
  | 'openInApp'
  | 'report'
  | 'delete';

/** Every action, in the order the overlay lists them. */
export const CLIMB_ACTION_ORDER: readonly ClimbActionId[] = [
  'preview',
  'queue',
  'openQueue',
  'playNext',
  'playlist',
  'favorite',
  'tick',
  'editEntry',
  'betaVideo',
  'edit',
  'fork',
  'share',
  'openInApp',
  'report',
  'delete',
];

export type ClimbActionGatingInput = {
  climb: Climb;
  boardName: string;
  /** Signed-in user id — gates the setter-only Edit and Delete, and Report on your own climb. */
  currentUserId?: string | null;
  isAuthenticated: boolean;
  /** The climb-moderation kill switch, read as enabled while unresolved. */
  moderationEnabled: boolean;
  /** The spray wall behind the board is archived: no Edit, Fork or Delete. */
  wallArchived: boolean;
  /** The climb on the wall right now. "Play next" is hidden on it. */
  activeClimbUuid: string | null | undefined;
  /** The caller hosts "Open the queue" (the play drawer, #5654). */
  hasOpenQueue: boolean;
  /** The caller hosts "Edit entry" (the logbook). */
  hasEditEntry: boolean;
};

// Mirrors web's constructClimbInfoUrl: Kilter no longer has a public app URL.
// Aurora-only by construction — the caller gates on the auroraAppLink capability
// and narrows the board name before calling, so a code-driven board (MoonBoard,
// Woods) never reaches this and never gets an invented domain.
function buildAuroraAppUrl(boardName: AuroraBoardName, climbUuid: string): string | null {
  if (boardName === 'kilter') return null;
  const suffix = boardName === 'tension' ? '2' : '';
  return `https://${boardName}boardapp${suffix}.com/climbs/${climbUuid}`;
}

/** The climb's page in the board's official app, or null when the board has none. */
export function auroraAppUrlFor(boardName: string, climbUuid: string): string | null {
  // Only boards with an official app page get the row; the guard is what turns
  // the loose board string into the AuroraBoardName the builder assumes.
  const auroraBoardName = getBoardCapabilities(boardName).auroraAppLink ? toAuroraBoardName(boardName) : null;
  return auroraBoardName ? buildAuroraAppUrl(auroraBoardName, climbUuid) : null;
}

/** Whether the viewer set this climb. Report reads "Change grade" on your own spray climb (#5971). */
export function isOwnClimb(climb: Pick<Climb, 'userId'>, currentUserId: string | null | undefined): boolean {
  return !!currentUserId && climb.userId === currentUserId;
}

/** The actions this climber is offered for this climb, in overlay order. */
export function resolveClimbActionIds({
  climb,
  boardName,
  currentUserId,
  isAuthenticated,
  moderationEnabled,
  wallArchived,
  activeClimbUuid,
  hasOpenQueue,
  hasEditEntry,
}: ClimbActionGatingInput): ClimbActionId[] {
  const capabilities = getBoardCapabilities(boardName);
  // Who may edit is one shared rule (`canEditClimb`): the setter, a draft for
  // good and a published climb for 24 hours, on every board a spray wall
  // included. A hint only; the server decides.
  const canEdit =
    capabilities.climbCreation && !wallArchived && canEditClimb({ climb, boardType: boardName, currentUserId });
  // A draft is visible to its setter alone, so a link to it opens nowhere for
  // anyone it is sent to (#5960). A draft is never reported either.
  const isDraft = climb.is_draft === true;
  // Not on the viewer's own climb: reporting yourself to the crew has no
  // outcome, and the setter already has Edit for anything they want changed.
  // Except on a spray wall, where a grade proposal is how the setter changes
  // their own climb's grade (#5971).
  const reportable = !isDraft && (!isOwnClimb(climb, currentUserId) || ownClimbIsReportable(boardName));

  const offered: Record<ClimbActionId, boolean> = {
    preview: true,
    queue: true,
    openQueue: hasOpenQueue,
    // "Play next" is meaningless on the climb already on the wall, so it is
    // hidden there rather than shown as a no-op.
    playNext: climb.uuid !== activeClimbUuid,
    playlist: true,
    favorite: true,
    tick: true,
    editEntry: hasEditEntry,
    betaVideo: isAuthenticated,
    edit: canEdit,
    // Fork drops into the create-climb editor, so it only appears on boards that
    // can have climbs set on them, and never on an archived wall.
    fork: capabilities.climbCreation && !wallArchived,
    share: !isDraft,
    openInApp: auroraAppUrlFor(boardName, climb.uuid) !== null,
    report: isAuthenticated && moderationEnabled && reportable,
    // The setter's own published spray climb (#5960).
    delete: canDeleteClimb({ climb, boardName, currentUserId, wallArchived }),
  };

  return CLIMB_ACTION_ORDER.filter((id) => offered[id]);
}
