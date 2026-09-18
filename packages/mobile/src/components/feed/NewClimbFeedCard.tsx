import { memo, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { ActivityFeedItem, CrewFeedItem } from '@boardsesh/shared-schema';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Card } from '../Card';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { PressableAvatar } from '../PressableAvatar';
import { ClimbListThumbnail } from '../ClimbListThumbnail';
import { SnapCarousel } from '../SnapCarousel';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { newClimbToClimb } from '../../lib/feed/new-climb-to-climb';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { spacing, borderRadius } from '../../theme/tokens';

/** Matches SessionFeedCard's hero media, so the two cards line up in the feed. */
const THUMBNAIL_SIZE = { width: 84, height: 104 };

/**
 * Either shape the crew feed uses for published climbs.
 *
 * The card takes the feed ITEM rather than a climbs array, so its `memo` compares
 * the object React Query already holds. An array built at the call site would be
 * a fresh reference on every list render, and the home feed re-renders the whole
 * list whenever a vote lands.
 */
type NewClimbFeedItem = Extract<CrewFeedItem, { __typename: 'CrewClimbItem' | 'CrewClimbGroupItem' }>;

/** A carousel page: one of the group's climbs, or the link to the rest. */
type Page = { kind: 'climb'; climb: ActivityFeedItem } | { kind: 'see-all'; count: number };

const pageKey = (page: Page, index: number) =>
  page.kind === 'climb' ? (page.climb.climbUuid ?? `climb-${index}`) : 'see-all';

export const NewClimbFeedCard = memo(function NewClimbFeedCard({ item }: { item: NewClimbFeedItem }) {
  const { t } = useTranslation('climbs');
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const { systemColors } = useTheme();
  // The carousel needs a pixel card width, and the card's own width depends on
  // the screen. Measured rather than derived from Dimensions so a split view,
  // a rotation or an iPad pane can't hand it a stale number.
  const [pageWidth, setPageWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const climbs = useMemo(() => (item.__typename === 'CrewClimbGroupItem' ? item.climbs : [item.climb]), [item]);
  const lead = climbs[0];
  const setterUsername = lead?.setterUsername ?? null;
  const total = item.__typename === 'CrewClimbGroupItem' ? Math.max(item.totalCount, climbs.length) : 1;

  const openSetter = useCallback(() => {
    if (setterUsername)
      router.push({ pathname: '/(tabs)/climbs/setter/[username]', params: { username: setterUsername } });
  }, [setterUsername, router]);

  const openClimb = useCallback(
    (entry: ActivityFeedItem) => {
      const climb = newClimbToClimb(entry);
      const board = entry.boardType
        ? renderBoardToPlaylistConfig(entry.boardType, entry.layoutId, entry.renderBoard)
        : null;
      if (!climb || !board) return;
      // `kind: 'climb'`, never `ref`: the feed already holds the frames, so the
      // drawer opens in place instead of pushing the climb redirector and
      // waiting on a round trip for a climb we have. Preview, so browsing a
      // setter's new climbs doesn't rewrite the queue — in a session that would
      // change the current climb for the whole crew.
      openClimbInPlayDrawer(
        {
          kind: 'climb',
          climb,
          boardConfig: {
            boardName: board.boardName,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds.join(','),
            angle: entry.angle ?? 0,
          },
        },
        { openPlayDrawer, router },
        { preview: true },
      );
    },
    [openPlayDrawer, router],
  );

  const pages = useMemo<Page[]>(
    () => [
      ...climbs.map((climb): Page => ({ kind: 'climb', climb })),
      ...(total > climbs.length ? [{ kind: 'see-all' as const, count: total }] : []),
    ],
    [climbs, total],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setPageWidth(event.nativeEvent.layout.width);
  }, []);

  // Hoisted out of renderItem: a fresh style object per row would defeat the
  // memoized page components FlashList recycles.
  const pageStyle = useMemo(() => ({ width: pageWidth }), [pageWidth]);
  const renderPage = useCallback(
    ({ item: page }: { item: Page }) => (
      <View style={pageStyle}>
        {page.kind === 'climb' ? (
          <ClimbHero climb={page.climb} onPress={openClimb} />
        ) : (
          <SeeAllHero count={page.count} onPress={openSetter} />
        )}
      </View>
    ),
    [pageStyle, openClimb, openSetter],
  );

  if (!lead) return null;

  return (
    <View style={styles.wrapper}>
      <Card>
        <View style={styles.header}>
          <PressableAvatar
            userId={lead.actorId}
            uri={lead.actorAvatarUrl}
            name={lead.actorDisplayName ?? setterUsername}
            size={36}
          />
          <View style={styles.headerText}>
            <Text variant="subheadline" style={styles.title} numberOfLines={1}>
              {lead.actorDisplayName ?? setterUsername ?? t('authors.newClimb')}
            </Text>
            {/* One line, count first: the count in a bolder secondary colour, the
                time quieter — the same two-tier treatment the session card uses,
                so the two cards read as one system. */}
            <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1} style={styles.metaLine}>
              <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.statEmphasis}>
                {t('authors.newClimbCount', { count: total })}
              </Text>
              {' · '}
              {formatRelativeTime(lead.createdAt)}
            </Text>
          </View>
        </View>

        <View onLayout={handleLayout} style={styles.heroSlot}>
          {pages.length === 1 || pageWidth === 0 ? (
            // One page needs no list at all, and a nested carousel on every feed
            // row would cost a virtualized list per card for nothing. The
            // unmeasured first frame renders the same hero, so the swap to the
            // carousel changes no layout.
            <ClimbHero climb={lead} onPress={openClimb} />
          ) : (
            <SnapCarousel
              data={pages}
              cardWidth={pageWidth}
              renderItem={renderPage}
              keyExtractor={pageKey}
              onSnapToIndex={setActiveIndex}
              // One page ahead: each live card holds a board render, and a rail
              // of them inside a feed row is the memory the cap exists to bound.
              drawDistance={pageWidth}
              contentStyle={styles.carouselContent}
              accessibilityLabel={t('authors.newClimbCount', { count: total })}
            />
          )}
        </View>

        {pages.length > 1 ? (
          <View style={styles.dots} pointerEvents="none">
            {pages.map((page, index) => (
              <View
                key={pageKey(page, index)}
                style={[
                  styles.dot,
                  {
                    backgroundColor: index === activeIndex ? systemColors.secondaryLabel : systemColors.fill,
                  },
                ]}
              />
            ))}
          </View>
        ) : null}

        <View style={[styles.divider, { backgroundColor: systemColors.separator }]} />
      </Card>
    </View>
  );
});

