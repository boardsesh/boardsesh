// What the app's gym page shows, decided from the gym, its boards and who is
// looking. Pure, so every viewer-by-listing-state combination is a table in
// the tests rather than a render. The screen maps the kinds below to copy;
// nothing here is a string a climber reads.
//
// Spec: the gym page in the gym governance design (docs/product/gym-board-governance.md).

import type { Gym, GymListingState, MyGymClaim } from '@boardsesh/shared-schema';

/**
 * Who is looking, as the gym page and its analytics see them.
 *
 * - `owner`, `admin`, `editor`: the gym's staff (owner by `ownerId`; the server
 *   reports an owner's `myRole` as `admin`, so ownership is read first).
 * - `moderator`: can edit the gym without being its staff (a community leader
 *   for one of its board types, or our team).
 * - `member`: a social gym role with no powers; sees what a climber sees.
 * - `climber`: anyone else who is signed in.
 * - `signed_out`: no session.
 */
export type GymViewerRole = 'signed_out' | 'climber' | 'member' | 'moderator' | 'editor' | 'admin' | 'owner';

/** The gym's own staff: the people the run-by pill says "you" to. */
export type GymStaffRole = 'owner' | 'admin' | 'editor';

export type GymPageViewer = {
  isAuthenticated: boolean;
  /** The signed-in climber's id; undefined while it resolves or with no session. */
  userId: string | undefined;
  /** False while the auth provider is still restoring the session; `isAuthenticated` is not yet a fact. Defaults to true. */
  authResolved?: boolean;
};

/** The run-by pill under the gym's name. Staff see their own role instead of the listing state. */
export type GymRunByPill = 'runByGym' | 'climberListed' | 'unclaimed' | 'youOwner' | 'youAdmin' | 'youEditor';

/** The one line beside the pill that says who keeps the page up to date. */
export type GymRunByLine =
  | { kind: 'staff' }
  | { kind: 'climber'; name: string | null }
  | { kind: 'unclaimed' }
  | { kind: 'none' };

/**
 * The claim card at the foot of the page.
 * - `claim`: Run this gym? and the Claim this gym button.
 * - `signIn`: the same card for a signed-out viewer; the button logs in first.
 * - `pending`: the viewer's claim is with our team.
 * - `denied`: the viewer came from a "we couldn't confirm" notice; the card says
 *   so and offers the claim again.
 * - `deniedClosed`: the same notice on a gym the viewer can no longer claim
 *   (its staff run it now): the sentence, no button.
 * - `hidden`: staff, a gym already run by its staff, or a private gym.
 */
export type GymClaimCard = 'claim' | 'signIn' | 'pending' | 'denied' | 'deniedClosed' | 'hidden';

/** "Start here" for staff who have just started running the gym. At most three rows. */
export type GymStartRow = 'boards' | 'hours' | 'tv';

/** The staff tools: details and analytics in the app, board and TV management on the website. */
export type GymStaffTool = 'editDetails' | 'nearbyBoards' | 'kiosks' | 'insights';

/** Info rows, each only when the gym has set it. */
export type GymInfoRow = 'hours' | 'website' | 'phone' | 'email';

export type GymPageViewModel = {
  viewerRole: GymViewerRole;
  staffRole: GymStaffRole | null;
  pill: GymRunByPill;
  /** Positive for a gym its staff run (and for staff themselves); neutral otherwise. */
  pillTone: 'positive' | 'neutral';
  runByLine: GymRunByLine;
  /** "Run this gym? Claim it" under the pill. Same rule as the claim card, minus a pending claim. */
  inlineClaim: boolean;
  claimCard: GymClaimCard;
  startHere: readonly GymStartRow[];
  staffTools: readonly GymStaffTool[];
  info: readonly GymInfoRow[];
  /** Follow and Unfollow need an account. */
  canFollow: boolean;
};

/** The gym fields the page decides from. A `Pick` so tests can build one without the whole entity. */
export type GymPageGym = Pick<
  Gym,
  | 'ownerId'
  | 'ownerDisplayName'
  | 'myRole'
  | 'canEdit'
  | 'canClaim'
  | 'isPublic'
  | 'listingState'
  | 'hours'
  | 'website'
  | 'contactPhone'
  | 'contactEmail'
