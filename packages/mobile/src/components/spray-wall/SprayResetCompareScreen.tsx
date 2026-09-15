// "What changed on the wall?" — the review half of a reset (epic #5346, SW-13).
//
// The board under this screen is the NEW photograph (the draft version, put into
// the SW-07 registry by `useSprayWallDraft`), and every ring on it is a claim the
// matcher is making about that picture: this hold is still here, this one has
// gone, this is something new. `proposeSprayWallReset` computes those claims and
// writes nothing, so the owner can disagree with any of them as often as they
// like and only `commitSprayWallVersion` costs anything.
//
// Three things about the design are load-bearing rather than stylistic:
//
//  1. **Every ring is toggleable.** The matcher compares two sets of circles. It
//     is right most of the time and wrong in exactly the cases that matter most —
//     a hold behind a shadow, two holds an inch apart — so a review that could
//     only be accepted or abandoned would be a review in name.
//  2. **A move is a pairing, not a verdict.** A hold unbolted and re-bolted 40 cm
//     left is not the hold a climb used, so it stays one removal and one
//     addition; `movedFromHoldId` records that they are one story, and that is
//     what remix reads months later. It is confirmed ring by ring because
//     assuming it rewrites what a climber is offered.
//  3. **The counts are the header.** "12 kept · 3 removed · 5 new · 4 climbs lose
//     holds" is the whole decision, so it is above the board rather than under
//     it, and the climbs number disappears the moment the owner changes the
//     removal set it was computed for (nothing on the phone can recompute it).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { sprayWallResetApplied, sprayWallResetPreviewed } from '@boardsesh/analytics';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { Text } from '../Text';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SegmentedControl } from '../SegmentedControl';
import { InteractiveFilterBoard } from '../search/InteractiveFilterBoard';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { reportError } from '../../lib/error-reporting';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { getSprayWall, SPRAY_BOARD_NAME, subscribeToSprayWalls } from '../../lib/spray/spray-wall-registry';
import { useSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import { useCommitSprayWallVersion, useSprayWallResetProposal } from '../../lib/spray/use-spray-wall-reset';
import type { SprayHoldCandidate } from '../outline-editor/spray-hold-editor-types';
import { SprayResetSvgLayer } from './SprayResetSvgLayer';
import {
  RESET_RING_FILTERS,
  buildResetCommitDecisions,
  buildResetDetections,
  canPairMove,
  buildResetRingTargets,
  climbsAffectedIsStale,
  emptyResetReviewState,
  holdRingRole,
  resetCompareView,
  resetReviewCounts,
  resetReviewReducer,
  type ResetRingFilter,
  type ResetReviewState,
} from './reset-review-machine';

/** Vertical space the chrome around the board needs — see `SprayHoldEditorScreen`. */
const CHROME_BUDGET = 400;

export type SprayResetCompareScreenProps = {
  wallUuid: string;
  layoutId: number;
  /** The draft version this reset lands as. */
  versionId: string;
  versionNumber: number;
  /** What the detector found in the new photo, in the STORED photo's pixels. */
  candidates: readonly SprayHoldCandidate[];
  /** The reset landed. The flow leaves and the wall re-registers. */
  onCommitted: (summary: {
    keptCount: number;
    removedCount: number;
    addedCount: number;
    climbsChanged: number;
  }) => void;
};

export function SprayResetCompareScreen({
  wallUuid,
  layoutId,
  versionId,
  versionNumber,
  candidates,
  onCommitted,
}: SprayResetCompareScreenProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // Registers the DRAFT under the wall's layout id, so the board below draws the
  // new photograph rather than the published one.
  const { isLoading: draftLoading, isUnavailable, homography } = useSprayWallDraft(layoutId, wallUuid, versionNumber);
  const commit = useCommitSprayWallVersion(layoutId);
  const commitAsync = commit.mutateAsync;

  const wall = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => getSprayWall(layoutId), [layoutId]),
  );

  // One array, used to draw AND to ask. The proposal answers in indices into it,
  // so a second copy built for either purpose would be a second numbering.
  const detections = useMemo(
    () => (homography ? buildResetDetections(candidates, homography) : []),
    [candidates, homography],
  );

  /**
   * No detections means no proposal, and that is a refusal rather than a default.
   *
   * The matcher is comparing two sets of circles. Hand it an empty second set and
   * the honest answer it gives is that every hold on the wall has gone — which,
   * committed, takes the whole wall off and breaks every climb on it. A phone
   * that cannot suggest holds is a phone that cannot review a reset, so the
   * screen says so and offers the way out instead of showing a review whose
   * default is catastrophic.
   */
  const hasDetections = detections.length > 0;

  const proposalInput = useMemo(
    () =>
      homography == null || !hasDetections
        ? null
        : { wallUuid, versionId, detections: detections.map((detection) => detection.canonical) },
    [homography, hasDetections, wallUuid, versionId, detections],
  );
  const proposalQuery = useSprayWallResetProposal(proposalInput);
  const proposal = proposalQuery.data ?? null;

  const aliveHoldIds = useMemo(() => (wall ? wall.holds.map((hold) => hold.id) : []), [wall]);

  const [review, dispatch] = useReducer(resetReviewReducer, undefined, emptyResetReviewState);

  // Seeded once, when the proposal and the wall have BOTH landed — the alive
  // holds come from the registry and the verdicts come from the proposal, and a
  // review seeded from one without the other would show a wall with no rings.
  // Re-seeding is keyed on the draft, which cannot change under this screen, so
  // the owner's verdicts are never thrown away by a refetch.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!proposal || !wall || seededRef.current === versionId) return;
    seededRef.current = versionId;
    dispatch({ type: 'SEED', proposal, aliveHoldIds, detectionCount: detections.length });
    trackSprayEvent(
      sprayWallResetPreviewed({
        keptCount: proposal.kept.length,
        removedCount: proposal.removed.length,
        addedCount: proposal.added.length,
        lowConfidenceCount: proposal.lowConfidence.length,
        climbsAffected: proposal.climbsAffected,
        aspectMismatch: proposal.aspectMismatch,
        detectionCount: detections.length,
      }),
    );
  }, [proposal, wall, versionId, aliveHoldIds, detections.length]);

  const effective = review.seeded ? review : null;

  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [pairingIndex, setPairingIndex] = useState<number | null>(null);

  const counts = useMemo(() => (effective ? resetReviewCounts(effective) : null), [effective]);
  const climbsStale = useMemo(() => (effective ? climbsAffectedIsStale(effective) : false), [effective]);

  const boardRender = useMemo(() => {
    if (!wall) return { width: 0, height: 0 };
    const boardAspect = wall.photoWidth / wall.photoHeight;
    const availableWidth = windowWidth - spacing[4] * 2;
    const availableHeight = Math.max(200, windowHeight - insets.top - insets.bottom - CHROME_BUDGET);
    if (availableWidth / availableHeight > boardAspect) {
      return { width: availableHeight * boardAspect, height: availableHeight };
    }
    return { width: availableWidth, height: availableWidth / boardAspect };
  }, [wall, windowWidth, windowHeight, insets.top, insets.bottom]);

  /**
   * Both kinds of ring as one tap surface.
   *
   * A detection is keyed `-(index + 1)`, so a single number names either side.
   * Hold ids come from a catalogue sequence and are always positive, so the two
   * ranges cannot collide.
   */
  const holdTargets = useMemo<BoardHoldTarget[]>(
    () => (wall && effective ? buildResetRingTargets(wall.holds, detections, effective) : []),
    [wall, effective, detections],
  );

  const handleRingTap = useCallback(
    (key: number) => {
      hapticSelection();
      // Mid-pairing, a tap on a hold that is coming off IS the pairing. Anything
      // else cancels it, rather than leaving the screen in a mode the owner has
      // forgotten they are in.
      if (pairingIndex != null) {
        const index = pairingIndex;
        setPairingIndex(null);
        if (key >= 0 && effective && canPairMove(effective, index, key)) {
          dispatch({ type: 'PAIR_MOVE', index, holdId: key });
          return;
        }
      }
      setSelectedKey((current) => (current === key ? null : key));
    },
    [pairingIndex, effective],
  );

  const handleFilterChange = useCallback((filter: ResetRingFilter) => {
    dispatch({ type: 'SET_FILTER', filter });
    setSelectedKey(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!effective || commit.isPending) return;
    hapticSelection();
    const decisions = buildResetCommitDecisions(effective, detections);
    try {
      const result = await commitAsync({ wallUuid, versionId, ...decisions });
      trackSprayEvent(
        sprayWallResetApplied({
          keptCount: result.keptCount,
          removedCount: result.removedCount,
          addedCount: result.addedCount,
          climbsChanged: result.climbsChanged,
          moveCount: Object.keys(effective.moves).length,
        }),
      );
      onCommitted(result);
    } catch (error) {
      reportError(error);
      showToast(extractGraphqlMessage(error) ?? t('sprayReset.commit.failed'), 'error');
    }
  }, [effective, commit.isPending, commitAsync, detections, wallUuid, versionId, onCommitted, showToast, t]);

  const renderInTransform = useCallback(
    () =>
      wall && effective ? (
        <SprayResetSvgLayer
          holds={wall.holds}
          detections={detections}
          review={effective}
          selectedKey={selectedKey}
          boardWidth={wall.photoWidth}
          boardHeight={wall.photoHeight}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        />
      ) : null,
    [wall, effective, detections, selectedKey, boardRender.width, boardRender.height],
  );

  // One decision, taken in `resetCompareView`, so the ordering that matters —
  // loading before "nothing found" — is a unit test rather than the order of
  // four `if`s in a render.
  const view = resetCompareView({
    draftLoading,
    proposalPending: proposalQuery.isPending,
    candidateCount: candidates.length,
    ready: wall != null && !isUnavailable && homography != null && effective != null && counts != null,
  });

  if (view === 'loading') {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('sprayReset.compare.working')}
        </Text>
      </View>
    );
  }

  if (view === 'no-detections') {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="title3" style={styles.centeredText}>
          {t('sprayReset.compare.noDetections')}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centeredText}>
          {t('sprayReset.compare.noDetectionsBody')}
        </Text>
      </View>
    );
  }

  if (view === 'unavailable' || !wall || !effective || !counts) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="headline" style={styles.centeredText}>
          {proposalQuery.error
            ? (extractGraphqlMessage(proposalQuery.error) ?? t('sprayReset.compare.unavailable'))
            : t('sprayReset.compare.unavailable')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={[styles.header, { borderBottomColor: systemColors.separator }]}>
        <Text variant="headline" accessibilityLiveRegion="polite">
          {t('sprayReset.compare.counts', {
            kept: counts.kept,
            removed: counts.removed,
            added: counts.added,
          })}
        </Text>
        {/* The climbs number is the server's, computed for the removal set the
            PROPOSAL named. Nothing here can recompute it, so when the owner
            changes that set it stops being shown rather than being shown wrong. */}
        {!climbsStale && effective.climbsAffected > 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('sprayReset.compare.climbsAffected', { count: effective.climbsAffected })}
          </Text>
        ) : null}
        {effective.aspectMismatch ? (
          <Text variant="footnote" color={iosSystemColors.systemOrange}>
            {t('sprayReset.compare.aspectWarning')}
          </Text>
        ) : null}
      </View>

      <View style={styles.boardSection}>
        <InteractiveFilterBoard
          boardName={SPRAY_BOARD_NAME}
          layoutId={layoutId}
          sizeId={layoutId}
          setIds=""
          boardWidth={wall.photoWidth}
          boardHeight={wall.photoHeight}
          holdTargets={holdTargets}
          activeHoldId={selectedKey}
          onHoldTap={handleRingTap}
          showHoldMarkers={false}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
          renderInTransform={renderInTransform}
        />
      </View>

      <ScrollView style={styles.controlsScroll} contentContainerStyle={styles.controls}>
        <SegmentedControl
          options={RESET_RING_FILTERS.map((filter) => ({ key: filter, label: filterLabel(filter, counts, t) }))}
          selectedKey={effective.filter}
          onSelect={handleFilterChange}
          accessibilityLabel={t('sprayReset.compare.filterLabel')}
        />

        <SelectedRingActions
          review={effective}
          selectedKey={selectedKey}
          pairingIndex={pairingIndex}
          suggestedMoveHoldId={
            selectedKey != null && selectedKey < 0 ? effective.suggestedMoveByDetection[-selectedKey - 1] : undefined
          }
          onToggleHold={(holdId) => dispatch({ type: 'TOGGLE_HOLD', holdId })}
          onToggleDetection={(index) => dispatch({ type: 'TOGGLE_DETECTION', index })}
          onStartPairing={setPairingIndex}
          onUnpair={(index) => dispatch({ type: 'UNPAIR_MOVE', index })}
          onPair={(index, holdId) => dispatch({ type: 'PAIR_MOVE', index, holdId })}
        />

        {Object.keys(effective.suggestedMoveByDetection).length > 0 ? (
          <Button
            title={t('sprayReset.compare.acceptMoves')}
            variant="text"
            onPress={() => dispatch({ type: 'ACCEPT_SUGGESTED_MOVES' })}
          />
        ) : null}
      </ScrollView>

      <View
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
        <Button
          title={t('sprayReset.compare.confirm')}
          variant="filled"
          size="large"
          onPress={() => void handleConfirm()}
          loading={commit.isPending}
          disabled={commit.isPending}
        />
      </View>
    </View>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function filterLabel(
  filter: ResetRingFilter,
  counts: { kept: number; removed: number; added: number; lowConfidence: number },
  t: Translate,
): string {
  // Literal keys, never `t(variable)` — the i18n linter hard-fails on a dynamic
  // lookup and the orphan scanner needs to see every key spelled out.
  // `value`, not `count`: i18next reads `count` as a plural selector and would
  // look for `_one`/`_other` variants these labels do not have.
  if (filter === 'kept') return t('sprayReset.filter.kept', { value: counts.kept });
  if (filter === 'removed') return t('sprayReset.filter.removed', { value: counts.removed });
  if (filter === 'new') return t('sprayReset.filter.new', { value: counts.added });
  if (filter === 'lowConfidence') return t('sprayReset.filter.unsure', { value: counts.lowConfidence });
  return t('sprayReset.filter.all');
}

