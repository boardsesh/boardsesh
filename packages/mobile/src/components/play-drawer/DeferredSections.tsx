import { PressableSurface } from '../PressableSurface';
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useLogbook } from '@boardsesh/board-react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { deriveAngleTickCounts, deriveOtherAngleActivity } from './logbook-summary';
import { deriveCrewCounts } from './climber-logs';
import { CollapsibleSection } from '../CollapsibleSection';
import { Icon } from '../Icon';
import { LogbookSection } from './LogbookSection';
import { ClimberLogsSection } from './ClimberLogsSection';
import { SimilarClimbsSection } from './SimilarClimbsSection';
import { CommunitySection } from './CommunitySection';
import { BoardseshGradeSection } from './BoardseshGradeSection';
import { buildBoardseshGradeView, buildBoardseshGradeSummary } from './boardsesh-grade-utils';
import { buildAngleGradeBars, type AngleGradeBar } from './community-utils';
import { rankBySizeCompatibility } from './similar-climbs-utils';
import { BetaVideosSection } from './BetaVideosSection';
import { SetterNotesSection } from './SetterNotesSection';
import { ActiveHoldsSection } from './ActiveHoldsSection';
import { useAuth } from '../../providers/auth-provider';
import { useBoardseshGradeEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import {
  useBetaLinks,
  useBoardseshGrade,
  useClimbLogsPreview,
  useClimbStatsHistory,
  useFollowingClimbLogs,
} from '../../lib/graphql/hooks';
import { useSimilarClimbs } from '../../lib/graphql/hooks/use-similar-climbs';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useFollowedAuthorsSnapshot } from '../../lib/graphql/hooks/use-followed-authors';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getDifficultyIdForGradeName } from '../../lib/grade-label';
import { spacing, borderRadius } from '../../theme/tokens';
import { useDeferredAfterInteractions } from '../../hooks/use-deferred-after-interactions';
import { useClimbSettled } from '../../hooks/use-climb-settled';
import { BETA_SHELF_SECTION_KEY } from '../../lib/beta-shelf-collapse';
import { useSectionExpanded } from '../../lib/section-expand-store';
import {
  DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  DEFAULT_PLAY_DRAWER_SECTIONS,
  type BelowFoldSectionId,
  type PlayDrawerSectionsVisibility,
} from '../../lib/play-drawer-sections-preference';
import { visiblePlayDrawerSections } from './play-drawer-sections';

type DeferredSectionsProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  enabled: boolean;
  contentEnabled: boolean;
  sections?: PlayDrawerSectionsVisibility;
  /** The climber's order for the sections below the fold. */
  order?: readonly BelowFoldSectionId[];
  /** What the board paints (the playback frame on an animated climb), for Active holds. Defaults to the climb's frames. */
  activeHoldsFrames?: string;
  onSimilarClimbPress: (climb: Climb) => void;
  /** Reports the measured height of the first visible section header (drives the play
   *  drawer's first-screen reserve so the header teases at the bottom of the fold). */
  onFirstSectionHeaderLayout?: (height: number) => void;
  /** Reports the measured height of the whole first section (header + expanded
   *  body). Lets the play drawer scroll a deliberate expand fully into view. */
  onFirstSectionLayout?: (height: number) => void;
  /** Fires when the user taps to expand/collapse the first section (not on mount), with
   *  the new state — the play drawer scrolls the section into view on expand. */
  onFirstSectionToggle?: (expanded: boolean) => void;
  /** Opens the "share your beta" sheet. Rendered as the Beta Videos header "+" for
   *  signed-in users; absent (undefined) hides it. */
  onAddBetaVideo?: () => void;
  /** Opens the full-history sheet from the Logbook card's "See full logbook" row. */
  onOpenFullLogbook?: () => void;
  /** Opens the full list from the Climber logs card's "See all logs" row. */
  onOpenClimberLogs?: () => void;
  /** Opens a climber's profile from a Climber logs row. */
  onOpenClimberProfile?: (userId: string) => void;
  /** Opens climber search from the Climber logs card's empty states. */
  onFindClimbers?: () => void;
};

const noop = () => {};