>;

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function gymViewerRole(gym: GymPageGym, viewer: GymPageViewer): GymViewerRole {
  if (!viewer.isAuthenticated) return 'signed_out';
  if (viewer.userId !== undefined && gym.ownerId === viewer.userId) return 'owner';
  if (gym.myRole === 'admin') return 'admin';
  if (gym.myRole === 'editor') return 'editor';
  if (gym.canEdit) return 'moderator';
  if (gym.myRole === 'member') return 'member';
  return 'climber';
}

function staffRoleOf(role: GymViewerRole): GymStaffRole | null {
  return role === 'owner' || role === 'admin' || role === 'editor' ? role : null;
}

const STAFF_PILLS: Record<GymStaffRole, GymRunByPill> = {
  owner: 'youOwner',
  admin: 'youAdmin',
  editor: 'youEditor',
};

const LISTING_PILLS: Record<GymListingState, GymRunByPill> = {
  RUN_BY_GYM: 'runByGym',
  CLIMBER_LISTED: 'climberListed',
  UNCLAIMED: 'unclaimed',
};

function runByLineFor(gym: GymPageGym): GymRunByLine {
  switch (gym.listingState) {
    case 'RUN_BY_GYM':
      return { kind: 'staff' };
    case 'CLIMBER_LISTED':
      // The server sends no name for an owner whose activity the viewer can't see.
      return { kind: 'climber', name: present(gym.ownerDisplayName) ? (gym.ownerDisplayName ?? null) : null };
    case 'UNCLAIMED':
      return { kind: 'unclaimed' };
  }
}

/**
 * The claim card. On a gym its staff run, the claim stays hidden for everyone:
 * an ownership dispute goes through Report a problem. A private gym has no
 * public listing to claim. Signed out, `canClaim` is always false (the server
 * needs an account to answer it), so the card offers a log-in instead.
 */
function claimCardFor(
  gym: GymPageGym,
  viewerRole: GymViewerRole,
  staffRole: GymStaffRole | null,
  pendingClaim: MyGymClaim | null,
  claimDenied: boolean,
): GymClaimCard {
  if (staffRole !== null || viewerRole === 'moderator') return 'hidden';
  if (!gym.isPublic) return 'hidden';
  // The denial notice is the claimant's own: it means nothing signed out.
  if (viewerRole !== 'signed_out') {
    // A claim filed since the denial is the newer fact.
    if (pendingClaim !== null) return gym.listingState === 'RUN_BY_GYM' ? 'hidden' : 'pending';
    if (claimDenied) return gym.canClaim && gym.listingState !== 'RUN_BY_GYM' ? 'denied' : 'deniedClosed';
  }
  if (gym.listingState === 'RUN_BY_GYM') return 'hidden';
  if (viewerRole === 'signed_out') return 'signIn';
  return gym.canClaim ? 'claim' : 'hidden';
}

/**
 * "Start here" is for the gym's own staff until the listing looks set up. The
 * one step the app can see being done is the opening hours, so the group shows
 * while the gym has none, and leaves once they are in. Checking the boards and
 * the TV have no done state the app can read.
 */
function startHereFor(gym: GymPageGym, staffRole: GymStaffRole | null): readonly GymStartRow[] {
  if (staffRole === null || present(gym.hours)) return [];
  return gym.canEdit ? ['boards', 'hours', 'tv'] : ['boards', 'tv'];
}

/**
 * Staff tools for anyone who can edit the gym: its staff, and a community leader
 * or our team. Details and analytics open in the app; board and TV management
 * open the website console.
 */
function staffToolsFor(gym: GymPageGym): readonly GymStaffTool[] {
  return gym.canEdit ? ['editDetails', 'nearbyBoards', 'kiosks', 'insights'] : [];
}

function infoFor(gym: GymPageGym): readonly GymInfoRow[] {
  const rows: GymInfoRow[] = [];
  if (present(gym.hours)) rows.push('hours');
  if (present(gym.website)) rows.push('website');
  if (present(gym.contactPhone)) rows.push('phone');
  if (present(gym.contactEmail)) rows.push('email');
  return rows;
}

export type GymPageViewOptions = {
  /** The page was opened from a `gym_claim_denied` notice (`?claim=denied`). */
  claimDenied?: boolean;
};