type SelectedRingActionsProps = {
  review: ResetReviewState;
  selectedKey: number | null;
  pairingIndex: number | null;
  suggestedMoveHoldId: number | undefined;
  onToggleHold: (holdId: number) => void;
  onToggleDetection: (index: number) => void;
  onStartPairing: (index: number | null) => void;
  onUnpair: (index: number) => void;
  onPair: (index: number, holdId: number) => void;
};

/**
 * What can be done to the ring under the finger.
 *
 * One panel rather than a per-ring popover: on a wall with six hundred holds a
 * popover would spend the whole screen, and the verdicts are the same three
 * everywhere.
 */
function SelectedRingActions({
  review,
  selectedKey,
  pairingIndex,
  suggestedMoveHoldId,
  onToggleHold,
  onToggleDetection,
  onStartPairing,
  onUnpair,
  onPair,
}: SelectedRingActionsProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  if (pairingIndex != null) {
    return (
      <View style={[styles.panel, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="subheadline">{t('sprayReset.pairing.prompt')}</Text>
        <Button title={t('sprayReset.pairing.cancel')} variant="text" onPress={() => onStartPairing(null)} />
      </View>
    );
  }

  if (selectedKey == null) {
    return (
      <View style={[styles.panel, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('sprayReset.compare.tapHint')}
        </Text>
      </View>
    );
  }

  if (selectedKey >= 0) {
    const role = holdRingRole(review, selectedKey);
    if (!role) return null;
    return (
      <View style={[styles.panel, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="subheadline">
          {role === 'removed'
            ? t('sprayReset.hold.removed', { id: selectedKey })
            : role === 'lowConfidence'
              ? t('sprayReset.hold.unsure', { id: selectedKey })
              : t('sprayReset.hold.kept', { id: selectedKey })}
        </Text>
        <Button
          title={role === 'removed' ? t('sprayReset.hold.stillHere') : t('sprayReset.hold.gone')}
          variant="tonal"
          onPress={() => onToggleHold(selectedKey)}
        />
      </View>
    );
  }

  const index = -selectedKey - 1;
  const verdict = review.detectionVerdicts[index];
  const pairedHoldId = review.moves[index];
  return (
    <View style={[styles.panel, { backgroundColor: systemColors.secondaryBackground }]}>
      <Text variant="subheadline">
        {verdict === 'added' ? t('sprayReset.detection.new') : t('sprayReset.detection.rejected')}
      </Text>
      {pairedHoldId != null ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('sprayReset.pairing.paired', { id: pairedHoldId })}
          </Text>
          <Button title={t('sprayReset.pairing.unpair')} variant="text" onPress={() => onUnpair(index)} />
        </>
      ) : null}
      <Button
        title={verdict === 'added' ? t('sprayReset.detection.reject') : t('sprayReset.detection.accept')}
        variant="tonal"
        onPress={() => onToggleDetection(index)}
      />
      {verdict === 'added' && pairedHoldId == null ? (
        <>
          {suggestedMoveHoldId != null && canPairMove(review, index, suggestedMoveHoldId) ? (
            <Button
              title={t('sprayReset.pairing.useSuggestion', { id: suggestedMoveHoldId })}
              variant="text"
              onPress={() => onPair(index, suggestedMoveHoldId)}
            />
          ) : null}
          <Button title={t('sprayReset.pairing.start')} variant="text" onPress={() => onStartPairing(index)} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    padding: spacing[4],
  },
  centeredText: {
    textAlign: 'center',
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    gap: spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsScroll: {
    flexGrow: 0,
  },
  controls: {
    padding: spacing[4],
    gap: spacing[3],
  },
  panel: {
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    gap: spacing[2],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