/** One climb in the card: board art, name, grade on the right, angle and board. */
const ClimbHero = memo(function ClimbHero({
  climb,
  onPress,
}: {
  climb: ActivityFeedItem;
  onPress: (climb: ActivityFeedItem) => void;
}) {
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const board = climb.boardType
    ? renderBoardToPlaylistConfig(climb.boardType, climb.layoutId, climb.renderBoard)
    : null;
  // Fall back to the raw grade name when the climber's preferred system can't
  // express it, rather than dropping the grade — the session card's rule.
  const grade = climb.difficultyName ? (formatGrade(climb.difficultyName) ?? climb.difficultyName) : null;
  // Angle and board are separate elements, not a joined string: an ungraded
  // climb loses the grade slot instead of collapsing into a bare "30°".
  const angle = climb.angle == null ? null : `${climb.angle}°`;
  const boardName = formatBoardDisplayName(climb.boardType ?? '');
  const handlePress = useCallback(() => onPress(climb), [onPress, climb]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={[climb.climbName, grade, angle, boardName].filter(Boolean).join(', ')}
      style={styles.heroPressable}
    >
      <View style={styles.hero}>
        {board && climb.frames ? (
          <ClimbListThumbnail
            frames={climb.frames}
            boardName={board.boardName}
            layoutId={board.layoutId}
            sizeId={board.sizeId}
            setIds={board.setIds.join(',')}
            size={THUMBNAIL_SIZE}
          />
        ) : (
          <View style={[styles.mediaFallback, { backgroundColor: systemColors.fill }]}>
            <Icon name="boards" size={26} color={systemColors.tertiaryLabel} />
          </View>
        )}
        <View style={styles.heroDetails}>
          <View style={styles.nameRow}>
            <Text variant="title3" numberOfLines={2} style={styles.flex}>
              {climb.climbName}
            </Text>
            {grade ? (
              <Text
                variant="title3"
                style={[styles.gradeText, { color: gradeBadgeColor(climb.difficultyName ?? grade) }]}
              >
                {grade}
              </Text>
            ) : null}
          </View>
          {angle ? (
            <Text variant="body" color={systemColors.secondaryLabel} numberOfLines={1}>
              {angle}
            </Text>
          ) : null}
          <Text variant="footnote" color={systemColors.tertiaryLabel} numberOfLines={1}>
            {boardName}
          </Text>
        </View>
      </View>
    </PressableSurface>
  );
});

/** The last page of an over-cap group: the way to the climbs the card dropped. */
const SeeAllHero = memo(function SeeAllHero({ count, onPress }: { count: number; onPress: () => void }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const label = t('authors.seeAllClimbs', { count });

  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.heroPressable}
    >
      <View style={[styles.hero, styles.seeAll]}>
        <Icon name="arrow.right" size={28} color={systemColors.secondaryLabel} />
        <Text variant="headline" color={systemColors.secondaryLabel}>
          {label}
        </Text>
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  title: { fontWeight: '600' },
  metaLine: { marginTop: 2 },
  statEmphasis: { fontWeight: '600' },
  heroSlot: { marginTop: spacing[2] },
  heroPressable: { margin: -spacing[1], padding: spacing[1], borderRadius: borderRadius.md },
  carouselContent: { paddingHorizontal: 0 },
  hero: { flexDirection: 'row', gap: spacing[3], minHeight: THUMBNAIL_SIZE.height },
  seeAll: { alignItems: 'center', justifyContent: 'center', gap: spacing[2] },
  mediaFallback: {
    width: THUMBNAIL_SIZE.width,
    height: THUMBNAIL_SIZE.height,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDetails: { flex: 1, gap: spacing[1], justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  gradeText: { fontWeight: '700' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: spacing[1], marginTop: spacing[2] },
  dot: { width: 6, height: 6, borderRadius: borderRadius.full },
  divider: { height: StyleSheet.hairlineWidth, marginTop: spacing[2] },
  flex: { flex: 1 },
});