export function deriveGymPageViewModel(
  gym: GymPageGym,
  viewer: GymPageViewer,
  pendingClaim: MyGymClaim | null = null,
  options: GymPageViewOptions = {},
): GymPageViewModel {
  const viewerRole = gymViewerRole(gym, viewer);
  const staffRole = staffRoleOf(viewerRole);
  // A session still being restored reads as signed out; don't flash the log-in card.
  const claimCard: GymClaimCard =
    viewer.authResolved === false
      ? 'hidden'
      : claimCardFor(gym, viewerRole, staffRole, pendingClaim, options.claimDenied === true);
  return {
    viewerRole,
    staffRole,
    pill: staffRole !== null ? STAFF_PILLS[staffRole] : LISTING_PILLS[gym.listingState],
    pillTone: staffRole !== null || gym.listingState === 'RUN_BY_GYM' ? 'positive' : 'neutral',
    // Staff are told their own role; the line about who runs the listing would only repeat it.
    runByLine: staffRole !== null ? { kind: 'none' } : runByLineFor(gym),
    inlineClaim: claimCard === 'claim' || claimCard === 'signIn',
    claimCard,
    startHere: startHereFor(gym, staffRole),
    staffTools: staffToolsFor(gym),
    info: infoFor(gym),
    canFollow: viewer.isAuthenticated,
  };
}

/** A row's place in its inset group, for a list that draws each row as its own cell. */
export type GroupedCellPosition = 'only' | 'first' | 'middle' | 'last';