/**
 * The sections whose collapsed line needs a request, with the expand state their
 * header starts in. Shared by the header and the peek's request gate, so the gate
 * reads the same saved state the header shows.
 */
const LINE_SECTION_EXPANSION = {
  betaVideos: { persistKey: BETA_SHELF_SECTION_KEY, defaultExpanded: true },
  boardseshGrade: { persistKey: 'boardseshGrade', defaultExpanded: true },
  community: { persistKey: 'community', defaultExpanded: true },
  similarClimbs: { persistKey: 'similarClimbs', defaultExpanded: false },
} as const satisfies Partial<Record<BelowFoldSectionId, { persistKey: string; defaultExpanded: boolean }>>;
type LineSectionId = keyof typeof LINE_SECTION_EXPANSION;
function isLineSection(sectionId: BelowFoldSectionId | undefined): sectionId is LineSectionId {
  return sectionId !== undefined && sectionId in LINE_SECTION_EXPANSION;
}

/**
 * Sends the request for everyone's newest logs on a climb and renders nothing.
 * Its own component so the query's state changes re-render this, not the whole
 * of DeferredSections, which never reads the answer.
 */
const ClimbLogsPreviewRequest = memo(function ClimbLogsPreviewRequest({
  boardName,
  climbUuid,
  enabled,
}: {
  boardName: BoardName;
  climbUuid: string;
  enabled: boolean;
}) {
  useClimbLogsPreview({ boardName, climbUuid, enabled });
  return null;
});

/**
 * Asks for the similar climbs while Similar climbs is the peek at the fold, and
 * hands back its collapsed line: the name its first card would show, that none
 * matched, or that the board needs downloading first. Mounted only then, so a
 * Similar climbs section further down asks for nothing. Same hook and key as the
 * section's own read, so expanding it costs no request.
 */
const SimilarClimbsPeekRequest = memo(function SimilarClimbsPeekRequest({
  boardName,
  layoutId,
  sizeId,
  climbUuid,
  angle,
  onAnswer,
}: {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  climbUuid: string;
  angle: number;
  onAnswer: (answer: SimilarClimbsPeek) => void;
}) {
  const { t } = useTranslation('session');
  const scope = useMemo(() => ({ boardName, layoutId, sizeId }), [boardName, layoutId, sizeId]);
  const { data: similarClimbs, source, isResolvingSource } = useSimilarClimbs(scope, climbUuid, angle);
  const closestName = similarClimbs ? (rankBySizeCompatibility(similarClimbs, sizeId)[0]?.climb.name ?? null) : null;
  // No answer yet: no line at all, never a spinner.
  const line = similarClimbs
    ? closestName
      ? t('mobile.similarClimbs.collapsedSummary', { name: closestName })
      : t('mobile.similarClimbs.collapsedEmpty')
    : source === 'download' && !isResolvingSource
      ? t('mobile.similarClimbs.collapsedDownload')
      : null;
  useEffect(() => {
    if (line !== null) onAnswer({ climbUuid, angle, line });
  }, [climbUuid, angle, line, onAnswer]);
  return null;
});

type SimilarClimbsPeek = { climbUuid: string; angle: number; line: string };

/**
 * Below-fold deferred content for the play drawer.
 * Uses InteractionManager.runAfterInteractions() to defer rendering
 * until after the drawer open animation completes, preventing jank.
 */
