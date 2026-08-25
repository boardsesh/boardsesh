import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import {
  isNoMatchClimb,
  usesAuroraNoMatchDescription,
  withNoMatch,
  CLIMB_CHARACTERISTICS,
  getMoonBoardMethod,
  isAnyFeet,
  isNoKickboard,
  isCampus,
  isNoMatch,
  withCharacteristic,
} from '@boardsesh/shared-schema';
import { getBoardCapabilities } from '@boardsesh/board-config';
import {
  useCreateClimb,
  computeCanUpdate,
  computeEditLocked,
  buildInitialFrames,
  type SavedClimbSnapshot,
} from '@boardsesh/create-climb-react';
import { useBoardActions, isDuplicateClimbError } from '@boardsesh/board-react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { getLayoutName } from '@boardsesh/board-constants/product-sizes';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { useAuth } from '../../providers/auth-provider';
import { useProfile, useClimb } from '../../lib/graphql/hooks';
import { useQueueActions } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import {
  loadDraft,
  saveDraft,
  clearDraft,
  createClimbDraftKey,
  createClimbEditDraftKey,
  createClimbForkDraftKey,
  isDraftStorageAvailable,
  type CreateClimbDraft,
} from '../../lib/create-climb-draft-store';
import { computeRoleCapacity, getNextBrushRole, getPaintRoles, type BrushRole } from './brush-roles';
import { useCreateClimbAutosave } from './use-create-climb-autosave';
import { deriveDraftStatusView, type DraftStatusView } from './draft-status-view';
import { useBleFrameWriter } from '../../lib/ble/use-ble-frame-writer';
import { useCreateClimbPlayback } from './use-create-climb-playback';

// The save button's visual state, derived from auth + the saved-climb snapshot +
// in-flight state. Lives here (the controller computes it) so the UI imports it.
export type SaveButtonState = 'ready' | 'saving' | 'justSaved' | 'editLocked' | 'login';

export type CreateClimbBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type UseCreateClimbScreenArgs = {
  board: CreateClimbBoard;
  /** Single-frame holds string to seed a fork from (no savedClimb tracked). */
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  /** The source climb's `characteristics`, JSON-encoded by the route param, so a
   *  remix inherits its climb rules instead of silently resetting them (#4832).
   *  Absent means the source carried none; `"[]"` means it carried an explicitly
   *  empty set (all rules at their defaults) — a real difference for `noMatch`,
   *  whose legacy fallback is only consulted when the array is absent. */
  forkCharacteristics?: string;
  /** When set, fetch and edit this existing climb in place. */
  editClimbUuid?: string;
  /** Called after a successful publish (non-draft save) so the screen can
   *  dismiss the drawer and let the success toast show over the list. */
  onPublished?: () => void;
  /** Replaces edit/fork route identity with a plain creator after Start new. */
  onStartedNewClimb?: () => void;
};

const BLE_PREVIEW_DEBOUNCE_MS = 250;
const JUST_SAVED_MS = 3000;

/** Field separator for the payload signature — cannot occur in JSON or user text. */
const SIGNATURE_SEPARATOR = '\u0000';

type PayloadSignatureFields = {
  holdsJson: string;
  framesJson: string;
  name: string;
  description: string;
  noMatch: boolean;
  noKickboard: boolean;
  campus: boolean;
  anyFeet: boolean;
  isDraft: boolean;
};

function createPayloadSignature(fields: PayloadSignatureFields): string {
  return [
    fields.holdsJson,
    fields.framesJson,
    fields.name,
    fields.description,
    fields.noMatch ? '1' : '0',
    fields.noKickboard ? '1' : '0',
    fields.campus ? '1' : '0',
    fields.anyFeet ? '1' : '0',
    fields.isDraft ? '1' : '0',
  ].join(SIGNATURE_SEPARATOR);
}

/**
 * Decode the `forkCharacteristics` route param.
 *
 * Returns `null` for an absent or unusable param and the array (possibly empty)
 * for a well-formed one, because the two mean different things downstream: an
 * absent array is the only case where `noMatch` falls back to sniffing the
 * source description for the legacy `No match` prefix. A malformed param reads
 * as absent — a fork with slightly wrong rules is recoverable, a render crash on
 * a hand-edited deep link is not (#3804 is the same lesson one route over).
 */
export function parseForkCharacteristics(serialized: string | undefined): string[] | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((token): token is string => typeof token === 'string');
  } catch {
    return null;
  }
}

function parseSavedClimbSnapshot(serialized: string | undefined): SavedClimbSnapshot | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<SavedClimbSnapshot>;
    if (typeof parsed?.uuid !== 'string' || typeof parsed?.boardType !== 'string') return null;
    return {
      uuid: parsed.uuid,
      boardType: parsed.boardType,
      createdAt: parsed.createdAt ?? null,
      publishedAt: parsed.publishedAt ?? null,
      isDraft: parsed.isDraft ?? true,
    };
  } catch {
    // Corrupt snapshot — restore the paint, drop the row link. The next Save
    // creates a fresh climb rather than updating an unknown uuid.
    return null;
  }
}

/** Duplicate-publish detail surfaced inline so the user can view the match. */
export type PublishDuplicateError = {
  existingClimbUuid: string | null;
  existingClimbName: string | null;
};

function readDuplicateExtensions(err: unknown): PublishDuplicateError {
  if (err instanceof GraphQLOperationError) {
    const extensions = err.extensions as { existingClimbUuid?: unknown; existingClimbName?: unknown } | undefined;
    return {
      existingClimbUuid: typeof extensions?.existingClimbUuid === 'string' ? extensions.existingClimbUuid : null,
      existingClimbName: typeof extensions?.existingClimbName === 'string' ? extensions.existingClimbName : null,
    };
  }
  return { existingClimbUuid: null, existingClimbName: null };
}

/**
 * Compute the full desired boolean state of the freely-toggleable climb
 * characteristics (no_kickboard / campus) from the editor's two switches. The
 * server merges this array onto whatever else is already on the row (no_match,
 * MoonBoard method tokens), so only these two tokens are ever represented here.
 */
function buildToggleableCharacteristics(noKickboard: boolean, campus: boolean): string[] | null {
  let characteristics: string[] = [];
  characteristics = withCharacteristic(characteristics, CLIMB_CHARACTERISTICS.NO_KICKBOARD, noKickboard);
  characteristics = withCharacteristic(characteristics, CLIMB_CHARACTERISTICS.CAMPUS, campus);
  return characteristics.length > 0 ? characteristics : null;
}

/**
 * Same as {@link buildToggleableCharacteristics}, but also folds in no_match and
 * any_feet — used only for the LOCAL provisional queue-item display
 * (buildProvisionalClimb), never for the save/update payload.
 * `ClimbAttributeIcons` prefers the `characteristics` array over the legacy
 * `is_no_match` bool the moment the array is non-null, so a provisional row with,
 * say, campus=true and noMatch=true would otherwise show the campus badge but
 * silently drop the no-match one. The real saved row doesn't have this problem:
 * the server derives both from their own input fields independently of the
 * client-supplied `characteristics` field, and rejects any_feet inside it.
 *
 * Always non-null on a board that states its rules explicitly (Woods): there,
 * `[]` is the meaningful "all defaults" answer and null would read as "we don't
 * know this climb's rules" — which is exactly what the editor DOES know.
 */
function buildProvisionalCharacteristics(
  noMatch: boolean,
  noKickboard: boolean,
  campus: boolean,
  anyFeet: boolean,
  rulesAlwaysKnown: boolean,
): string[] | null {
  let characteristics = buildToggleableCharacteristics(noKickboard, campus) ?? [];
  characteristics = withCharacteristic(characteristics, CLIMB_CHARACTERISTICS.NO_MATCH, noMatch);
  characteristics = withCharacteristic(characteristics, CLIMB_CHARACTERISTICS.ANY_FEET, anyFeet);
  if (characteristics.length > 0) return characteristics;
  return rulesAlwaysKnown ? [] : null;
}