export function groupedCellPosition(index: number, count: number): GroupedCellPosition {
  if (count <= 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

/** Where the boards list stands. `error` keeps the rest of the page up. */
export type GymBoardsState = 'loading' | 'ready' | 'error';

/**
 * One cell of the page's list, top to bottom. Every board is its own cell, so
 * a gym with forty walls scrolls like one with four (the mobile performance
 * checklist: virtualized, never a `.map()` in a ScrollView). The small fixed
 * groups (Start here, staff tools, info) are one cell each.
 */
export type GymPageItem<Board> =
  | { kind: 'top'; key: 'top' }
  | { kind: 'start'; key: 'start'; rows: readonly GymStartRow[] }
  | { kind: 'boardsHeader'; key: 'boardsHeader'; count: number | null }
  | { kind: 'board'; key: string; board: Board; position: GroupedCellPosition }
  | { kind: 'boardsLoading'; key: 'boardsLoading' }
  | { kind: 'boardsError'; key: 'boardsError' }
  | { kind: 'boardsEmpty'; key: 'boardsEmpty' }
  | { kind: 'staff'; key: 'staff'; tools: readonly GymStaffTool[] }
  | { kind: 'info'; key: 'info'; rows: readonly GymInfoRow[] }
  | { kind: 'claim'; key: 'claim'; card: Exclude<GymClaimCard, 'hidden'> }
  | { kind: 'report'; key: 'report' };

export type GymPageItemsInput<Board extends { key: string }> = {
  model: GymPageViewModel;
  boards: readonly Board[];
  boardsState: GymBoardsState;
  /** Whether Report a problem is wired (the hook seam returns an action). */
  canReport: boolean;
};

/** A denial the climber just tapped through to reads first, not under every board. */
function claimCardLeads(card: GymClaimCard): boolean {
  return card === 'denied' || card === 'deniedClosed';
}

/**
 * The page's cells in order: the top block, Start here, Boards, staff tools,
 * info, the claim card, and Report a problem last, in its own group. A claim
 * denial moves the card up under the top block: the climber came for it.
 *
 * Boards already on screen stay on screen through a refetch that fails, so a
 * board list with rows never turns into the error line.
 */
export function buildGymPageItems<Board extends { key: string }>({
  model,
  boards,
  boardsState,
  canReport,
}: GymPageItemsInput<Board>): GymPageItem<Board>[] {
  const items: GymPageItem<Board>[] = [{ kind: 'top', key: 'top' }];
  const claimItem: GymPageItem<Board> | null =
    model.claimCard === 'hidden' ? null : { kind: 'claim', key: 'claim', card: model.claimCard };
  if (claimItem && claimCardLeads(model.claimCard)) items.push(claimItem);
  if (model.startHere.length > 0) items.push({ kind: 'start', key: 'start', rows: model.startHere });

  const showRows = boards.length > 0;
  items.push({
    kind: 'boardsHeader',
    key: 'boardsHeader',
    // Rows from the cached roster are placeholders while 'loading': not the gym's count yet.
    count: boardsState !== 'loading' && (showRows || boardsState === 'ready') ? boards.length : null,
  });
  if (showRows) {
    boards.forEach((board, index) => {
      items.push({
        kind: 'board',
        key: `board:${board.key}`,
        board,
        position: groupedCellPosition(index, boards.length),
      });
    });
  } else if (boardsState === 'loading') {
    items.push({ kind: 'boardsLoading', key: 'boardsLoading' });
  } else if (boardsState === 'error') {
    items.push({ kind: 'boardsError', key: 'boardsError' });
  } else {
    items.push({ kind: 'boardsEmpty', key: 'boardsEmpty' });
  }

  if (model.staffTools.length > 0) items.push({ kind: 'staff', key: 'staff', tools: model.staffTools });
  if (model.info.length > 0) items.push({ kind: 'info', key: 'info', rows: model.info });
  if (claimItem && !claimCardLeads(model.claimCard)) items.push(claimItem);
  if (canReport) items.push({ kind: 'report', key: 'report' });
  return items;
}

/** The index of the Boards header, for Start here's "Check the boards". */
export function boardsHeaderIndex<Board>(items: readonly GymPageItem<Board>[]): number {
  return items.findIndex((item) => item.kind === 'boardsHeader');
}

/** Whether the page should ask for the viewer's own pending claim: only where a claim card could show. */
export function shouldLoadPendingClaim(gym: GymPageGym, viewer: GymPageViewer): boolean {
  if (!viewer.isAuthenticated) return false;
  const role = gymViewerRole(gym, viewer);
  if (staffRoleOf(role) !== null || role === 'moderator') return false;
  return gym.listingState !== 'RUN_BY_GYM' && gym.isPublic;
}

// --- links the page hands to the system ---

const HTTP_URL = /^https?:\/\//i;
/** A host with at least one dot and nothing a URL can't carry, then an optional path. */
const WEB_ADDRESS = /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#][^\s]*)?$/i;

/**
 * The gym's website as a web link. A gym types its own website, often without
 * a scheme ("crux.com"); anything that isn't a plain web address is refused
 * rather than handed to the system. String checks rather than `URL`: React
 * Native's `URL` leaves several getters unimplemented.
 */
export function gymWebsiteUrl(website: string | null | undefined): string | null {
  if (!present(website)) return null;
  const trimmed = (website ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !HTTP_URL.test(trimmed)) return null;
  const candidate = HTTP_URL.test(trimmed) ? trimmed : `https://${trimmed}`;
  return WEB_ADDRESS.test(candidate) ? candidate : null;
}

/** The website as people say it: no scheme, no trailing slash. */
export function gymWebsiteLabel(website: string): string {
  return website
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
}

/** A `tel:` link with only the characters a dialler reads. */
export function gymPhoneUrl(phone: string | null | undefined): string | null {
  if (!present(phone)) return null;
  const dial = (phone ?? '').replace(/[^\d+]/g, '');
  return /\d{3,}/.test(dial) ? `tel:${dial}` : null;
}

/** A `mailto:` link for an address that looks like one. */
export function gymEmailUrl(email: string | null | undefined): string | null {
  if (!present(email)) return null;
  const trimmed = (email ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? `mailto:${trimmed}` : null;
}

/**
 * A maps search for the gym: Apple Maps on iOS, Google Maps elsewhere (its
 * https link opens the app on Android). Coordinates win over the address, which
 * a gym types by hand; the name rides along so the pin is labelled.
 */
export function gymMapsUrl(
  gym: { name: string; address?: string | null; latitude?: number | null; longitude?: number | null },
  platform: 'ios' | 'android' | 'web',
): string | null {
  const hasCoordinates =
    typeof gym.latitude === 'number' &&
    typeof gym.longitude === 'number' &&
    Number.isFinite(gym.latitude) &&
    Number.isFinite(gym.longitude);
  if (!hasCoordinates && !present(gym.address)) return null;
  if (platform === 'ios') {
    const where = hasCoordinates
      ? `ll=${gym.latitude},${gym.longitude}`
      : `address=${encodeURIComponent((gym.address ?? '').trim())}`;
    return `https://maps.apple.com/?q=${encodeURIComponent(gym.name)}&${where}`;
  }
  const query = hasCoordinates ? `${gym.latitude},${gym.longitude}` : `${gym.name}, ${(gym.address ?? '').trim()}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Only the schemes the page builds are ever opened (a gym's own website may still be http). */
export function isGymPageExternalUrl(url: string): boolean {
  return /^(https?:\/\/|tel:|mailto:)/i.test(url);
}
