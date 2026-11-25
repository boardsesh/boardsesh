import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { findUnknownSetupField, parseSetIds, toBoardName, type WallSetup } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName, CreateBoardInput, ExistingWallCheck, UserBoard } from '@boardsesh/shared-schema';
import {
  useCreateBoard,
  useFollowBoard,
  useGym,
  useProfile,
  usePopularBoardConfigs,
  fetchBoardByUuid,
  fetchBoardsBySerialNumbers,
  fetchExistingWallCandidates,
} from '../../src/lib/graphql/hooks';
import { useActivateBoard } from '../../src/lib/boards/use-activate-board';
import {
  extractGraphqlMessage,
  isGraphqlRateLimitedError,
  isExpectedAuthError,
  isBoardLimitError,
  readDuplicateBoardError,
  readExistingWallsError,
  readUnknownBoardConfigError,
  type DuplicateBoardError,
  type ExistingWallErrorCandidate,
} from '../../src/lib/graphql/extract-error-message';
import { track } from '../../src/lib/analytics';
import { useAuth } from '../../src/providers/auth-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { BUILDER_PRESET_PARAM_VALUE } from '../../src/lib/boards/first-board-mode';
import { presetBoardConfig } from '../../src/lib/boards/board-config-preset';
import {
  selectForeignSerialBoards,
  boardConfigMatches,
  extractSerialExistsError,
  serialReuseDisclosure,
} from '../../src/lib/boards/serial-reuse';
import { builderSerialParam } from '../../src/components/board-discovery/add-board-route';
import { isHeardSerialOffered } from '../../src/lib/boards/heard-serial-offer';
import { useBoardBuilder } from '../../src/components/board-discovery/use-board-builder';
import { usePrivacySettings } from '../../src/lib/graphql/hooks/use-privacy';
import { BoardForm, type BoardConfigError } from '../../src/components/board-discovery/BoardForm';
import { BoardDuplicatePromptSheet } from '../../src/components/board-discovery/BoardDuplicatePromptSheet';
import { SerialReuseConfirmSheet } from '../../src/components/board-discovery/SerialReuseConfirmSheet';
import {
  boardTypeLabel,
  formatDefaultBoardName,
  formatGymBoardName,
} from '../../src/components/board-discovery/board-builder-labels';
import {
  ExistingWallsSheet,
  type ExistingWallsSheetShelf,
} from '../../src/components/board-discovery/ExistingWallsSheet';
import { DiscoveryBoardArt } from '../../src/components/board-discovery/DiscoveryBoardArt';
import type { DiscoveryBoardItem } from '../../src/components/board-discovery/BoardDiscoveryCardView';
import { useAddBoardWizardEnabled, useDirectoryReportsEnabled } from '../../src/providers/feature-flags-provider';
import {
  parseWizardEntry,
  parseWizardPath,
  parseWizardTrail,
  trackWizardStepViewed,
  wizardStepPosition,
  wizardWhereHref,
} from '../../src/lib/boards/add-board-wizard';
import { useReportProblemHost } from '../../src/components/report-problem/use-report-problem';
import { canReportBoard } from '../../src/components/report-problem/report-problem-model';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../../src/providers/sheet-presentation-provider';
import { parseBoardKind } from '../../src/lib/boards/board-picker-add-analytics';
import {
  boardFlowTicket,
  builderOpenedFrom,
  claimBoardFlowAbandonment,
  noteBoardFlowSecured,
} from '../../src/lib/boards/board-create-flow';
import { useSteppedBackInWizard } from '../../src/lib/boards/use-stepped-back-in-wizard';
import {
  acknowledgedWallUuids,
  MAX_ACKNOWLEDGED_WALLS,
  wallCandidateItem,
  wallRelation,
  type WallRowCopy,
} from '../../src/lib/boards/wall-candidates';
import {
  arrangeExistingWalls,
  wallDifferenceLine,
  type ExistingWall,
  type ExistingWallShelfKey,
  type WallDifferenceCopy,
} from '../../src/lib/boards/near-miss-walls';

/**
 * The overrides the climber has explicitly granted so far.
 *
 * The two guards are independent and can fire one after the other on the same
 * create: "yes, this really is a second wall that reuses a serial" says nothing
 * about "yes, I really do own two walls with this configuration". Confirming one
 * must never imply the other, so each flag is set only by its own prompt — and
 * both ride along on the retry once granted, otherwise confirming the second
 * guard would re-trip the first.
 */
type CreateOverrides = {
  allowDuplicateSerial?: boolean;
  allowDuplicateConfig?: boolean;
  /**
   * Walls the climber was shown, against their actual setup, and said are not
   * theirs (#8151): only from the "already has" sheet here ("Keep setting up
   * mine"). Non-empty sends CONFIRMED_SEPARATE. The gym's wall list never
   * acknowledges anything: it has no setup to compare, and acknowledging there
   * would weaken the server's check, which blocks a different-sets copy only
   * under REJECT_IF_FOUND.
   */
  acknowledgedWallUuids?: string[];
};

/**
 * The existing-wall recheck the create asks for (#8151). Always sent, whatever
 * the gym-first flag says: the server only checks a create that opts in, and a
 * copy of a gym's wall is just as much a copy from the old flow. With walls
 * acknowledged it's CONFIRMED_SEPARATE, which the server honours only for those
 * walls; otherwise REJECT_IF_FOUND.
 */
function existingWallCheckFor(acknowledged: readonly string[]): {
  existingWallCheck: ExistingWallCheck;
  acknowledgedWallUuids?: string[];
} {
  return acknowledged.length > 0
    ? { existingWallCheck: 'CONFIRMED_SEPARATE', acknowledgedWallUuids: [...acknowledged] }
    : { existingWallCheck: 'REJECT_IF_FOUND' };
}

/**
 * How many named walls the "already has" sheet looks up by uuid: as many as can
 * be acknowledged, so nothing is acknowledged that the climber wasn't shown.
 */
const EXISTING_WALLS_LOOKUP_LIMIT = MAX_ACKNOWLEDGED_WALLS;