export const DeferredSections = memo(function DeferredSections({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  enabled,
  contentEnabled,
  sections = DEFAULT_PLAY_DRAWER_SECTIONS,
  order = DEFAULT_PLAY_DRAWER_SECTION_ORDER,
  activeHoldsFrames,
  onSimilarClimbPress,
  onFirstSectionHeaderLayout,
  onFirstSectionLayout,
  onFirstSectionToggle,
  onAddBetaVideo,
  onOpenFullLogbook,
  onOpenClimberLogs,
  onOpenClimberProfile,
  onFindClimbers,
}: DeferredSectionsProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { isAuthenticated } = useAuth();
  const { brandColors } = useTheme();
  const { gradeFormat } = useGradeFormat();
  const boardseshGradeEnabled = useBoardseshGradeEnabled();
  const visibleSections = useMemo(
    () =>
      visiblePlayDrawerSections({
        sections,
        order,
        isAuthenticated,
        boardseshGradeEnabled,
        description: climb.description,
        screenshotMode: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
      }),
    [sections, order, isAuthenticated, boardseshGradeEnabled, climb.description],
  );
  const visibleSectionSet = useMemo(() => new Set(visibleSections), [visibleSections]);
  const firstSectionId = visibleSections[0];

  const handleAddBetaVideoPress = useCallback(() => {
    void Haptics.selectionAsync();
    onAddBetaVideo?.();
  }, [onAddBetaVideo]);

  const handleFirstSectionLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onFirstSectionLayout?.(event.nativeEvent.layout.height);
    },
    [onFirstSectionLayout],
  );
  // Defer the JS-heavy below-fold sections until just after the drawer's open
  // animation and only after the user has started scrolling below the fold.
  // The first visible header is the scroll hint at the bottom of the first
  // screen and must measure immediately, even when Logbook is hidden.
  // Re-defers per climb (resetKey = uuid) and — unlike a bare
  // runAfterInteractions — falls back to a bounded timeout, so a starved
  // interaction queue can't leave these sections blank until the drawer reopens.
  const readyToRender = useDeferredAfterInteractions(enabled && contentEnabled, climb.uuid);

  // A section is on screen when it is the peek at the fold, or once the climber
  // has scrolled to the sections. Only then may it read anything: a section
  // further down mounts nothing and asks for nothing until it can be seen.
  const isOnScreen = (sectionId: BelowFoldSectionId) =>
    enabled && visibleSectionSet.has(sectionId) && (firstSectionId === sectionId || readyToRender);
  const showLogbook = isOnScreen('logbook');
  // The Climber logs card straight under a Logbook peek (the default layout)
  // keeps the head start it has always had: the crew read behind the Logbook
  // line decides whether the card's rows are needed at all.
  const showClimberLogs =
    isOnScreen('climberLogs') || (enabled && firstSectionId === 'logbook' && visibleSections[1] === 'climberLogs');
  const crewWanted = showLogbook || showClimberLogs;
  // MoonBoard and Woods carry no crowd grade, so the Boardsesh-grade and
  // stats-history queries below have nothing to answer with — skip them for
  // both. (BoardseshGradeSection gates its own by-angle query the same way.)
  const noCrowdGrade = !getBoardCapabilities(boardName).crowdGrade;
  // The peek may ask for what its collapsed line needs, once the climb has
  // settled (a fast swipe asks for nothing), and only while it is collapsed: an
  // open header draws no line. Its saved state must have loaded first, so a cold
  // store never sends a request on the default's guess. Any other section's line
  // comes from what is already cached, or stays empty: no spinner in a header.
  const peekLineExpansion = isLineSection(firstSectionId) ? LINE_SECTION_EXPANSION[firstSectionId] : undefined;
  const { expanded: peekSavedExpanded, loaded: expandStateLoaded } = useSectionExpanded(peekLineExpansion?.persistKey);
  const peekCollapsed =
    peekLineExpansion !== undefined && expandStateLoaded && !(peekSavedExpanded ?? peekLineExpansion.defaultExpanded);
  const peekLineFetches = peekCollapsed && (firstSectionId !== 'boardseshGrade' || !noCrowdGrade);

  // The climber's ticks for this climb across every angle. Fed to the summary's
  // cross-angle clause below. Reading it here is eager (one fetch per climb on
  // open), but React Query dedupes it with LogbookSection's identical fetch, so
  // it never doubles up; it stays empty until it lands, and the summary just
  // drops the clause meanwhile.
  const { logbook } = useLogbook(showLogbook ? boardName : null, showLogbook ? [climb.uuid] : []);
  const { otherAngleActivity, angleTickCounts } = useMemo(() => {
    const entriesForClimb = logbook.filter((entry) => entry.climb_uuid === climb.uuid);
    return {
      otherAngleActivity: deriveOtherAngleActivity(entriesForClimb, angle),
      angleTickCounts: deriveAngleTickCounts(entriesForClimb, angle),
    };
  }, [logbook, climb.uuid, angle]);

  // Logs on this climb from the climbers the viewer follows. Fetched ahead of
  // the scroll gate because the collapsed Logbook line above the fold mentions
  // them, but only once the open animation has settled, the climber has stayed
  // on the climb for a moment (a fast queue swipe sends nothing) and the phone's
  // own followed-authors snapshot says there is someone to ask about. An account
  // that follows nobody never sends this request; everyone's newest logs are
  // asked for instead, behind the same settle gate (`settled` is also handed
  // to ClimberLogsSection, for its own copies of both queries). The
  // snapshot is only read here: the root sync bridge keeps it fresh, so opening
  // the drawer costs no followed-authors request and no SQLite write. A missing
  // one loads behind the same settle gate.
  const settled = useClimbSettled(enabled && (crewWanted || peekLineFetches), climb.uuid);
  const peekMayFetch = (sectionId: LineSectionId) =>
    enabled && firstSectionId === sectionId && peekLineFetches && settled;
  // What a climber's own grade is compared against: only one that differs is worth a mention.
  const climbGradeId = getDifficultyIdForGradeName(climb.difficulty);
  const { data: followedAuthors, isError: followedAuthorsFailed } = useFollowedAuthorsSnapshot({
    loadWhenMissing: crewWanted && isAuthenticated && settled,
  });
  const followState: 'none' | 'some' | 'unknown' | 'none-yet' = followedAuthors
    ? followedAuthors.users.length > 0
      ? 'some'
      : 'none'
    : followedAuthorsFailed
      ? 'unknown'
      : 'none-yet';
  const { data: crewLogs } = useFollowingClimbLogs(boardName, climb.uuid, {
    enabled: crewWanted && isAuthenticated && settled && (followState === 'some' || followState === 'unknown'),
  });
  // Everyone else's newest logs, for the Climber logs card's fall-through rows.
  // The card mounts only once the climber scrolls, so asking from there starts
  // the request late. Asked from here instead (`ClimbLogsPreviewRequest`, in the
  // tree below), under the card's own rule: only once it is known that nobody
  // followed has logged the climb. `none` knows at the settle gate; the rest
  // wait for the followed-climbers answer above, and a failed or blocked one
  // sends nothing. So a climb costs one request when somebody followed logged
  // it, never a second one whose rows the card would not show. Same hook and
  // key as the card's read: React Query sends one request for both, and the
  // card alone decides whether the rows may show.
  const isOffline = useIsOffline();
  const everyoneLogsWanted =
    showClimberLogs &&
    isAuthenticated &&
    settled &&
    !isOffline &&
    followState !== 'none-yet' &&
    (followState === 'none' || crewLogs?.summary.climberCount === 0);
  // A disabled query still hands back what it cached, so an account that has
  // since unfollowed everyone must not keep a crew mention from that answer.
  const crew = useMemo(
    () => (followState === 'none' ? null : deriveCrewCounts(crewLogs, angle)),
    [followState, crewLogs, angle],
  );

  // The one-line summary on the collapsed Logbook header — the scroll hint the
  // user peeks at the fold. The current-angle counts read the denormalised
  // userAscents/userAttempts (both angle-scoped, disjoint), so the line renders
  // and measures instantly. Prefixed with the board's angle, then — once the
  // logbook lands — a concise clause flags other angles the climb was sent or
  // only tried at (a send always leads; 3+ angles collapse to a count).
  // Neither source is complete, so each count is the larger of the two. The
  // denormalised counts are a snapshot from when the list was fetched: a tick
  // logged from this drawer is missing, which left the header on "not tried
  // yet". The logbook has that tick the moment it is saved (even before its own
  // fetch lands, or offline when it never does), but it is the server's view,
  // so it lacks a tick still waiting in the outbox that the local list counted.
  const logbookSummary = useMemo(() => {
    // Logged-out visitors have no logbook, so "not tried yet" would be a lie —
    // show no subtitle at all. The section body carries the sign-in line instead
    // (LogbookSection's signed-out branch).
    if (!isAuthenticated) return null;
    const sends = Math.max(climb.userAscents ?? 0, angleTickCounts.sends);
    const attempts = Math.max(climb.userAttempts ?? 0, angleTickCounts.attempts);
    const sendsLabel = t('mobile.logbook.sendCount', { count: sends });
    const attemptsLabel = t('mobile.logbook.attemptCount', { count: attempts });
    let body: string;
    if (sends > 0 && attempts > 0)
      body = t('mobile.logbook.summarySendsAndAttempts', { sends: sendsLabel, attempts: attemptsLabel });
    else if (sends > 0) body = sendsLabel;
    // Attempts but no send yet — the "how often did I fight this" case, named as
    // unfinished business to invite the return.
    else if (attempts > 0) body = t('mobile.logbook.summaryAttemptsNoSend', { attempts: attemptsLabel });
    else body = t('mobile.logbook.summaryUntried');

    const line = t('mobile.logbook.summaryAnglePrefix', { angle, body });
    // Followed climbers who sent it at this angle. The climber's own status
    // stays first, so the one-line clamp never cuts it.
    const lead =
      crew && crew.sendersAtAngle > 0
        ? t('mobile.logbook.summaryWithCrew', {
            body: line,
            crew: t('mobile.logbook.crewSent', { count: crew.sendersAtAngle }),
          })
        : line;

    const { sentAngles, triedAngles } = otherAngleActivity;
    const formatAngles = (angles: number[]) => angles.map((otherAngle) => `${otherAngle}°`).join(', ');
    // At most 2 angles inline, then collapse to a count so the one line stays
    // scannable. A send elsewhere is the achievement, so its clause leads.
    const sentClause =
      sentAngles.length === 0
        ? null
        : sentAngles.length <= 2
          ? t('mobile.logbook.otherAnglesSent', { angles: formatAngles(sentAngles) })
          : t('mobile.logbook.otherAnglesSentCount', { count: sentAngles.length });
    const triedClause =
      triedAngles.length === 0
        ? null
        : triedAngles.length <= 2
          ? t('mobile.logbook.otherAnglesTried', { angles: formatAngles(triedAngles) })
          : t('mobile.logbook.otherAnglesTriedCount', { count: triedAngles.length });
    const clause = [sentClause, triedClause].filter(Boolean).join(' · ');

    return clause ? t('mobile.logbook.summaryWithOtherAngles', { body: lead, clause }) : lead;
  }, [isAuthenticated, angleTickCounts, climb.userAscents, climb.userAttempts, angle, otherAngleActivity, crew, t]);

  const climberLogsSummary = useMemo(
    () =>
      crew
        ? t('mobile.climberLogs.collapsedSummary', {
            logged: t('mobile.climberLogs.collapsedLogged', { count: crew.climbers }),
            sent: t('mobile.climberLogs.sentCount', { count: crew.senders }),
          })
        : null,
    [crew, t],
  );

  // Grade shown next to the collapsed Boardsesh grade header. Lifted up here
  // (rather than read from BoardseshGradeSection) because that section
  // unmounts while collapsed — React Query dedupes this fetch with the
  // section's identical-key one once it expands, so this costs no extra request.
  const boardseshReady =
    boardseshGradeEnabled &&
    visibleSectionSet.has('boardseshGrade') &&
    !noCrowdGrade &&
    ((enabled && readyToRender) || peekMayFetch('boardseshGrade'));
  const { data: boardseshGrade } = useBoardseshGrade(boardName, climb.uuid, angle, {
    enabled: boardseshReady,
  });
  // The crowd grade at this angle turns the teaser into the correction "V4 ▸ V3+ ✓".
  // React Query dedupes this with CommunitySection's identical fetch, so it costs
  // no extra request; it stays null until loaded and the teaser drops the "V4 ▸".
  // Also read for Community's line ("most sends at 40°"); asked for only by the
  // Boardsesh grade above or a Community peek, otherwise the cached answer.
  const { data: history } = useClimbStatsHistory(boardName, climb.uuid, {
    enabled: boardseshReady || peekMayFetch('community'),
  });
  const boardseshSummary = useMemo(() => {
    const view = buildBoardseshGradeView(boardName, boardseshGrade ?? null, gradeFormat);
    const crowdLabel =
      buildAngleGradeBars(history, gradeFormat, boardName).find((bar) => bar.angle === angle)?.gradeName ?? null;
    return buildBoardseshGradeSummary(view, { crowdLabel, localWord: tClimbs('boardseshGrade.summaryLocal') });
  }, [boardName, boardseshGrade, gradeFormat, history, angle, tClimbs]);

  // Community's collapsed line: the angle most climbers sent it at.
  const communitySummary = useMemo(() => {
    const busiest = buildAngleGradeBars(history, gradeFormat, boardName).reduce<AngleGradeBar | null>(
      (best, bar) => (bar.sends > (best?.sends ?? 0) ? bar : best),
      null,
    );
    return busiest ? t('mobile.community.collapsedSummary', { angle: busiest.angle }) : null;
  }, [history, gradeFormat, boardName, t]);

  // Beta Videos' collapsed line: how many there are, so an empty shelf is never
  // opened for nothing. Same hook and key as the shelf, which reads it on open.
  const { data: betaLinks } = useBetaLinks(boardName, climb.uuid, peekMayFetch('betaVideos') && !isOffline);
  const betaVideosSummary = betaLinks
    ? betaLinks.length > 0
      ? t('mobile.betaVideos.videoCount', { count: betaLinks.length })
      : t('mobile.betaVideos.collapsedEmpty')
    : null;

  // Similar climbs' collapsed line: the closest match by name.
  const [similarPeek, setSimilarPeek] = useState<SimilarClimbsPeek | null>(null);
  const similarSummary =
    similarPeek && similarPeek.climbUuid === climb.uuid && similarPeek.angle === angle ? similarPeek.line : null;

  // One wrapper per section, in the climber's order. The first visible header
  // mounts at once so there is always a reachable scroll hint at the fold; every
  // other section, Logbook included when it is not first, waits for real
  // scrolling and the interaction defer. Heavy bodies wait for both.
  const renderSection = useCallback(
    (sectionId: BelowFoldSectionId) => {
      const isFirst = firstSectionId === sectionId;
      if (!readyToRender && !isFirst) return null;
      const onHeaderLayout = isFirst ? onFirstSectionHeaderLayout : undefined;
      const onToggle = isFirst ? onFirstSectionToggle : undefined;
      let section: ReactNode;
      switch (sectionId) {
        case 'activeHolds':
          // Reads only the frames: nothing to fetch, so it may draw as the peek at once.
          section = (
            <ActiveHoldsSection
              boardName={boardName}
              layoutId={layoutId}
              frames={activeHoldsFrames ?? climb.frames}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            />
          );
          break;
        case 'logbook':
          section = (
            <CollapsibleSection
              title={t('mobile.logbook.title')}
              summary={logbookSummary}
              persistKey="logbook"
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            >
              <LogbookSection
                climbUuid={climb.uuid}
                boardName={boardName}
                layoutId={layoutId}
                angle={angle}
                userAscents={climb.userAscents}
                userAttempts={climb.userAttempts}
                onOpenFullLogbook={onOpenFullLogbook}
              />
            </CollapsibleSection>
          );
          break;
        case 'climberLogs':
          section = (
            <CollapsibleSection
              title={t('mobile.climberLogs.title')}
              summary={climberLogsSummary}
              defaultExpanded
              persistKey="climberLogs"
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            >
              {readyToRender && followState !== 'none-yet' && (
                <ClimberLogsSection
                  climbUuid={climb.uuid}
                  boardName={boardName}
                  angle={angle}
                  climbGradeId={climbGradeId}
                  followState={followState}
                  settled={settled}
                  onSeeAll={onOpenClimberLogs ?? noop}
                  onPressClimber={onOpenClimberProfile ?? noop}
                  onFindClimbers={onFindClimbers ?? noop}
                />
              )}
            </CollapsibleSection>
          );
          break;
        case 'setterNotes':
          section = (
            <SetterNotesSection
              description={climb.description}
              contentEnabled={readyToRender}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            />
          );
          break;
        case 'betaVideos':
          section = (
            <CollapsibleSection
              title={t('mobile.betaVideos.title')}
              summary={betaVideosSummary}
              defaultExpanded={LINE_SECTION_EXPANSION.betaVideos.defaultExpanded}
              persistKey={LINE_SECTION_EXPANSION.betaVideos.persistKey}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
              headerAction={
                isAuthenticated && onAddBetaVideo ? (
                  <PressableSurface
                    onPress={handleAddBetaVideoPress}
                    accessibilityRole="button"
                    accessibilityLabel={t('mobile.betaVideos.addButton')}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.addButton,
                      pressed && { backgroundColor: `${brandColors.primary}1A` },
                    ]}
                  >
                    <Icon name="add" size={22} color={brandColors.primary} />
                  </PressableSurface>
                ) : undefined
              }
            >
              {readyToRender && <BetaVideosSection climbUuid={climb.uuid} boardName={boardName} />}
            </CollapsibleSection>
          );
          break;
        case 'boardseshGrade':
          section = (
            <CollapsibleSection
              title={tClimbs('boardseshGrade.title')}
              summary={boardseshSummary}
              defaultExpanded={LINE_SECTION_EXPANSION.boardseshGrade.defaultExpanded}
              persistKey={LINE_SECTION_EXPANSION.boardseshGrade.persistKey}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            >
              {readyToRender && <BoardseshGradeSection climbUuid={climb.uuid} boardName={boardName} angle={angle} />}
            </CollapsibleSection>
          );
          break;
        case 'community':
          section = (
            <CollapsibleSection
              title={t('mobile.community.title')}
              summary={communitySummary}
              defaultExpanded={LINE_SECTION_EXPANSION.community.defaultExpanded}
              persistKey={LINE_SECTION_EXPANSION.community.persistKey}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            >
              {readyToRender && (
                <CommunitySection
                  climbUuid={climb.uuid}
                  boardName={boardName}
                  layoutId={layoutId}
                  angle={angle}
                  qualityAverage={climb.quality_average}
                  ascensionistCount={climb.ascensionist_count}
                  isHidden={climb.is_hidden === true}
                />
              )}
            </CollapsibleSection>
          );
          break;
        case 'similarClimbs':
          section = (
            <CollapsibleSection
              title={t('mobile.similarClimbs.title')}
              summary={similarSummary}
              defaultExpanded={LINE_SECTION_EXPANSION.similarClimbs.defaultExpanded}
              persistKey={LINE_SECTION_EXPANSION.similarClimbs.persistKey}
              onHeaderLayout={onHeaderLayout}
              onToggle={onToggle}
            >
              {readyToRender && (
                <SimilarClimbsSection
                  climbUuid={climb.uuid}
                  boardName={boardName}
                  layoutId={layoutId}
                  sizeId={sizeId}
                  setIds={setIds}
                  angle={angle}
                  onClimbPress={onSimilarClimbPress}
                />
              )}
            </CollapsibleSection>
          );
          break;
        default:
          // A new id in BELOW_FOLD_SECTION_IDS stops compiling here until it gets a case,
          // instead of drawing an empty wrapper. At run time it draws nothing.
          sectionId satisfies never;
          return null;
      }
      return (
        <View key={sectionId} onLayout={isFirst ? handleFirstSectionLayout : undefined}>
          {section}
        </View>
      );
    },
    [
      firstSectionId,
      readyToRender,
      onFirstSectionHeaderLayout,
      onFirstSectionToggle,
      handleFirstSectionLayout,
      t,
      tClimbs,
      climb,
      activeHoldsFrames,
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      logbookSummary,
      climberLogsSummary,
      betaVideosSummary,
      boardseshSummary,
      communitySummary,
      similarSummary,
      followState,
      climbGradeId,
      settled,
      isAuthenticated,
      brandColors.primary,
      onAddBetaVideo,
      handleAddBetaVideoPress,
      onOpenFullLogbook,
      onOpenClimberLogs,
      onOpenClimberProfile,
      onFindClimbers,
      onSimilarClimbPress,
    ],
  );

  if (!enabled || visibleSections.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      {showClimberLogs && (
        <ClimbLogsPreviewRequest boardName={boardName} climbUuid={climb.uuid} enabled={everyoneLogsWanted} />
      )}
      {peekMayFetch('similarClimbs') && (
        <SimilarClimbsPeekRequest
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          climbUuid={climb.uuid}
          angle={angle}
          onAnswer={setSimilarPeek}
        />
      )}
      {visibleSections.map(renderSection)}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[4],
  },
  addButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
  },
});