/**
 * The create-climb screen controller. Composes the shared hold-state machine
 * with auth, the board provider's save/update mutations, the per-board local
 * autosave, BLE preview, and the queue, and exposes a save state machine the
 * create drawer's action bar renders.
 */
export function useCreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  forkCharacteristics,
  editClimbUuid,
  onPublished,
  onStartedNewClimb,
}: UseCreateClimbScreenArgs) {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { isAuthenticated, saveClimb, updateClimb } = useBoardActions();
  const auth = useAuth();
  const { data: profile } = useProfile();
  const { setCurrentClimb } = useQueueActions();
  const bluetooth = useOptionalBluetoothContext();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const isForking = !!forkFrames;
  const isEditing = !!editClimbUuid;
  const boardCapabilities = getBoardCapabilities(board.boardName);
  // Aurora carries "no matching" as a `No match` line at the head of the climb
  // description, so that prefix is a real signal there and must keep round-tripping.
  // On the code-driven boards it is not a convention at all — a description
  // starting with those words is the setter's prose — so neither the seed nor the
  // save payload is allowed to touch it.
  const usesNoMatchDescription = usesAuroraNoMatchDescription(board.boardName);
  // Woods says both climb rules on every problem, so an authored Woods climb has
  // to store a KNOWN answer for each of them — `[]` (all defaults), never the
  // null that reads as "nobody recorded the rules for this climb".
  const rulesAlwaysKnown = boardCapabilities.explicitClimbRules;

  // A remix inherits its source's rules. Parsed once from the route param, which
  // preserves the absent-vs-empty distinction the noMatch fallback below turns on.
  const seededForkCharacteristics = useMemo(
    () => (isForking ? parseForkCharacteristics(forkCharacteristics) : null),
    [isForking, forkCharacteristics],
  );

  // Seed the editor from a fork's frames once, preserving every frame of a
  // multi-frame source route (an empty single frame otherwise). Edit mode
  // seeds asynchronously below (guarded by a ref).
  const initialFrames = useMemo(
    () => (isForking && forkFrames ? buildInitialFrames(forkFrames, board.boardName) : undefined),
    // Seed only once from the route param — board.boardName is stable per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const {
    litUpHoldsMap,
    frames,
    frameCount,
    currentFrameIndex,
    setHoldState,
    generateFramesString,
    currentFrameBleString,
    startingCount,
    finishCount,
    isValid,
    canSave,
    canPublish,
    resetHolds,
    loadFrames,
    duplicateFrame,
    deleteFrame,
    goToFrame,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useCreateClimb(board.boardName, { initialFrames });

  const [selectedBrush, setSelectedBrush] = useState<BrushRole>('HAND');
  const [name, setName] = useState(isForking && forkName ? `${forkName} remix` : '');
  const [description, setDescription] = useState(
    isForking && forkDescription
      ? usesNoMatchDescription
        ? withNoMatch(forkDescription, false)
        : forkDescription
      : '',
  );
  // The "no match" climb rule is a separate boolean in the editor. It rides the
  // save payload as an explicit field AND (for older servers, and for Aurora
  // round-tripping) as a leading "No match" line in the description, encoded only
  // at save time so the editable description field stays clean.
  //
  // Seeding PREFERS the structured flag: a stripped description is a string
  // sniff, and it is wrong for a source climb whose description happens to start
  // with those words, or whose no-match rule was set without one. The legacy
  // sniff is the fallback for exactly one case — a source that carried no
  // characteristics array at all, where the description is the only signal there
  // is.
  const [noMatch, setNoMatch] = useState(() => {
    if (!isForking) return false;
    if (seededForkCharacteristics) return isNoMatch(seededForkCharacteristics);
    return usesNoMatchDescription && forkDescription ? isNoMatchClimb(forkDescription) : false;
  });
  // A remix now carries every supported rule across (#4832). An absent
  // `forkCharacteristics` leaves them at their defaults, which is what a fork
  // from a source with no recorded rules should be.
  const [noKickboard, setNoKickboard] = useState(() => isNoKickboard(seededForkCharacteristics));
  // The raw setters are used by the restore/seed/reset paths, which apply a
  // whole coherent rule set at once. The UI gets the mutually-exclusive wrappers
  // below instead.
  const [campus, setCampusState] = useState(() => isCampus(seededForkCharacteristics));
  const [anyFeet, setAnyFeetState] = useState(() => isAnyFeet(seededForkCharacteristics));
  const [isDraft, setIsDraft] = useState(true);
  const [showAllHolds, setShowAllHolds] = useState(false);

  // The MoonBoard "method" of the climb this session is attached to, if any. The
  // editor cannot set or clear a method token (that is creation-time-only, via
  // SaveMoonBoardClimbInput), so a footless problem's own row keeps saying "no
  // feet" whatever this editor sends. Offering "Any feet" on top of it would let
  // a climber publish a climb that contradicts itself. Seeded from the edit
  // fetch and from a fork's characteristics.
  const [seededMethod, setSeededMethod] = useState<string | null>(() => getMoonBoardMethod(seededForkCharacteristics));
  const footlessMethod =
    seededMethod === CLIMB_CHARACTERISTICS.METHOD_FOOTLESS ||
    seededMethod === CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD;
  const anyFeetAvailable = !footlessMethod;

  // "Any feet" and "Campus" are opposite answers to the same question — where
  // may your feet go — so each one turns the other off rather than leaving a
  // climb that says both "anywhere" and "nowhere". `noKickboard` is a separate
  // question (may the kickboard be one of those places) and stays independent of
  // both.
  const setCampus = useCallback((next: boolean) => {
    setCampusState(next);
    if (next) setAnyFeetState(false);
  }, []);
  // Guarded, not just hidden: the row's MoonBoard method is authoritative and
  // this editor cannot change it, so "any feet" must be unreachable while the
  // method says there are none — through a stale render of the form as much as
  // through the switch.
  const setAnyFeet = useCallback(
    (next: boolean) => {
      if (next && footlessMethod) return;
      setAnyFeetState(next);
      if (next) setCampusState(false);
    },
    [footlessMethod],
  );

  // A footless method arriving after the toggle was already on (the edit fetch
  // resolves asynchronously) has to win for the same reason.
  useEffect(() => {
    if (footlessMethod) setAnyFeetState(false);
  }, [footlessMethod]);

  const [savedClimb, setSavedClimb] = useState<SavedClimbSnapshot | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [publishDuplicateError, setPublishDuplicateError] = useState<PublishDuplicateError | null>(null);
  // Payload signature at the last SUCCESSFUL explicit save, and at the last
  // FAILED one. Both are compared against the live signature below, which is how
  // "edited since you saved" and "that save failed" stay true without a timer.
  // Inline "Start over?" confirm, rendered as sheet content — see handleNewClimb.
  const [pendingNewClimb, setPendingNewClimb] = useState(false);
  // Bumped once per blank climb that ACTUALLY starts, so chrome can react to a
  // new climb rather than to the intent to start one. `handleNewClimb` only
  // raises the confirmation when there is unsaved work, and that confirmation
  // can be cancelled — anything keyed on the press instead of this fires for a
  // climb that never changed. The create drawer drops the board zoom on it.
  const [blankClimbEpoch, setBlankClimbEpoch] = useState(0);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [savedSignatureUnknown, setSavedSignatureUnknown] = useState(false);
  const [failedSignature, setFailedSignature] = useState<string | null>(null);
  // State updates do not become visible until React renders again. These refs
  // close the same-tick race between Save and Start new (or two quick taps).
  const saveInFlightRef = useRef(false);
  const startNewInFlightRef = useRef(false);

  useEffect(() => {
    setSelectedBrush((currentBrush) => {
      if (currentBrush === 'OFF') return currentBrush;
      const supportedRoles = getPaintRoles(board.boardName);
      return supportedRoles.includes(currentBrush) ? currentBrush : (supportedRoles[0] ?? 'HAND');
    });
  }, [board.boardName]);

  const draftKey = useMemo(() => createClimbDraftKey(board), [board]);

  // ---- One deterministic autosave slot per authoring mode. ----
  // Identity now lives in the KEY, which is why autosave no longer has to be
  // switched off outside the plain-new case. It used to be, because the slot key
  // carried board config only: a fork or an edit writing it would clobber a real
  // new-climb WIP and resurface as a phantom. The cost of that boolean was that
  // editing a draft, remixing a climb, and everything after the first Save had no
  // autosave at all — the three states where losing work hurts most.
  //   new  → `<board>:<layout>:<size>:<sets>:<angle>`  (string UNCHANGED, so
  //          drafts already on devices keep restoring — no migration)
  //   edit → `edit:<boardType>:<uuid>`   (reopening that climb finds it)
  //   fork → `fork:<boardKey>`           (a plain-new mount falls back to it)
  const autosaveSlotKey = useMemo(() => {
    if (isEditing && editClimbUuid) return createClimbEditDraftKey(board.boardName, editClimbUuid);
    if (isForking) return createClimbForkDraftKey(draftKey);
    return draftKey;
  }, [isEditing, editClimbUuid, isForking, board.boardName, draftKey]);

  // Forks seed from another climb's frames, so there is nothing to restore.
  // Edit mode DOES restore, but inside the seed effect below — after the server
  // copy lands, never before it.
  const skipRestoreRef = useRef(isForking);
  const restoredRef = useRef(false);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  // Stable provisional queue-item uuid for an unsaved WIP, so re-tapping "Set as
  // active" updates the same queue slot instead of appending a new item each tap.
  const previewUuidRef = useRef<string | null>(null);
  if (!previewUuidRef.current) previewUuidRef.current = randomUUID();
  // Tracked so the just-saved confirmation timer is cleared on unmount.
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const markRestored = useCallback(() => {
    restoredRef.current = true;
    if (mountedRef.current) setRestoreEpoch((epoch) => epoch + 1);
  }, []);
  useEffect(
    () => () => {
      mountedRef.current = false;
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
    },
    [],
  );

  // ---- Detach the saved-climb row + queue identity when the working angle
  // changes. ----
  // The screen key (createClimbScreenKey) deliberately excludes `angle`, so a
  // working-angle change keeps this hook mounted (and its in-progress paint —
  // hold geometry is angle-independent). But `savedClimb` was saved *at* the
  // old angle, and `handleSetActive` / `handleSave` stamp the live `board.angle`
  // — so leaving the old row attached would pair the old climb's uuid with the
  // new angle (Set Active shows the wrong angle; a re-Save would updateClimb the
  // old row to the new angle). Web has no such bug: its angle is a URL segment,
  // so an angle change remounts the form and resets `savedClimb` to null. This
  // mirrors that reset without wiping the paint. Skipped in edit mode, whose
  // identity is `editClimbUuid` (you're editing one row across any angle).
  const lastAngleRef = useRef(board.angle);
  useEffect(() => {
    if (lastAngleRef.current === board.angle) return;
    lastAngleRef.current = board.angle;
    if (isEditing) return;
    // Fresh authoring context at the new angle: drop the saved-row link so the
    // next Save creates a new climb, clear any stale duplicate banner, and mint
    // a new preview uuid so Set Active pushes an independent queue item.
    setSavedClimb(null);
    setSavedSignature(null);
    setSavedSignatureUnknown(false);
    setPublishDuplicateError(null);
    previewUuidRef.current = randomUUID();
  }, [board.angle, isEditing]);

  // ---- Edit mode: fetch the climb and seed the editor once. ----
  const editVariables = useMemo(
    () =>
      isEditing && editClimbUuid
        ? {
            boardName: board.boardName,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            climbUuid: editClimbUuid,
          }
        : null,
    [isEditing, editClimbUuid, board],
  );
  const { data: editClimb, isError: editClimbFailed } = useClimb(editVariables);

  // The climb the link asked to edit does not fit the wall the link opened.
  //
  // Hold ids are size-relative on Woods — the 8x10 numbers its holds 0-484 and
  // the 12x12 its own 0-893 — so every 8x10 climb "fits" a 12x12 by id and would
  // seed the editor with a completely different set of holds, then save that back
  // over the original. `compatible_size_ids` is the column that tells them apart
  // (`canAddClimbToBoard` rule 5); a row that carries none imposes no constraint,
  // exactly as it does for the queue.
  const editSizeMismatch =
    editClimb != null && editClimb.compatibleSizeIds != null && !editClimb.compatibleSizeIds.includes(board.sizeId);

  // Apply a stored working copy over whatever the editor currently holds.
  const applyStoredDraft = useCallback(
    (draft: CreateClimbDraft) => {
      try {
        const restoredFrames = draft.framesJson
          ? (JSON.parse(draft.framesJson) as Parameters<typeof loadFrames>[0])
          : [JSON.parse(draft.holdsJson) as Parameters<typeof loadFrames>[0][number]];
        loadFrames(restoredFrames);
      } catch {
        // Corrupt holds payload — keep whatever is already loaded.
      }
      setName(draft.name);
      setDescription(usesNoMatchDescription ? withNoMatch(draft.description, false) : draft.description);
      // Explicit flag first; the description sniff only reaches slots written
      // before the flag existed, which were all Aurora-convention anyway.
      setNoMatch(draft.noMatch ?? (usesNoMatchDescription && isNoMatchClimb(draft.description)));
      setNoKickboard(draft.noKickboard ?? false);
      // Raw setters: a stored slot is one coherent rule set written by this same
      // editor, so re-running the exclusivity rules over it would only reorder
      // what it already agreed on. Campus still wins if an old slot somehow
      // carries both — the stricter rule, same as everywhere else.
      setCampusState(draft.campus ?? false);
      setAnyFeetState(!draft.campus && (draft.anyFeet ?? false));
      setIsDraft(draft.isDraft);
    },
    [loadFrames, usesNoMatchDescription],
  );

  type EditFailureRestoreState = 'idle' | 'loading' | 'found' | 'empty';
  const editFailureRestoreStateRef = useRef<EditFailureRestoreState>('idle');
  const emptyFailureBaselineSignatureRef = useRef<string | null>(null);
  const [editFailureRestoreState, setEditFailureRestoreState] = useState<EditFailureRestoreState>('idle');
  const editSeededRef = useRef(false);

  // A failed edit query must restore the existing edit slot BEFORE opening the
  // autosave gate. Otherwise the blank editor's first change overwrites the
  // only durable copy. Keep the result as state so a later successful retry can
  // attach the server row without racing or replacing the restored editor.
  useEffect(() => {
    if (
      !isEditing ||
      !editClimbUuid ||
      !editClimbFailed ||
      editSeededRef.current ||
      editFailureRestoreStateRef.current !== 'idle'
    ) {
      return;
    }
    editFailureRestoreStateRef.current = 'loading';
    setEditFailureRestoreState('loading');
    const signatureBeforeRestore = payloadSignatureRef.current;
    void loadDraft(createClimbEditDraftKey(board.boardName, editClimbUuid))
      .then((storedDraft) => {
        if (!storedDraft) {
          emptyFailureBaselineSignatureRef.current = signatureBeforeRestore;
          editFailureRestoreStateRef.current = 'empty';
          setEditFailureRestoreState('empty');
          return;
        }
        if (payloadSignatureRef.current === signatureBeforeRestore) applyStoredDraft(storedDraft);
        const restoredSavedClimb = parseSavedClimbSnapshot(storedDraft.savedClimbJson) ?? {
          uuid: editClimbUuid,
          boardType: board.boardName,
          createdAt: null,
          publishedAt: null,
          isDraft: storedDraft.isDraft,
        };
        setSavedClimb(restoredSavedClimb);
        setSavedSignature(storedDraft.savedPayloadSignature ?? null);
        setSavedSignatureUnknown(storedDraft.savedPayloadSignature === undefined);
        editFailureRestoreStateRef.current = 'found';
        setEditFailureRestoreState('found');
      })
      .catch(() => {
        emptyFailureBaselineSignatureRef.current = signatureBeforeRestore;
        editFailureRestoreStateRef.current = 'empty';
        setEditFailureRestoreState('empty');
      })
      .finally(() => {
        markRestored();
      });
  }, [isEditing, editClimbUuid, editClimbFailed, board.boardName, applyStoredDraft, markRestored]);

  useEffect(() => {
    if (!editClimb || editSizeMismatch || editSeededRef.current || editFailureRestoreState === 'loading') return;
    editSeededRef.current = true;
    const serverFrames = buildInitialFrames(editClimb.frames, board.boardName);
    const serverDescription = usesNoMatchDescription
      ? withNoMatch(editClimb.description ?? '', false)
      : (editClimb.description ?? '');
    // Structured flag first, description sniff only when the row carries no
    // characteristics array at all — same rule as the fork seed above.
    const serverNoMatch = editClimb.characteristics
      ? isNoMatch(editClimb.characteristics)
      : usesNoMatchDescription && isNoMatchClimb(editClimb.description);
    const serverNoKickboard = isNoKickboard(editClimb.characteristics);
    const serverCampus = isCampus(editClimb.characteristics);
    const serverAnyFeet = !serverCampus && isAnyFeet(editClimb.characteristics);
    const serverIsDraft = editClimb.is_draft ?? false;
    const serverSignature = createPayloadSignature({
      holdsJson: JSON.stringify(serverFrames[0] ?? {}),
      framesJson: JSON.stringify(serverFrames),
      name: editClimb.name,
      description: serverDescription,
      noMatch: serverNoMatch,
      noKickboard: serverNoKickboard,
      campus: serverCampus,
      anyFeet: serverAnyFeet,
      isDraft: serverIsDraft,
    });
    const serverSnapshot: SavedClimbSnapshot = {
      uuid: editClimb.uuid,
      boardType: board.boardName,
      createdAt: editClimb.created_at ?? null,
      publishedAt: editClimb.published_at ?? null,
      isDraft: serverIsDraft,
    };
    setSavedClimb(serverSnapshot);
    setSavedSignature(serverSignature);
    setSavedSignatureUnknown(false);
    // Outside the reseed guard below: the row's MoonBoard method belongs to the
    // ROW, not to the working copy, so it applies even when a restored phone
    // copy wins the editor.
    setSeededMethod(getMoonBoardMethod(editClimb.characteristics));

    // The failure path already restored the phone copy. A retry may attach the
    // authoritative server identity and baseline, but must never reseed the
    // editor and wipe edits made while offline.
    const editedAfterEmptyFailure =
      editFailureRestoreState === 'empty' &&
      emptyFailureBaselineSignatureRef.current !== null &&
      payloadSignatureRef.current !== emptyFailureBaselineSignatureRef.current;
    if (editFailureRestoreState === 'found' || editedAfterEmptyFailure) {
      markRestored();
      return;
    }

    loadFrames(serverFrames);
    setName(editClimb.name);
    setDescription(serverDescription);
    setNoMatch(serverNoMatch);
    setNoKickboard(serverNoKickboard);
    setCampusState(serverCampus);
    setAnyFeetState(serverAnyFeet);
    setIsDraft(serverIsDraft);

    // ORDERING IS LOAD-BEARING. The `edit:` slot is applied OVER the server copy,
    // and `restoredRef` opens only once that has resolved. Set it any earlier and
    // the next debounce tick writes the freshly fetched SERVER copy into the slot,
    // destroying exactly the unflushed edits this restore exists to recover —
    // silently, while the status line still reads "Draft saved to your account".
    // Pinned by "applies the stored edit slot over the server copy" in
    // use-create-climb-screen-autosave.test.tsx. No cancellation on purpose:
    // `editSeededRef` already makes this run once per mount, and a cancelled
    // restore would leave the gate shut and autosave dead for the whole session.
    void loadDraft(createClimbEditDraftKey(board.boardName, editClimb.uuid))
      .then((storedDraft) => {
        if (storedDraft) {
          applyStoredDraft(storedDraft);
          setSavedSignature(serverSignature);
        }
      })
      .catch(() => {
        // Unreadable slot — the server copy stands.
      })
      .finally(() => {
        markRestored();
      });
  }, [
    editClimb,
    editSizeMismatch,
    editFailureRestoreState,
    board.boardName,
    usesNoMatchDescription,
    loadFrames,
    applyStoredDraft,
    markRestored,
  ]);

  // ---- Local autosave restore on mount (plain new climb). ----
  useEffect(() => {
    // Edit mode restores inside the seed effect above; forks seed from source.
    if (isEditing || skipRestoreRef.current) {
      if (!isEditing) markRestored();
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let draft = await loadDraft(draftKey);
        // A killed remix session lives in the fork slot, and a cold relaunch can
        // only land on the plain creator (the modal route with `forkFrames` is
        // gone), so this is the only door back to it. Adopt it with a write-first
        // migration: a crash can leave two copies, never zero copies.
        if (!draft) {
          const forkSlotKey = createClimbForkDraftKey(draftKey);
          const forkDraft = await loadDraft(forkSlotKey);
          if (forkDraft) {
            await saveDraft(draftKey, forkDraft);
            draft = forkDraft;
            try {
              await clearDraft(forkSlotKey);
            } catch {
              // The destination is durable and wins on the next mount. Leave it
              // intact even if retiring the source needs another attempt.
            }
          }
        }
        if (cancelled || !draft) return;
        applyStoredDraft(draft);
        // Re-attach the server row this working copy belongs to, so the next Save
        // UPDATES that climb instead of creating a duplicate in Open drafts.
        const restoredSavedClimb = parseSavedClimbSnapshot(draft.savedClimbJson);
        if (restoredSavedClimb) {
          setSavedClimb(restoredSavedClimb);
          setSavedSignature(draft.savedPayloadSignature ?? null);
          setSavedSignatureUnknown(draft.savedPayloadSignature === undefined);
        }
      } catch {
        // Storage failure leaves the editor empty but must not disable autosave
        // for the rest of the session.
      } finally {
        if (!cancelled) markRestored();
      }
    })();
    return () => {
      cancelled = true;
    };
    // draftKey is stable per screen mount; restore once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Local autosave (debounced). ----
  // Frame 0, NOT the active frame: `holdsJson` is an autosave dep, and playback
  // moves the active frame every tick — at the 500ms debounce under a 750ms pace
  // that is one draft write per frame, each persisting a different holdsJson for
  // the same framesJson. Frame 0 is also what the legacy single-frame restore
  // fallback below actually wants, and it is invariant under frame navigation,
  // which is what makes it agree with the `serverFrames[0]` draft baseline.
  const holdsJson = useMemo(() => JSON.stringify(frames[0] ?? {}), [frames]);
  // The active frame as an absolute single-frame Aurora string — what the board
  // renderer draws. `currentFrameBleString`'s identity already tracks
  // `litUpHoldsMap`, so this recomputes exactly once per paint.
  const currentFramesString = useMemo(() => currentFrameBleString(), [currentFrameBleString]);
  const framesJson = useMemo(() => JSON.stringify(frames), [frames]);
  const hasContent = holdsJson !== '{}' || frameCount > 1 || name.trim() !== '' || description.trim() !== '';

  // Content identity of the working copy. One value serves three jobs: it tells
  // the status line whether there are edits since the last save, it clears a
  // stale save-failure the moment the payload moves, and `handleSave` compares it
  // before and after the round trip so a publish never clears work typed while
  // the mutation was in flight.
  const payloadSignature = createPayloadSignature({
    holdsJson,
    framesJson,
    name,
    description,
    noMatch,
    noKickboard,
    campus,
    anyFeet,
    isDraft,
  });
  const payloadSignatureRef = useRef(payloadSignature);
  payloadSignatureRef.current = payloadSignature;
  const hasUnsavedEdits =
    savedClimb != null && (savedSignatureUnknown || (savedSignature !== null && savedSignature !== payloadSignature));

  const savedClimbJson = useMemo(() => (savedClimb ? JSON.stringify(savedClimb) : undefined), [savedClimb]);

  const autosaveDraft = useMemo<CreateClimbDraft>(
    () => ({
      holdsJson,
      framesJson,
      name,
      // The slot keeps the description the user actually typed and the rule as
      // its own flag. Encoding the rule into the prose was only ever an Aurora
      // wire convention, and re-parsing it on restore made "No match" the first
      // word of a description a rule the climber never set.
      description,
      noMatch,
      isDraft,
      noKickboard,
      campus,
      anyFeet,
      savedClimbJson,
      savedPayloadSignature: savedSignature ?? undefined,
      origin: isEditing ? 'edit' : isForking ? 'fork' : 'new',
      updatedAtMs: Date.now(),
    }),
    [
      holdsJson,
      framesJson,
      name,
      description,
      noMatch,
      noKickboard,
      campus,
      anyFeet,
      isDraft,
      savedClimbJson,
      savedSignature,
      isEditing,
      isForking,
    ],
  );
  const autosaveDraftRef = useRef(autosaveDraft);
  autosaveDraftRef.current = autosaveDraft;

  const { discard: discardAutosaveSlot, persist: persistAutosaveSlot } = useCreateClimbAutosave({
    slotKey: autosaveSlotKey,
    draft: autosaveDraft,
    // Server-link metadata is written explicitly on Save. Only content changes
    // re-arm the debounce, avoiding a redundant second write after Save.
    draftSignature: payloadSignature,
    hasContent,
    restoredRef,
    restoreEpoch,
  });

  // ---- Route playback (preview the moves before publishing). ----
  const playback = useCreateClimbPlayback({
    frames,
    boardName: board.boardName,
    currentFrameIndex,
    goToFrame,
  });

  // True once Set-Active handed the route to the queue. The auto-sender then
  // owns the wall and lights the whole route, so the creator stands its own
  // writers down rather than fighting it a frame at a time — and the transport
  // swaps its frame counter for an "On the wall" chip, because "2 / 3" over a
  // fully-lit wall is worse than no counter at all. Any edit or transport press
  // takes the wall back.
  const [handedOff, setHandedOff] = useState(false);
  const reclaimWall = useCallback(() => setHandedOff(false), []);

  // ---- BLE preview (debounced) while connected. ----
  const sendFramesRef = useRef(bluetooth?.sendFramesToBoard);
  sendFramesRef.current = bluetooth?.sendFramesToBoard;
  const wallMatchesEditor =
    board.boardName !== 'woods' ||
    (bluetooth?.boardName === board.boardName &&
      bluetooth.layoutId === board.layoutId &&
      bluetooth.sizeId === board.sizeId);
  const bleConnected = (bluetooth?.isConnected ?? false) && wallMatchesEditor;
  const invalidateWallState = bluetooth?.invalidateWallState;
  const invalidateWallStateRef = useRef(invalidateWallState);
  invalidateWallStateRef.current = invalidateWallState;
  const isPlaying = playback.isPlaying;
  useEffect(() => {
    // While playing, the frame writer below owns the wall — at MIN_PACE_MS this
    // debounce would swallow every frame and send nothing until playback stops.
    if (!bleConnected || editSizeMismatch || isPlaying || handedOff) return;
    const handle = setTimeout(() => {
      // The active frame only — the wall mirrors whatever you're painting
      // right now, not multi-frame route syntax the BLE packet builder can't
      // parse.
      invalidateWallStateRef.current?.();
      void sendFramesRef.current?.(currentFrameBleString());
    }, BLE_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [holdsJson, bleConnected, editSizeMismatch, isPlaying, handedOff, currentFrameBleString]);

  // Latest-wins writer for playback frames — the same drain the play drawer uses.
  useBleFrameWriter({
    frame: isPlaying && bleConnected && !handedOff && !editSizeMismatch ? playback.currentFrameString : null,
    send: bluetooth?.sendFramesToBoard,
    mirrored: false,
    resetKey: draftKey,
    // The creator writes straight past the auto-sender, so its record of what
    // the wall physically shows has to be dropped — otherwise re-selecting the
    // previously-lit queue item hits the dedup skip and confirms a climb over a
    // wall showing the creator's frame 3.
    onWrite: invalidateWallState,
  });

  // ---- Painting + role assignment. ----
  // A tap sets the tapped hold straight to the selected brush — cycling only
  // kicks in when the tap can't just do that: re-tapping the same hold with
  // the same brush still selected (so repeated taps walk the role list
  // instead of re-confirming the first one over and over), or the brush's
  // role has no room left (2 starts/finishes already placed, or a foot piece
  // on a "campus" climb), where setting directly would silently no-op. Reset
  // on any other tap — a different hold, or the same hold after switching
  // brushes — so switching to Foot and tapping a start hold sets it to Foot
  // outright rather than resuming wherever the last cycle left off.
  const lastPaintRef = useRef<{ holdId: number; brush: BrushRole } | null>(null);
  const handlePaint = useCallback(
    (holdId: number) => {
      reclaimWall();
      const currentState = litUpHoldsMap[holdId]?.state ?? 'OFF';
      // `lastPaintRef` itself is never cleared on a brush switch — only this
      // equality check gates it — so tapping X under brush A, switching to
      // brush B (without tapping), then switching back to A and tapping X
      // again still counts as "last tapped under A" and resumes that cycle.
      // Deliberate: it's still true that X is the last hold tapped while A was
      // the active role.
      const isContinuingCycle =
        lastPaintRef.current?.holdId === holdId && lastPaintRef.current?.brush === selectedBrush;
      const atCapacity = computeRoleCapacity(litUpHoldsMap, holdId, campus);
      const brushAtCapacity = selectedBrush !== 'OFF' && !!atCapacity[selectedBrush];
      const nextState =
        isContinuingCycle || brushAtCapacity
          ? getNextBrushRole(board.boardName, currentState, selectedBrush, atCapacity)
          : selectedBrush;
      setHoldState(holdId, nextState);
      lastPaintRef.current = { holdId, brush: selectedBrush };
    },
    [setHoldState, selectedBrush, litUpHoldsMap, board.boardName, campus, reclaimWall],
  );

  // A hold-role cycle only makes sense while staying on the same frame —
  // switching frames (nav, duplicate, delete) starts a fresh tapping context.
  useEffect(() => {
    lastPaintRef.current = null;
  }, [currentFrameIndex, frameCount]);

  const handleAssignRole = useCallback(
    (holdId: number, role: BrushRole) => {
      reclaimWall();
      setHoldState(holdId, role);
      // The long-press role sheet is a direct assignment, not a tap — clear
      // any in-progress cycle so a follow-up tap on this hold starts fresh
      // instead of resuming wherever the sheet left it.
      lastPaintRef.current = null;
    },
    [setHoldState, reclaimWall],
  );

  // Editing or touching the transport takes the wall back from the queue.
  const handleDuplicateFrame = useCallback(() => {
    reclaimWall();
    duplicateFrame();
  }, [duplicateFrame, reclaimWall]);

  const handleDeleteFrame = useCallback(() => {
    reclaimWall();
    deleteFrame();
  }, [deleteFrame, reclaimWall]);

  const playbackPlay = playback.play;
  const playbackPause = playback.pause;
  const playbackSeek = playback.seek;

  const handlePlay = useCallback(() => {
    reclaimWall();
    playbackPlay();
  }, [playbackPlay, reclaimWall]);

  const handleSeek = useCallback(
    (index: number) => {
      reclaimWall();
      playbackSeek(index);
    },
    [playbackSeek, reclaimWall],
  );

  const playbackControls = useMemo(
    () => ({
      isPlaying: playback.isPlaying,
      speed: playback.speed,
      paceMs: playback.paceMs,
      play: handlePlay,
      pause: playbackPause,
      seek: handleSeek,
      setSpeed: playback.setSpeed,
    }),
    [playback.isPlaying, playback.speed, playback.paceMs, playbackPause, playback.setSpeed, handlePlay, handleSeek],
  );

  // ---- Clear holds vs. start a new climb. ----
  // These were one button doing both jobs behind a trash can labelled "Clear
  // holds": it also wiped the name, the description and the on-device slot, none
  // of which undo restores. Split so the label, the glyph and the behaviour agree.

  /** Empty this frame's holds. Undoable through the reducer; touches nothing else. */
  const handleClearHolds = useCallback(() => {
    reclaimWall();
    resetHolds();
    lastPaintRef.current = null;
  }, [resetHolds, reclaimWall]);

  const resetToBlankClimb = useCallback(async () => {
    reclaimWall();
    // Drop the working copy THIS session owns — in fork/edit mode that is the
    // `fork:`/`edit:` slot, not the shared new-climb one. Clearing only
    // `draftKey` left an abandoned fork slot behind, which the plain creator's
    // fork fallback would then resurrect as a ghost draft on the next open. A
    // server draft is untouched either way: it lives in board_climbs, not here,
    // so an edit session still leaves its row in Open drafts.
    try {
      await discardAutosaveSlot();
      if (!mountedRef.current) return;
      setPendingNewClimb(false);
      resetHolds();
      lastPaintRef.current = null;
      setName('');
      setDescription('');
      setNoMatch(false);
      setNoKickboard(false);
      setCampusState(false);
      setAnyFeetState(false);
      // A blank climb is nobody's remix and nobody's edit, so it inherits no
      // MoonBoard method either — the Any-feet row comes back with it.
      setSeededMethod(null);
      setIsDraft(true);
      setSavedClimb(null);
      setPublishDuplicateError(null);
      setSavedSignature(null);
      setSavedSignatureUnknown(false);
      setFailedSignature(null);
      // Fresh climb identity for the next WIP so its queue item is independent.
      previewUuidRef.current = randomUUID();
      // Inside the try on purpose: a storage failure below leaves the editor
      // and the confirmation intact, so no new climb started and nothing keyed
      // on this should move.
      setBlankClimbEpoch((epoch) => epoch + 1);
      if (isEditing || isForking) onStartedNewClimb?.();
    } catch {
      // Keep the editor and confirmation intact when storage cannot retire the
      // slot. Resetting anyway would let that supposedly abandoned work restore
      // as a ghost draft on the next mount; clearing the in-flight ref below
      // leaves the action retryable.
    } finally {
      startNewInFlightRef.current = false;
    }
  }, [resetHolds, discardAutosaveSlot, isEditing, isForking, onStartedNewClimb, reclaimWall]);

  const confirmNewClimb = useCallback(() => {
    if (saveInFlightRef.current || startNewInFlightRef.current) return;
    startNewInFlightRef.current = true;
    void resetToBlankClimb();
  }, [resetToBlankClimb]);

  /**
   * Park this climb and start a blank one. A saved climb keeps its row in Open
   * drafts (only the working slot is dropped), so that case goes straight
   * through. An unsaved one genuinely is not recoverable, so it asks first —
   * INLINE, not through `useConfirm`: a dialog raised from inside this native
   * sheet is invisible on Android and its promise never resolves, which left this
   * button doing nothing at all. See InlineConfirmBanner.
   */
  const handleNewClimb = useCallback(() => {
    if (saveInFlightRef.current || startNewInFlightRef.current) return;
    if (hasContent && (savedClimb == null || hasUnsavedEdits)) {
      setPendingNewClimb(true);
      return;
    }
    startNewInFlightRef.current = true;
    void resetToBlankClimb();
  }, [savedClimb, hasContent, hasUnsavedEdits, resetToBlankClimb]);

  const cancelNewClimb = useCallback(() => setPendingNewClimb(false), []);

  // Build a minimal Climb the queue can hold for a not-yet-saved or just-saved
  // climb. The mutation input (`ClimbInput`) is a strict subset of Climb, so
  // these placeholder grade fields are never sent to the server — they only
  // satisfy the type and render neutral values in the queue UI.
  //
  // Board identity (boardType/layoutId) is required, not optional: the queue item
  // round-trips through `toClimbInput` to party peers and into the board-presence
  // report, and the BLE auto-sender reads it to tell a board/layout "spill" from a
  // sendable climb. Omitting it left a freshly created climb board-less on the wire —
  // peers received a climb they couldn't place, and the presence row lost its board.
  //
  // Ownership and draft state ride along too (#3927 widened the queue boundary
  // and both subscription selection sets to carry them). Without these the climb
  // you just made lands in the queue as if it belonged to nobody, so the play
  // drawer's owner-only Edit action never appears on your own fresh draft —
  // `computeCanUpdate` reads exactly userId + is_draft + published_at.
  const buildProvisionalClimb = useCallback(
    (uuid: string, frames: string): Climb => ({
      uuid,
      boardType: board.boardName,
      layoutId: board.layoutId,
      ...(board.boardName === 'woods' ? { compatibleSizeIds: [board.sizeId] } : {}),
      name: name.trim() || t('createClimbForm.draftBadge'),
      frames,
      setter_username: profile?.displayName ?? '',
      // Null until the profile query resolves, same as setter_username above, so
      // a climb queued during a cold start shows no Edit action until the next
      // save replaces the item. Self-correcting and not worth a queue-item
      // update path; revisit if it shows up in offline-first flows.
      userId: profile?.id ?? null,
      description,
      angle: board.angle,
      ascensionist_count: 0,
      difficulty: '',
      quality_average: '0',
      stars: 0,
      difficulty_error: '0',
      benchmark_difficulty: null,
      is_no_match: noMatch,
      characteristics: buildProvisionalCharacteristics(noMatch, noKickboard, campus, anyFeet, rulesAlwaysKnown),
      // Not-yet-saved climbs are drafts by definition; once saved, mirror the
      // tracked row so a published climb doesn't queue as a draft.
      is_draft: savedClimb?.isDraft ?? true,
      published_at: savedClimb?.publishedAt ?? null,
      userAscents: 0,
      userAttempts: 0,
      framesCount: frameCount,
      // 0/null both mean "use the default pace" — useClimbFrames falls back to
      // DEFAULT_PACE_MS whenever framesPace isn't a positive number.
      framesPace: null,
    }),
    [
      name,
      description,
      noMatch,
      noKickboard,
      campus,
      anyFeet,
      rulesAlwaysKnown,
      profile,
      savedClimb,
      board.angle,
      board.boardName,
      board.layoutId,
      board.sizeId,
      t,
      frameCount,
    ],
  );

  // Push the freshly saved climb into the queue as the current climb so the
  // board (and any connected BLE wall) reflects what was just published.
  // Known limitation: re-saving a climb that is ALREADY the active queue item
  // won't refresh its frames via the queue — the reducer short-circuits a
  // same-uuid local SET_CURRENT_CLIMB. The live BLE preview keeps the local
  // wall correct; a mobile queue `updateQueueItem` is the follow-up for peers.
  const syncSavedToQueue = useCallback(
    (uuid: string, frames: string) => {
      setCurrentClimb(climbToQueueItem(buildProvisionalClimb(uuid, frames), { uuid }));
    },
    [buildProvisionalClimb, setCurrentClimb],
  );

  // ---- Set Active: build a minimal Climb and push to the queue. ----
  const handleSetActive = useCallback(() => {
    const framesString = generateFramesString();
    if (!framesString) return;
    // Stop the transport first: a running clock would race the auto-sender's
    // write, and the wall is about to show the whole route rather than a frame.
    playbackPause();
    setHandedOff(true);
    const uuid = savedClimb?.uuid ?? previewUuidRef.current ?? randomUUID();
    setCurrentClimb(climbToQueueItem(buildProvisionalClimb(uuid, framesString), { uuid }));
  }, [generateFramesString, savedClimb, buildProvisionalClimb, setCurrentClimb, playbackPause]);

  // ---- BLE toggle (drives the header lightbulb): connect lights the wall with
  // the current holds; tapping again disconnects. ----
  const handleToggleBle = useCallback(() => {
    if (!bluetooth) return;
    if (!wallMatchesEditor || editSizeMismatch) {
      showToast(t('mobile.create.wallSizeMismatch'), 'info');
      return;
    }
    // Ignore taps while a connect is already running — a second concurrent
    // connect tears down the first attempt's scan and strands the picker.
    if (bluetooth.loading) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect(currentFrameBleString());
  }, [bluetooth, currentFrameBleString, wallMatchesEditor, editSizeMismatch, showToast, t]);

  // ---- Save state machine. ----
  const editLocked = computeEditLocked(savedClimb);
  const canUpdate = computeCanUpdate(savedClimb, board.boardName);

  const saveState: SaveButtonState = useMemo(() => {
    if (!isAuthenticated) return 'login';
    if (isSaving) return 'saving';
    if (justSaved) return 'justSaved';
    if (editLocked) return 'editLocked';
    return 'ready';
  }, [isAuthenticated, isSaving, justSaved, editLocked]);

  // ---- Is my work safe, and where is it? ----
  // Only the PUBLIC transition is gated. Nothing else checks starts and finishes
  // — not the editor, not SaveClimbInputSchema — so without this a one-hold blob
  // is one tap from being a public climb. The draft threshold stays where it is:
  // tightening it would regress every draft that saves today, and a disabled Save
  // with nothing to say is worse than a silent no-op. While this is true, the
  // status line names the missing requirement directly under the button.
  const publishBlocked = !isDraft && hasContent && !canPublish;
  const localPersistenceAvailable = isDraftStorageAvailable();
  const saveFailed = failedSignature !== null && failedSignature === payloadSignature;

  const draftStatus: DraftStatusView | null = useMemo(
    () =>
      deriveDraftStatusView(
        {
          hasContent,
          localPersistenceAvailable,
          hasSavedClimb: savedClimb != null,
          hasUnsavedEdits,
          saveFailed,
          publishBlocked,
        },
        t,
      ),
    [hasContent, localPersistenceAvailable, savedClimb, hasUnsavedEdits, saveFailed, publishBlocked, t],
  );

  // Signal the screen should focus the header name field (e.g. on a save with
  // no name yet). The name input lives in the drawer header, not a settings sheet.
  const [focusNameSignal, setFocusNameSignal] = useState(0);
  const requestFocusName = useCallback(() => setFocusNameSignal((value) => value + 1), []);

  const handleSave = useCallback(async () => {
    if (saveInFlightRef.current || startNewInFlightRef.current) return;
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    if (editLocked) return;
    // Drafts stay cheap; publishing needs a start and a finish.
    if (isDraft ? !canSave : !canPublish) return;
    if (name.trim() === '') {
      requestFocusName();
      return;
    }

    saveInFlightRef.current = true;
    // Stop the transport before the save pushes the climb into the queue — a
    // running clock would race the auto-sender for the wall.
    playbackPause();
    setIsSaving(true);
    setPublishDuplicateError(null);
    // Captured BEFORE the mutation fires. Anything typed during the round trip
    // moves the live signature, and both the slot clear and the "saved" status
    // below check that before acting on a stale result.
    const signatureAtSave = payloadSignatureRef.current;
    const frames = generateFramesString();
    // Encode the no-match marker into the description only at save time, and only
    // on the boards whose wire format uses it. `noMatch` also rides the payload as
    // its own field, which is what the code-driven boards go on.
    const fullDescription = usesNoMatchDescription ? withNoMatch(description, noMatch) : description;
    // The reducer removes OFF-state holds from the map, so key count equals
    // web's `totalHolds` (non-OFF hold count, used in Climb Created events).
    const holdCount = Object.keys(litUpHoldsMap).length;
    // Web sends the human-readable layout name (`boardDetails.layout_name || ''`)
    // for `boardLayout`; mobile only carries the numeric layout id, so resolve it
    // to the same name via the shared board-constants table. PostHog groups by
    // exact value, so the string must match web for these create-climb events.
    const boardLayout = getLayoutName(board.boardName, board.layoutId);
    const characteristics = buildToggleableCharacteristics(noKickboard, campus);
    let nextSavedClimb: SavedClimbSnapshot | null = null;
    try {
      if (canUpdate && savedClimb) {
        const result = await updateClimb({
          uuid: savedClimb.uuid,
          boardType: board.boardName,
          name: name.trim(),
          description: fullDescription,
          frames,
          angle: board.angle,
          // The size the editor painted on. Immutable server-side for a board
          // whose hold ids are size-relative (Woods); sent on every update so the
          // server can reject a mismatch outright instead of rewriting a climb
          // against the wrong wall.
          sizeId: board.sizeId,
          framesCount: frameCount,
          framesPace: 0,
          isDraft,
          characteristics,
          // Explicit booleans, never null: an omitted flag PRESERVES whatever the
          // row has, and the editor's switches are the whole desired state. Sending
          // `false` is how a rule gets turned back off.
          noMatch,
          anyFeet,
        });
        nextSavedClimb = {
          uuid: result.uuid,
          boardType: board.boardName,
          createdAt: result.createdAt ?? savedClimb.createdAt,
          publishedAt: result.publishedAt ?? savedClimb.publishedAt,
          isDraft: result.isDraft,
        };
        setSavedClimb(nextSavedClimb);
        // Match web's schema exactly (create-climb-form.tsx) so PostHog funnels
        // that group by these props line up across platforms. `boardLayout` is the
        // resolved layout NAME (same value web sends), not the numeric id.
        track(SHARED_EVENTS.ClimbUpdated, {
          boardLayout,
          isDraft: result.isDraft,
          holdCount,
        });
        syncSavedToQueue(result.uuid, frames);
      } else {
        const result = await saveClimb({
          layout_id: board.layoutId,
          size_id: board.sizeId,
          name: name.trim(),
          description: fullDescription,
          is_draft: isDraft,
          frames,
          frames_count: frameCount,
          frames_pace: 0,
          angle: board.angle,
          characteristics,
          no_match: noMatch,
          any_feet: anyFeet,
        });
        nextSavedClimb = {
          uuid: result.uuid,
          boardType: board.boardName,
          createdAt: result.createdAt ?? null,
          publishedAt: result.publishedAt ?? null,
          isDraft,
        };
        setSavedClimb(nextSavedClimb);
        // Match web's schema exactly (create-climb-form.tsx). See ClimbUpdated above.
        track(SHARED_EVENTS.ClimbCreated, {
          boardLayout,
          isDraft,
          holdCount,
        });
        syncSavedToQueue(result.uuid, frames);
      }
      // ---- What happens to the on-device working copy. ----
      // A draft-Save used to delete it unconditionally, which is what made "Save,
      // then kill the app" lose everything: autosave was off once a row existed,
      // so nothing ever wrote it back. Now the slot IS the working copy, and only
      // a PUBLISH retires it — under a compare-and-clear, so anything typed during
      // the round trip survives.
      const payloadChangedDuringSave = payloadSignatureRef.current !== signatureAtSave;
      if (isDraft || payloadChangedDuringSave) {
        // The explicit linked write is authoritative. Retire any older debounce
        // first so it cannot finish later and overwrite the server-row link or
        // the payload baseline this save just established.
        await persistAutosaveSlot({
          ...autosaveDraftRef.current,
          savedClimbJson: nextSavedClimb ? JSON.stringify(nextSavedClimb) : undefined,
          savedPayloadSignature: signatureAtSave,
        });
      } else {
        await discardAutosaveSlot();
      }
      setPendingNewClimb(false);
      setFailedSignature(null);
      setSavedSignature(signatureAtSave);
      setSavedSignatureUnknown(false);
      // Refresh the inline Open Drafts table AND the Climbs tab's infinite list
      // so the just-saved climb appears / updates (mirrors useDeleteDraftClimb's
      // key set in lib/graphql/hooks/index.ts — create, edit, and publish-draft
      // all fall through to this same success path).
      void queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['infiniteSearchClimbs'] });
      void queryClient.invalidateQueries({ queryKey: ['searchClimbsCount'] });
      setJustSaved(true);
      showToast(isDraft ? t('mobile.create.save.draftToast') : t('mobile.create.save.publishedToast'), 'success');
      // A publish is commit-and-done — dismiss the drawer so the toast shows
      // over the climbs list (drafts stay open so you can keep editing).
      if (!isDraft) onPublished?.();
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
      justSavedTimerRef.current = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    } catch (err) {
      // Web emits only `{ boardLayout }` for this event (create-climb-form.tsx);
      // match that (resolved layout NAME), plus a mobile-only `error_reason` that
      // doesn't affect any grouping web relies on.
      track(SHARED_EVENTS.ClimbCreateFailed, {
        boardLayout,
        error_reason: isDuplicateClimbError(err) ? 'duplicate' : 'exception',
      });
      if (isDuplicateClimbError(err)) {
        // The inline DuplicateBanner already explains this one and offers the
        // match — the status line would just repeat it.
        setPublishDuplicateError(readDuplicateExtensions(err));
      } else {
        // The toast is gone in 3s. Without a persistent line the editor would go
        // on reading "Saved on this phone" — true, and silent about the account
        // copy never happening. Sticky until the next successful save or an edit.
        setFailedSignature(signatureAtSave);
        showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error');
      }
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }, [
    isAuthenticated,
    router,
    editLocked,
    canSave,
    canPublish,
    name,
    canUpdate,
    savedClimb,
    litUpHoldsMap,
    generateFramesString,
    frameCount,
    updateClimb,
    saveClimb,
    board,
    description,
    noMatch,
    usesNoMatchDescription,
    noKickboard,
    campus,
    anyFeet,
    isDraft,
    autosaveSlotKey,
    discardAutosaveSlot,
    persistAutosaveSlot,
    requestFocusName,
    syncSavedToQueue,
    showToast,
    t,
    queryClient,
    onPublished,
    playbackPause,
  ]);

  const dismissDuplicateError = useCallback(() => setPublishDuplicateError(null), []);

  // Hiding the control is the visible half; this is the other one. A stale render
  // of the action bar, a restored draft that somehow carries two frames, or a
  // future caller reaching the controller directly must not be able to give a
  // single-frame board a second frame — the frames string would then carry a
  // comma, which `getWoodsBluetoothPacket` rejects outright.
  const supportsMultiFrame = boardCapabilities.multiFrameClimbs;
  const guardedDuplicateFrame = useCallback(() => {
    if (!supportsMultiFrame) return;
    handleDuplicateFrame();
  }, [supportsMultiFrame, handleDuplicateFrame]);

  const canSetActive = isValid;

  // ---- Dismissing the sheet. ----
  // No confirm on any of the four dismiss paths (chevron, pan-down, backdrop,
  // hardware back): pan-down is the most-used gesture on this surface and a modal
  // on it is hostile. The autosave flush on unmount already keeps the work, so the
  // only thing missing was saying so — once, and only when the climber could
  // reasonably think it is gone: content exists and there is no row in Open
  // drafts to find it in.
  const dismissNoticeRef = useRef({ hasContent, hasSavedClimb: savedClimb != null, localPersistenceAvailable });
  dismissNoticeRef.current = { hasContent, hasSavedClimb: savedClimb != null, localPersistenceAvailable };
  const notifyDraftKeptOnDismiss = useCallback(() => {
    const notice = dismissNoticeRef.current;
    if (!notice.hasContent || notice.hasSavedClimb || !notice.localPersistenceAvailable) return;
    showToast(t('mobile.create.autosave.keptToast'), 'info');
  }, [showToast, t]);

  return {
    // editor state
    litUpHoldsMap,
    currentFramesString,
    startingCount,
    finishCount,
    isValid,
    canSave,
    canPublish,
    selectedBrush,
    setSelectedBrush,
    handlePaint,
    handleAssignRole,
    handleClearHolds,
    handleNewClimb,
    pendingNewClimb,
    confirmNewClimb,
    blankClimbEpoch,
    cancelNewClimb,
    showAllHolds,
    setShowAllHolds,
    // frames (route/circuit editing)
    frameCount,
    currentFrameIndex,
    duplicateFrame: guardedDuplicateFrame,
    deleteFrame: handleDeleteFrame,
    // route playback (transport)
    playback: playbackControls,
    handedOff,
    // undo/redo (current editing session only)
    undo,
    redo,
    canUndo,
    canRedo,
    // form fields
    name,
    setName,
    description,
    setDescription,
    isDraft,
    setIsDraft,
    noMatch,
    setNoMatch,
    noKickboard,
    setNoKickboard,
    campus,
    setCampus,
    anyFeet,
    setAnyFeet,
    /** False while the tracked climb's MoonBoard method already says "no feet",
     *  which the editor cannot change — the form hides the row rather than
     *  offering a toggle that would contradict the row it is editing. */
    anyFeetAvailable,
    /** Whether this board's climbs can hold more than one frame. Off on Woods,
     *  whose BLE packet builder rejects the comma a second frame introduces. */
    supportsMultiFrame,
    /** True when the climb being edited doesn't belong on this board size — the
     *  screen shows the unavailable state instead of an editor seeded with the
     *  wrong holds. */
    editSizeMismatch,
    // save
    saveState,
    handleSave,
    publishBlocked,
    canSetActive,
    handleSetActive,
    publishDuplicateError,
    dismissDuplicateError,
    focusNameSignal,
    // persistence
    draftStatus,
    notifyDraftKeptOnDismiss,
    // ble
    bleAvailable: !!bluetooth,
    bleConnected,
    bleConnecting: bluetooth?.loading ?? false,
    handleToggleBle,
    // auth (re-export so the screen can render a login affordance if needed)
    isAuthenticated,
    refreshAuthState: auth.refreshAuthState,
  };
}