/** What the "already has" sheet holds while it's up. */
type ExistingWallsPrompt = {
  /** Every wall the refusal named. */
  named: ExistingWallErrorCandidate[];
  /**
   * The ones looked up and shown, by uuid; null while loading. Only these are
   * acknowledged on "Keep setting up mine": a wall the climber never saw stays
   * unacknowledged, so the server names it again.
   */
  boards: UserBoard[] | null;
  /** Some named wall couldn't be shown: say so and offer Try again. */
  loadFailed: boolean;
  granted: CreateOverrides;
  /** The setup the server compared: the climber's, as it was sent. */
  draft: WallSetup;
  /**
   * The gym's walls on another layout or size (#8151, PR 3): never named by a
   * refusal, since they never block, but often the same wall entered wrong.
   * Looked up with the draft; empty until then, and when that lookup fails.
   * `nearby` is the other listing a wall is on when it isn't this gym's own,
   * so its row says which gym and how far.
   */
  mismatch: MismatchWall[];
};

type MismatchWall = { board: UserBoard; nearby: { gymName: string; distanceMeters: number | null } | null };

/**
 * One setup as a comparable key: board type, layout, size and the sets in
 * order without repeats. A catalogue error stays on screen while the form
 * still holds the setup it was about.
 */
function setupKey(boardType: string, layoutId: number | null, sizeId: number | null, setIds: readonly number[]) {
  const sets = [...new Set(setIds)].sort((first, second) => first - second).join(',');
  return `${boardType}:${layoutId ?? ''}:${sizeId ?? ''}:${sets}`;
}

/** Analytics properties describing a create attempt. Never carries free text or coordinates. */
function describeInput(input: CreateBoardInput, source: 'scratch') {
  return {
    boardType: input.boardType,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setCount: input.setIds.split(',').filter(Boolean).length,
    angle: input.angle,
    isOwned: input.isOwned,
    isPublic: input.isPublic,
    hasLocationName: !!input.locationName,
    hasCoords: input.latitude != null && input.longitude != null,
    hasGym: !!input.gymUuid,
    // The gym being ATTACHED, which is not the `gym_uuid` super property — that
    // one carries the currently ACTIVE board's gym, and the board being created
    // has not become active yet. Uuid only: this function never carries free
    // text, and the gym's name is resolvable from it.
    gymUuid: input.gymUuid ?? undefined,
    source,
  };
}

function classifyCreateFailure(error: unknown): 'rate_limited' | 'auth' | 'board_limit' | 'exception' {
  if (isGraphqlRateLimitedError(error)) return 'rate_limited';
  if (isExpectedAuthError(error)) return 'auth';
  // Ahead of the catch-all so the account cap doesn't disappear into
  // `exception` — it needs its own copy, and retrying will never clear it.
  if (isBoardLimitError(error)) return 'board_limit';
  return 'exception';
}

/**
 * The `serial` param, when it came from the In range slot: it needs the
 * `presetBoardType` it was heard as, and the picker's offer of exactly that
 * serial for exactly that type.
 */
function heardSerialForBuilder(serialValue: string | undefined, boardTypeValue: string | undefined) {
  const serial = builderSerialParam(serialValue);
  const boardType = toBoardName(boardTypeValue);
  if (!serial || !boardType) return undefined;
  return isHeardSerialOffered({ serial, boardType }) ? serial : undefined;
}

export default function CreateBoard() {
  const params = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    /** `'1'` when "My own board" opened the builder: open with a setup chosen. */
    preset?: string;
    /**
     * The board type to open on, when the picker's In range slot heard a board
     * it couldn't name and the climber said it's their own.
     */
    presetBoardType?: string;
    /**
     * With `presetBoardType`: the serial of the one unsaved box of that type
     * the In range slot heard, so the climber doesn't type it. Absent when it
     * heard none, or two or more (`builderSerialForRow`). Filled in only when
     * the picker just offered this serial for this type (heard-serial-offer.ts):
     * a link naming a serial by itself opens with the field empty.
     */
    serial?: string;
    /** `home` or `gym` from the gym-first flow (#8151): analytics, and whether a bare open asks first. */
    kind?: string;
    /** The gym the climber picked on the wall list: prefilled, coordinates and all. */
    gymUuid?: string;
    /** The board type chosen on the wall list. */
    boardType?: string;
    /** The add-a-board wizard's branch (`gym` | `home`), when it opened this. */
    path?: string;
    /** How the wizard was entered; see `AddBoardWizardEntry`. */
    entry?: string;
    /** The wizard steps before this one, for "Step N of M". */
    trail?: string;
  }>();
  const router = useRouter();
  // Decided at mount, like the redirect below: a flag that resolves later never
  // restyles a form the climber is filling in.
  const wizardFlagEnabled = useAddBoardWizardEnabled();
  const [wizardEnabled] = useState(wizardFlagEnabled);
  const kind = parseBoardKind(params.kind);
  const wizardPath = parseWizardPath(params.path);
  // Only a builder the wizard (or the In range slot with the wizard on) opened
  // carries an entry; anything else reports null, as before the wizard.
  const wizardEntry =
    wizardEnabled && (wizardPath !== null || params.entry !== undefined) ? parseWizardEntry(params.entry) : null;
  // "Step 3 of 3": null when the wizard didn't open this, or it is the only screen.
  const [stepPosition] = useState(() =>
    wizardEntry === null ? null : wizardStepPosition('setup', parseWizardTrail(params.trail)),
  );
  // The gym was added on Add your gym, a step that is no longer in the history.
  const [addedGymInWizard] = useState(() => wizardEntry !== null && parseWizardTrail(params.trail).includes('new_gym'));
  const boardReturnTo = resolveBoardReturnTo(params.returnTo);
  // Threaded through the picker from the first-run flow. Creating a board is one
  // of the ways a climber binds their first one, so it has to close out
  // onboarding exactly like picking an existing board does.
  const fromOnboarding = params.source === 'onboarding';
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('boards');
  const { t: tSettings } = useTranslation('settings');
  const confirm = useConfirm();

  const createBoard = useCreateBoard();
  const followBoard = useFollowBoard();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const viewerId = profile?.id ?? null;

  // Every create here starts from scratch: the picker's Popular setups cards,
  // which opened the builder seeded with a config ('popular_seed'), went with
  // the 2026-11 picker redesign.
  const source = 'scratch';

  // "My own board" in the first-board picker (#5654): open with the board
  // type's most used setup already chosen, so the preview renders and Save
  // works from the first frame. When the popular list lands late the builder
  // fills its still-empty cascade then. A type the list does not carry opens
  // with nothing chosen rather than a guess, except MoonBoard, which opens on
  // the 2016 board most of its climbers use (see presetBoardConfig).
  const presetRequested = params.preset === BUILDER_PRESET_PARAM_VALUE;
  const { data: popularConfigs } = usePopularBoardConfigs({ limit: 12 }, { enabled: presetRequested });
  const popularConfigList = popularConfigs?.configs;
  const presetForBoard = useCallback(
    (boardName: BoardName) => presetBoardConfig(boardName, popularConfigList),
    [popularConfigList],
  );
  const { data: privacySettings, refetch: refetchPrivacySettings } = usePrivacySettings();
  // A preset open names its board type with `presetBoardType`; the gym-first
  // wall list with `boardType`. Nothing else names one.
  const initialBoardName = presetRequested
    ? (toBoardName(params.presetBoardType) ?? undefined)
    : (toBoardName(params.boardType) ?? undefined);
  // Read once: the builder only takes its first value, and the offer can expire under an open form.
  const [initialSerialNumber] = useState(() =>
    presetRequested ? heardSerialForBuilder(params.serial, params.presetBoardType) : undefined,
  );
  const builder = useBoardBuilder(null, {
    preset: presetRequested ? presetForBoard : undefined,
    initialBoardName,
    initialSerialNumber,
    privacyEnabled: privacySettings?.enabled,
  });

  // Auto-generated default name, e.g. "Marco's Kilter Original 12×12", from the
  // user's display name + config. Used as the placeholder and the create-time
  // fallback when the user leaves the name blank.
  const selectedSize = useMemo(
    () => builder.sizes.find((size) => size.id === builder.sizeId) ?? null,
    [builder.sizes, builder.sizeId],
  );
  // A board added at a gym from the gym-first flow is named for the gym, not
  // the climber: "Boulder Space MoonBoard 2019".
  const gymForName = kind === 'gym' ? (builder.selectedGym?.name ?? null) : null;
  const defaultName = useMemo(
    () =>
      gymForName
        ? formatGymBoardName({ gymName: gymForName, boardName: builder.boardName, layoutName: builder.rawLayoutName })
        : formatDefaultBoardName({
            userName: profile?.displayName,
            boardName: builder.boardName,
            layoutName: builder.rawLayoutName,
            size: selectedSize,
          }),
    [gymForName, profile?.displayName, builder.boardName, builder.rawLayoutName, selectedSize],
  );

  // The gym the wall list was opened on, prefilled once it loads.
  // `setSelectedGym` copies its coordinates, which the server's 150 m link
  // check needs. Once only: a gym the climber changes in the form stays changed.
  const prefillGymUuid = typeof params.gymUuid === 'string' && params.gymUuid.length > 0 ? params.gymUuid : null;
  const prefillGymQuery = useGym(prefillGymUuid);
  const prefillGym = prefillGymQuery.data;
  const [gymPrefilled, setGymPrefilled] = useState(false);
  // The climber set the gym aside ("Choose another gym") after it turned out
  // to be gone.
  const [prefillCleared, setPrefillCleared] = useState(false);
  // A gym the climber picks in the form wins: it unblocks Save, and a prefill
  // that lands later never overwrites it.
  const gymChosenInForm = builder.selectedGym != null && !gymPrefilled;
  // The server answers a deleted or no-longer-visible gym with null, not an
  // error: a settled null is a gym that isn't there any more.
  const prefillUnavailable =
    prefillGymUuid !== null && !gymPrefilled && prefillGymQuery.isSuccess && prefillGym == null;
  // Until the gym lands, a Save would create a board with no gym at all, so it
  // waits. A failed read says so, with Try again, rather than saving unlinked.
  const prefillPending = prefillGymUuid !== null && !gymPrefilled && !prefillCleared && !gymChosenInForm;
  const prefillFailed = prefillPending && prefillGymQuery.isError;
  const prefillGone = prefillPending && prefillUnavailable;
  const refetchPrefillGym = prefillGymQuery.refetch;
  const retryPrefillGym = useCallback(() => void refetchPrefillGym(), [refetchPrefillGym]);
  const clearPrefillGym = useCallback(() => setPrefillCleared(true), []);
  const { setSelectedGym } = builder;
  useEffect(() => {
    if (!prefillGym || gymPrefilled || prefillCleared || gymChosenInForm) return;
    setGymPrefilled(true);
    setSelectedGym({
      uuid: prefillGym.uuid,
      name: prefillGym.name,
      latitude: prefillGym.latitude,
      longitude: prefillGym.longitude,
    });
  }, [prefillGym, gymPrefilled, prefillCleared, gymChosenInForm, setSelectedGym]);

  // A bare open of the builder (a deep link, an old entry) starts the add-a-board
  // wizard while its flag is on. Decided at mount only: a flag that resolves
  // later must never yank a form out from under the climber.
  const [redirectToWizard] = useState(
    () =>
      wizardEnabled &&
      kind === null &&
      !presetRequested &&
      prefillGymUuid === null &&
      params.presetBoardType === undefined &&
      params.boardType === undefined,
  );
  useEffect(() => {
    if (!redirectToWizard) return;
    router.replace(wizardWhereHref({ returnTo: params.returnTo, source: params.source, entry: 'link' }));
    // Once, at mount: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `Add Board Wizard Step Viewed` for Set up, when the wizard opened it.
  useEffect(() => {
    if (redirectToWizard || wizardEntry === null) return;
    trackWizardStepViewed({ step: 'setup', path: wizardPath ?? kind, entry: wizardEntry });
    // Once per screen: the route's params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The duplicate-CONFIG prompt: the caller already owns this configuration at
  // this place. `granted` carries any override already confirmed on the attempt
  // that raised it, so answering this one doesn't discard the other.
  const [duplicate, setDuplicate] = useState<{ error: DuplicateBoardError; granted: CreateOverrides } | null>(null);
  // The duplicate-SERIAL prompt: another climber's wall already carries this
  // serial with the same config. A null board means that wall is private (the
  // backend masks its identity) — the sheet still offers "create anyway", just
  // without a jump.
  const [serialReuse, setSerialReuse] = useState<{
    board: UserBoard | null;
    input: CreateBoardInput;
    granted: CreateOverrides;
  } | null>(null);
  // The "already has" sheet (#8151): the gym the board lands on already has
  // this wall. One refusal's sheet at a time, like the two above.
  const [existingWalls, setExistingWalls] = useState<ExistingWallsPrompt | null>(null);
  const existingWallsSheetRef = useRef<ManagedSheetHandle>(null);
  // A setup the catalogue doesn't list (#8151): the app's own check or the
  // server's refusal, drawn under its row while the form still holds it.
  const [configError, setConfigError] = useState<(BoardConfigError & { setupKey: string }) | null>(null);
  // `submitting` is only accurate on the NEXT render, so it can't guard a call
  // that fires in the same tick as the state update — which is exactly what
  // "add a new board here" does (dismiss the sheet, then create). This ref is
  // set synchronously and is the real in-flight lock.
  const inFlightRef = useRef(false);

  // `Board Builder Abandoned` (#5654): of the newcomers who reached Climbs and
  // never opened a climb, 41% opened the builder and 10% created a board, with
  // nothing to say where the rest stopped. Fired when the
  // screen goes away without a board: back, swipe, or the picker dismissed
  // under it. `boardSecuredRef` is set the moment a board exists or is chosen
  // (created, reused, or followed), before the bind navigates, so a success
  // never reads as a quit. The snapshot is refreshed after every render so the
  // unmount reports what was on screen at the end, not at the start.
  const boardSecuredRef = useRef(false);
  const undoSecuredRef = useRef<(() => void) | null>(null);
  const markBoardSecured = useCallback(() => {
    boardSecuredRef.current = true;
    undoSecuredRef.current = noteBoardFlowSecured();
  }, []);
  // A bind that failed after `markBoardSecured`: the climber is still here,
  // and leaving now is an abandonment like any other.
  const unmarkBoardSecured = useCallback(() => {
    boardSecuredRef.current = false;
    undoSecuredRef.current?.();
    undoSecuredRef.current = null;
  }, []);
  const submitAttemptedRef = useRef(false);
  const builderSnapshotRef = useRef({ boardType: builder.boardName, hadLayout: false, hadSize: false });
  useEffect(() => {
    builderSnapshotRef.current = {
      boardType: builder.boardName,
      hadLayout: builder.layoutId != null,
      hadSize: builder.sizeId != null,
    };
  });
  const openedFrom = builderOpenedFrom(params.source);
  // Back to the wizard's step under Set up is not leaving the flow, so from the
  // wizard the report waits a tick to hear whether it was (a step back says
  // nothing). Outside the wizard it goes out on unmount, as before.
  const reportUnlessSteppedBack = useSteppedBackInWizard();
  useEffect(() => {
    const openedAtMs = Date.now();
    const ticket = boardFlowTicket();
    return () => {
      // Handed straight on to the wizard's "Where's the board?": that screen is the one
      // the climber sees, and reports for itself.
      if (redirectToWizard) return;
      const secondsOpen = Math.round((Date.now() - openedAtMs) / 1000);
      const snapshot = builderSnapshotRef.current;
      const report = () => {
        if (boardSecuredRef.current) return;
        if (!claimBoardFlowAbandonment(ticket)) return;
        track(SHARED_EVENTS.BoardBuilderAbandoned, {
          ...snapshot,
          source,
          preset: presetRequested,
          openedFrom,
          submitAttempted: submitAttemptedRef.current,
          secondsOpen,
          kind,
          step: 'form',
          wizardPath,
          wizardEntry,
        });
      };
      if (wizardEntry === null) report();
      else reportUnlessSteppedBack(report);
    };
    // Once per screen: the route's params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A board the climber just built is theirs by construction, so there is
  // nothing to adopt — `isLocalOnly` skips the follow-and-download pass.
  //
  // `rethrow` is load-bearing: every caller below has submit state to unwind and
  // renders its failure inline (a toast is invisible behind this modal route), so
  // a swallowed write failure would leave the CTA spinning with nothing to
  // explain it. `haptic: false` because the submit tap already buzzed.
  const finish = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly: true,
    writeFailure: 'rethrow',
    haptic: false,
  });

  // "Use it and fix its setup" (#8151): the wall is bound like any pick, then,
  // before the builder leaves, the report sheet opens on "Set up wrong" with
  // the climber's setup in it. The builder leaves once that sheet (or the claim
  // sheet it hands over to) has closed, sent or not. The board is already the
  // active one, so a fix that applies reaches it there, and the report's own
  // "Climb it now" stays hidden.
  const reportHost = useReportProblemHost();
  const { openReport } = reportHost;
  const directoryReportsEnabled = useDirectoryReportsEnabled();
  const fixDraftRef = useRef<WallSetup | null>(null);
  const openFixReport = useCallback(
    (board: UserBoard) =>
      new Promise<void>((resolve) => {
        const draft = fixDraftRef.current;
        openReport(
          { kind: 'board', board },
          {
            initialReason: 'wrong_setup',
            initialSetup: draft ? { layoutId: draft.layoutId, sizeId: draft.sizeId, setIds: draft.setIds } : undefined,
            climbNowOffered: false,
            onClosed: resolve,
          },
        );
      }),
    [openReport],
  );
  const finishAfterFix = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly: true,
    writeFailure: 'rethrow',
    haptic: false,
    onBound: openFixReport,
  });

  /**
   * Look up the walls a BOARD_EXISTING_WALLS refusal named, for its sheet. By
   * uuid, because the gym may be one the server attached from a typed location,
   * which the app never learned; each lookup applies the board read rules. A
   * wall the climber can't see is left out, and a failure leaves only the
   * count, never "no walls": Keep setting up mine still works either way.
   */
  const loadExistingWalls = useCallback(
    async (named: ExistingWallErrorCandidate[], draft: WallSetup, knownGymUuid: string | null) => {
      const boardType = draft.boardType;
      const lookups = await Promise.allSettled(
        named.slice(0, EXISTING_WALLS_LOOKUP_LIMIT).map((wall) => fetchBoardByUuid(wall.boardUuid)),
      );
      const boards = lookups.flatMap((lookup) => (lookup.status === 'fulfilled' && lookup.value ? [lookup.value] : []));
      // Any wall named and not shown is a failure, not "fewer walls": a partial
      // answer must never read as the whole one.
      const loadFailed = boards.length < named.length;
      setExistingWalls((current) =>
        current && current.named === named ? { ...current, boards, loadFailed } : current,
      );
      // The gym's walls on another layout or size never block, so the refusal
      // never names them: ask for them with the draft. Advisory, so a failure
      // just leaves that shelf out. The gym is the one the board was sent with,
      // or else the one a named wall is on (the server may have attached it).
      // A wall on a listing within 150 m stays, with that listing's name on its
      // row: a second listing of the same gym is exactly where copies hide.
      const namedUuids = new Set(named.map((wall) => wall.boardUuid));
      const gymUuid = knownGymUuid ?? boards.find((board) => board.gymUuid)?.gymUuid ?? null;
      let mismatchLookup: 'ok' | 'failed' | 'none' = 'none';
      let mismatchCount = 0;
      if (gymUuid) {
        try {
          const { candidates } = await fetchExistingWallCandidates({
            boardType,
            gymUuid,
            layoutId: draft.layoutId,
            sizeId: draft.sizeId,
            setIds: draft.setIds,
          });
          const mismatch: MismatchWall[] = candidates
            .filter(
              (candidate) => candidate.matchKind === 'LAYOUT_OR_SIZE_DIFFERS' && !namedUuids.has(candidate.board.uuid),
            )
            .map((candidate) => ({
              board: candidate.board,
              nearby:
                candidate.source === 'NEARBY_LISTING'
                  ? { gymName: candidate.gymName, distanceMeters: candidate.gymDistanceMeters ?? null }
                  : null,
            }));
          mismatchLookup = 'ok';
          mismatchCount = mismatch.length;
          setExistingWalls((current) => (current && current.named === named ? { ...current, mismatch } : current));
        } catch {
          // Advisory only: the walls that block are already on the sheet.
          mismatchLookup = 'failed';
        }
      }
      // Once both lookups have settled, so the counts are what the sheet shows.
      track(SHARED_EVENTS.BoardWallCandidatesShown, {
        boardType,
        exactCount: named.filter((wall) => wall.matchKind === 'EXACT').length,
        nearMissCount: named.filter(
          (wall) => wall.matchKind === 'SETS_DIFFER' || wall.matchKind === 'LAYOUT_OR_SIZE_DIFFERS',
        ).length,
        mismatchCount,
        mismatchLookup,
        nearbyCount: 0,
        otherTypeCount: 0,
        atGymCount: named.filter((wall) => wall.matchKind === null).length,
        lookup: boards.length === 0 && named.length > 0 ? 'failed' : 'ok',
        trigger: 'pre_submit',
      });
    },
    [],
  );

  /**
   * Always calls the server. The old short-circuit — activate an owned board
   * whose config matched and skip the mutation — is what made #4166 look like a
   * success while silently discarding the form, so there is deliberately no
   * client-side path that can complete a create without a server round trip.
   * The server decides whether this is a duplicate, and the user decides what to
   * do about it.
   */
  const handleCreate = useCallback(
    async (overrides?: CreateOverrides) => {
      if (inFlightRef.current || prefillPending) return;
      const input = builder.buildCreateInput(defaultName);
      if (!input) return;
      // A setup the bundled catalogue doesn't list can't be drawn or toggled
      // here, and the server would refuse it: say so on its row and keep the
      // form. Every row the builder offers comes from that catalogue, so only
      // a preset or a seed can get here.
      const inputSetIds = parseSetIds(input.setIds);
      const inputBoardName = toBoardName(input.boardType);
      const unknownSetup = inputBoardName
        ? findUnknownSetupField(inputBoardName, {
            layoutId: input.layoutId,
            sizeId: input.sizeId,
            setIds: inputSetIds,
          })
        : null;
      if (unknownSetup) {
        submitAttemptedRef.current = true;
        setCreateError(null);
        setConfigError({
          ...unknownSetup,
          setupKey: setupKey(input.boardType, input.layoutId, input.sizeId, inputSetIds),
        });
        track(SHARED_EVENTS.BoardCreateFailed, { boardType: input.boardType, source, error_reason: 'unknown_config' });
        return;
      }
      // The first Save is always REJECT_IF_FOUND against the real setup; only
      // the "already has" sheet below acknowledges walls.
      const acknowledged = overrides?.acknowledgedWallUuids ?? [];
      const granted: CreateOverrides = {
        allowDuplicateSerial: overrides?.allowDuplicateSerial || undefined,
        allowDuplicateConfig: overrides?.allowDuplicateConfig || undefined,
        acknowledgedWallUuids: acknowledged.length > 0 ? acknowledged : undefined,
      };
      const wallCheck = existingWallCheckFor(acknowledged);
      inFlightRef.current = true;
      submitAttemptedRef.current = true;
      setSubmitting(true);
      setCreateError(null);
      setConfigError(null);
      hapticSelection();

      try {
        const currentPrivacySettings = privacySettings ?? (await refetchPrivacySettings()).data;
        if (!currentPrivacySettings) throw new Error(t('mobile.create.createError'));
        const publicBoard = input.audience
          ? input.audience === 'public'
          : input.isPublic !== false && input.isUnlisted !== true;
        if (
          currentPrivacySettings.isPrivate &&
          publicBoard &&
          !(await confirm({
            title: tSettings('privacy.publishPublicTitle'),
            message: tSettings('privacy.publishResourceMessage'),
            confirmLabel: tSettings('privacy.publishPublic'),
            cancelLabel: tSettings('privacy.cancel'),
          }))
        ) {
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }

        // Pre-submit serial-reuse check: if another climber's wall already carries
        // this serial WITH THE SAME CONFIG, steer the user onto it before creating
        // a duplicate. A different-config match is legitimate reuse the backend
        // allows — prompting there would send the user to an unrelated wall. A
        // lookup failure is non-blocking — fall through to the normal create.
        const serial = granted.allowDuplicateSerial ? null : input.serialNumber?.trim();
        if (serial) {
          const config = {
            boardType: input.boardType,
            layoutId: input.layoutId,
            sizeId: input.sizeId,
            setIds: input.setIds,
          };
          const sameConfigBoard = await fetchBoardsBySerialNumbers([serial])
            .then(
              (boards) =>
                selectForeignSerialBoards(boards, config).find((board) => boardConfigMatches(board, config)) ?? null,
            )
            .catch(() => null);
          if (sameConfigBoard) {
            // Authenticated serial lookup intentionally returns private matches so
            // the create guard can identify a collision. Do not carry that private
            // entity into UI state: its name, location, and owner are not ours to
            // reveal, and the identity-free sheet must not offer a jump to it.
            const disclosure = serialReuseDisclosure(sameConfigBoard);
            setSerialReuse({ board: disclosure.kind === 'public' ? disclosure.board : null, input, granted });
            inFlightRef.current = false;
            setSubmitting(false);
            return;
          }
        }

        const board = await createBoard.mutateAsync({
          ...input,
          allowDuplicateSerial: granted.allowDuplicateSerial,
          allowDuplicateConfig: granted.allowDuplicateConfig,
          ...wallCheck,
        });
        markBoardSecured();
        track(SHARED_EVENTS.BoardCreated, {
          ...describeInput(input, source),
          allowedDuplicate: !!granted.allowDuplicateConfig,
          allowedDuplicateSerial: !!granted.allowDuplicateSerial,
          preset: presetRequested,
          presetKept: builder.presetKept,
          kind,
          candidateCount: acknowledged.length,
          confirmedDistinct: wallCheck.existingWallCheck === 'CONFIRMED_SEPARATE',
          wizardPath,
          wizardEntry,
        });
        await finish(board);
        // Navigated away on success — no need to clear `submitting` (unmounting).
      } catch (error) {
        // The backend's serial guard, raced past the pre-submit check above (or
        // reached with no serial lookup at all). Independent of the config guard
        // below: whichever the server raised is the one we prompt for.
        const serialExists = granted.allowDuplicateSerial ? null : extractSerialExistsError(error);
        if (serialExists) {
          // A failed re-fetch (transient network, or the board vanished in a
          // race) must not dead-end the user — fall back to the identity-less
          // sheet, same as the private path, so "create anyway" stays reachable.
          const existing =
            serialExists.kind === 'private' ? null : await fetchBoardByUuid(serialExists.boardUuid).catch(() => null);
          const disclosure = existing ? serialReuseDisclosure(existing) : null;
          setSerialReuse({ board: disclosure?.kind === 'public' ? disclosure.board : null, input, granted });
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        // The gym the board lands on already has this wall (#8151). The
        // refusal names walls by uuid only; look them up so the sheet can show
        // what the climber is allowed to see of them. The form stays as it is.
        // An empty list names nothing to show or acknowledge: resending would
        // only be refused again, so it falls through to the plain failure.
        const namedWalls = readExistingWallsError(error);
        if (namedWalls && namedWalls.length > 0) {
          const draft: WallSetup = {
            boardType: input.boardType,
            layoutId: input.layoutId,
            sizeId: input.sizeId,
            setIds: input.setIds,
          };
          setExistingWalls({ named: namedWalls, boards: null, loadFailed: false, granted, draft, mismatch: [] });
          inFlightRef.current = false;
          setSubmitting(false);
          void loadExistingWalls(namedWalls, draft, input.gymUuid ?? null);
          return;
        }
        // The catalogue refused the setup. With the field named, the error goes
        // on that row and the form stays; an older server names none, which
        // gets a line of our own rather than its English message.
        const unknownConfig = readUnknownBoardConfigError(error);
        if (unknownConfig) {
          track(SHARED_EVENTS.BoardCreateFailed, {
            boardType: input.boardType,
            source,
            error_reason: 'unknown_config',
          });
          if (unknownConfig.field) {
            setConfigError({
              field: unknownConfig.field,
              invalidSetIds: unknownConfig.invalidSetIds,
              setupKey: setupKey(input.boardType, input.layoutId, input.sizeId, inputSetIds),
            });
          } else {
            setCreateError(t('mobile.create.configError.noField'));
          }
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        const duplicateError = readDuplicateBoardError(error);
        if (duplicateError) {
          track(SHARED_EVENTS.BoardDuplicatePrompted, {
            boardType: input.boardType,
            source,
            hasLocation: !!input.locationName || (input.latitude != null && input.longitude != null),
          });
          setDuplicate({ error: duplicateError, granted });
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        const reason = classifyCreateFailure(error);
        track(SHARED_EVENTS.BoardCreateFailed, {
          boardType: input.boardType,
          source,
          error_reason: reason,
        });
        // Inline, never a toast: this screen is a `presentation: 'modal'` route
        // and the toast overlay renders behind it, so a toast here is invisible.
        // The cap gets our own copy rather than the server's message: what the
        // climber needs is the way out (delete one you don't use), not the number.
        setCreateError(
          reason === 'board_limit'
            ? t('mobile.create.limitReached')
            : (extractGraphqlMessage(error) ?? t('mobile.create.createError')),
        );
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [
      builder,
      defaultName,
      createBoard,
      finish,
      source,
      presetRequested,
      t,
      tSettings,
      confirm,
      privacySettings,
      refetchPrivacySettings,
      prefillPending,
      kind,
      markBoardSecured,
      loadExistingWalls,
    ],
  );

  const handleUseExistingDuplicate = useCallback(async () => {
    if (!duplicate || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const board = await fetchBoardByUuid(duplicate.error.boardUuid);
      if (!board) throw new Error('Board not found');
      track(SHARED_EVENTS.BoardCreateReusedExisting, {
        boardType: builder.boardName,
        source,
        preset: presetRequested,
        presetKept: builder.presetKept,
      });
      markBoardSecured();
      setDuplicate(null);
      await finish(board);
    } catch {
      setDuplicate(null);
      setCreateError(t('mobile.create.duplicate.switchError'));
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, [duplicate, builder.boardName, builder.presetKept, source, presetRequested, finish, t, markBoardSecured]);

  const handleAddAnother = useCallback(() => {
    const granted = duplicate?.granted;
    setDuplicate(null);
    void handleCreate({ ...granted, allowDuplicateConfig: true });
  }, [duplicate, handleCreate]);

  const handleDismissDuplicate = useCallback(() => {
    setDuplicate(null);
    inFlightRef.current = false;
    setSubmitting(false);
  }, []);

  /**
   * "Use the existing board" on the serial sheet: follow it so it joins the
   * user's board list, then activate and leave. A failed follow must not
   * activate a board the user still cannot reach later.
   */
  const handleUseExistingSerial = useCallback(async () => {
    // No board to jump to when the conflicting wall is private (masked payload)
    // — the sheet hides the "use existing" action in that case.
    if (!serialReuse?.board || inFlightRef.current) return;
    const { board } = serialReuse;
    setSerialReuse(null);
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      await followBoard.mutateAsync(board);
      markBoardSecured();
      await finish(board);
    } catch {
      setCreateError(t('mobile.create.createError'));
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, [serialReuse, followBoard, finish, t, markBoardSecured]);

  const handleCreateAnyway = useCallback(() => {
    if (!serialReuse) return;
    const { granted } = serialReuse;
    setSerialReuse(null);
    void handleCreate({ ...granted, allowDuplicateSerial: true });
  }, [serialReuse, handleCreate]);

  const handleCancelSerialReuse = useCallback(() => {
    setSerialReuse(null);
    inFlightRef.current = false;
    setSubmitting(false);
  }, []);

  const wallRowCopy = useMemo<WallRowCopy>(
    () => ({
      adjustable: t('mobile.findWall.adjustable'),
      stats: ({ climbers, sends }) => t('mobile.findWall.stats', { climbers, sends }),
      addedBy: (name) => t('mobile.findWall.addedBy', { name }),
      nearbyGym: (gym, distance) => t('mobile.findWall.nearbyGym', { gym, distance }),
      yourBoard: t('mobile.findWall.yourBoard'),
      following: t('mobile.findWall.following'),
    }),
    [t],
  );
  const differenceCopy = useMemo<WallDifferenceCopy>(
    () => ({
      layout: (wall, yours) => t('mobile.create.existingWalls.layoutDiffers', { wall, yours }),
      size: (wall, yours) => t('mobile.create.existingWalls.sizeDiffers', { wall, yours }),
      missing: (sets) => t('mobile.create.existingWalls.missingSets', { sets }),
      extra: (sets) => t('mobile.create.existingWalls.extraSets', { sets }),
    }),
    [t],
  );
  // The walls on their shelves: same setup, set up differently, then a
  // possible setup mismatch. A near-miss row leads with what differs.
  const arrangedWalls = useMemo(() => {
    if (!existingWalls?.boards) return [];
    const matchKinds = new Map(existingWalls.named.map((wall) => [wall.boardUuid, wall.matchKind]));
    const named = existingWalls.boards.map((board) => ({ board, matchKind: matchKinds.get(board.uuid) ?? null }));
    return arrangeExistingWalls(
      existingWalls.draft,
      named,
      existingWalls.mismatch.map((wall) => wall.board),
    );
  }, [existingWalls?.boards, existingWalls?.named, existingWalls?.draft, existingWalls?.mismatch]);
  const nearbyListings = useMemo(
    () => new Map((existingWalls?.mismatch ?? []).map((wall) => [wall.board.uuid, wall.nearby])),
    [existingWalls?.mismatch],
  );
  const existingWallsByKey = useMemo(() => {
    const byKey = new Map<string, ExistingWall>();
    for (const shelf of arrangedWalls) for (const wall of shelf.walls) byKey.set(wall.board.uuid, wall);
    return byKey;
  }, [arrangedWalls]);
  const existingWallShelves = useMemo<ExistingWallsSheetShelf[]>(
    () =>
      arrangedWalls.map((shelf) => ({
        key: shelf.key,
        items: shelf.walls.flatMap(({ board, difference }) => {
          const item = wallCandidateItem(board, {
            copy: wallRowCopy,
            viewerId,
            nearby: nearbyListings.get(board.uuid) ?? null,
          });
          if (!item) return [];
          if (!difference) return [item];
          return [
            { ...item, detailLines: [wallDifferenceLine(difference, differenceCopy), ...(item.detailLines ?? [])] },
          ];
        }),
      })),
    [arrangedWalls, wallRowCopy, differenceCopy, viewerId, nearbyListings],
  );
  // The title counts the walls on the sheet once they're in; the refusal's
  // count until then.
  const shownWallCount = existingWallShelves.reduce((total, shelf) => total + shelf.items.length, 0);
  // "Use it and fix its setup" goes through Report a problem, so it is offered
  // on the walls a report is: not the climber's own, nor one they can edit.
  const fixableWallKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, wall] of existingWallsByKey) {
      if (canReportBoard(wall.board, { enabled: directoryReportsEnabled, viewerUserId: viewerId })) keys.add(key);
    }
    return keys;
  }, [existingWallsByKey, directoryReportsEnabled, viewerId]);

  /**
   * Take a wall from the "already has" sheet: follow it unless it's already
   * the climber's, then make it active and leave. Nothing is created. A failed
   * follow must not activate a wall the climber can't reach later.
   *
   * With `fixSetup`, this sheet goes and settles first (two native sheets
   * can't overlap a present with a dismiss), then the bind opens the report
   * sheet on the climber's setup and leaves once it has closed.
   */
  const takeExistingWall = useCallback(
    async (item: DiscoveryBoardItem, position: number, shelf: ExistingWallShelfKey, fixSetup: boolean) => {
      if (!existingWalls || inFlightRef.current) return;
      const wall = existingWallsByKey.get(item.key);
      if (!wall) return;
      const { board } = wall;
      inFlightRef.current = true;
      setSubmitting(true);
      try {
        const relation = wallRelation(board, viewerId);
        if (relation === null) await followBoard.mutateAsync(board);
        track(SHARED_EVENTS.BoardWallCandidateUsed, {
          match: shelf === 'same_setup' ? 'exact' : 'near_miss',
          position,
          alreadyFollowed: relation !== null,
          fixSetupStarted: fixSetup,
          trigger: 'pre_submit',
        });
        // Abandonment is judged on unmount, which the bind's navigation
        // triggers: mark the board secured just before it, after the follow,
        // and undo that if the bind itself fails so the quit is still counted.
        markBoardSecured();
        if (fixSetup) {
          fixDraftRef.current = existingWalls.draft;
          await dismissManagedSheetAndWait(existingWallsSheetRef.current);
        }
        setExistingWalls(null);
        try {
          await (fixSetup ? finishAfterFix(board) : finish(board));
        } catch (bindError) {
          unmarkBoardSecured();
          throw bindError;
        }
      } catch {
        setExistingWalls(null);
        setCreateError(t('mobile.findWall.useError'));
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [
      existingWalls,
      existingWallsByKey,
      viewerId,
      followBoard,
      markBoardSecured,
      unmarkBoardSecured,
      finish,
      finishAfterFix,
      t,
    ],
  );
  const handleUseExistingWall = useCallback(
    (item: DiscoveryBoardItem, position: number, shelf: ExistingWallShelfKey) =>
      void takeExistingWall(item, position, shelf, false),
    [takeExistingWall],
  );
  const handleFixExistingWall = useCallback(
    (item: DiscoveryBoardItem, position: number, shelf: ExistingWallShelfKey) =>
      void takeExistingWall(item, position, shelf, true),
    [takeExistingWall],
  );

  /** "Keep setting up mine": resend, acknowledging every wall the refusal named. */
  const handleKeepMine = useCallback(() => {
    if (!existingWalls) return;
    const { granted, boards } = existingWalls;
    if (!boards || boards.length === 0) return;
    setExistingWalls(null);
    // The walls just shown go first, so the server's 40-wall cap drops older
    // acknowledgements rather than these: otherwise a gym with more than 40
    // could refuse the same walls forever.
    void handleCreate({
      ...granted,
      acknowledgedWallUuids: acknowledgedWallUuids([
        ...boards.map((board) => board.uuid),
        ...(granted.acknowledgedWallUuids ?? []),
      ]),
    });
  }, [existingWalls, handleCreate]);

  /** Try again on the sheet: look the named walls up afresh. */
  const handleRetryExistingWalls = useCallback(() => {
    if (!existingWalls) return;
    const { named } = existingWalls;
    setExistingWalls({ ...existingWalls, boards: null, loadFailed: false });
    void loadExistingWalls(named, existingWalls.draft, builder.selectedGym?.uuid ?? null);
  }, [existingWalls, loadExistingWalls, builder.selectedGym?.uuid]);

  const handleDismissExistingWalls = useCallback(() => {
    if (inFlightRef.current) return;
    setExistingWalls(null);
  }, []);

  // The catalogue error, while the form still holds the setup it was about.
  const currentSetupKey = setupKey(builder.boardName, builder.layoutId, builder.sizeId, builder.setIds);
  const shownConfigError: BoardConfigError | null =
    configError && configError.setupKey === currentSetupKey
      ? { field: configError.field, invalidSetIds: configError.invalidSetIds }
      : null;

  // Handing straight on to the wizard: draw nothing in between.
  if (redirectToWizard) return null;

  return (
    <>
      <BoardForm
        builder={builder}
        defaultName={defaultName}
        submitting={submitting}
        errorMessage={
          createError ??
          (prefillGone ? t('mobile.create.gymUnavailable') : prefillFailed ? t('mobile.findWall.gymFailed') : null)
        }
        onSubmit={() => void handleCreate()}
        submitLabel={t('mobile.create.save')}
        submitBlocked={prefillPending}
        errorAction={
          createError
            ? undefined
            : prefillGone
              ? { label: t('mobile.create.chooseAnotherGym'), onPress: clearPrefillGym, opensGymPicker: true }
              : prefillFailed
                ? { label: t('mobile.findWall.retry'), onPress: retryPrefillGym }
                : undefined
        }
        configError={shownConfigError}
        setupStyle={wizardEnabled ? 'rows' : 'chips'}
        // The gym the wizard's earlier step picked stays put; one that turned
        // out to be gone unlocks with "Choose another gym".
        gymLocked={wizardEnabled && kind === 'gym' && prefillGymUuid !== null && gymPrefilled}
        // From a gym page there is no earlier step to go back to; a gym the
        // climber just added is theirs, and Back leads to Which gym?.
        gymLockedHint={
          wizardEntry === 'gym_page'
            ? t('mobile.addWizard.gymLockedHintGymPage')
            : addedGymInWizard
              ? t('mobile.addWizard.gymLockedHintNewGym')
              : undefined
        }
        stepLabel={stepPosition ? t('mobile.addWizard.stepCounter', stepPosition) : null}
      />
      {existingWalls && (
        <ExistingWallsSheet
          gymName={builder.selectedGym?.name ?? existingWalls.boards?.[0]?.gymName ?? null}
          boardLabel={boardTypeLabel(builder.boardName)}
          wallCount={shownWallCount > 0 ? shownWallCount : existingWalls.named.length}
          shelves={existingWallShelves}
          fixableKeys={fixableWallKeys}
          canKeepMine={(existingWalls.boards?.length ?? 0) > 0}
          loading={existingWalls.boards === null}
          loadFailed={existingWalls.loadFailed}
          busy={submitting}
          onUse={handleUseExistingWall}
          onFixSetup={handleFixExistingWall}
          onKeepMine={handleKeepMine}
          onRetry={handleRetryExistingWalls}
          onDismiss={handleDismissExistingWalls}
          BoardArt={DiscoveryBoardArt}
          sheetRef={existingWallsSheetRef}
        />
      )}
      {reportHost.sheet}
      {duplicate && (
        <BoardDuplicatePromptSheet
          duplicate={duplicate.error}
          busy={submitting}
          onUseExisting={() => void handleUseExistingDuplicate()}
          onAddAnother={handleAddAnother}
          onDismiss={handleDismissDuplicate}
        />
      )}
      <SerialReuseConfirmSheet
        visible={serialReuse !== null}
        board={serialReuse?.board ?? null}
        serialNumber={serialReuse?.input.serialNumber ?? ''}
        onUseExisting={() => void handleUseExistingSerial()}
        onCreateAnyway={handleCreateAnyway}
        onCancel={handleCancelSerialReuse}
      />
    </>
  );
}
