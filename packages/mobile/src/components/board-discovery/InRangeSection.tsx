import { formatBoardDisplayName } from '@boardsesh/board-config';
import { memo, useCallback, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import { BoardSelectorSection } from './BoardSelectorView';
import type { InRangeView, UnnamedInRangeRow } from './in-range-view';

/** Side of the hero's board art, in points. */
const HERO_ART_SIZE = 88;
/** Side of a row's board art, in points. */
const ROW_ART_SIZE = 52;

export type InRangeBoardArtProps = { item: DiscoveryBoardItem; size: number };

export type InRangeSectionProps = {
  view: InRangeView<DiscoveryBoardItem>;
  /** Draws a board's art in a square: the real art in the app, a fixture in stories. */
  BoardArt: ComponentType<InRangeBoardArtProps>;
  /** Continue, Scan and Scan again: asks for Bluetooth when it has to, then scans. */
  onStart: () => void;
  onOpenSettings: () => void;
  onRetryLookup: () => void;
  /** Climb here on the hero, or a tap on a row. */
  onPickBoard: (item: DiscoveryBoardItem) => void;
  /** The three ways forward for a board it heard but cannot name. */
  onUseMyLocation: (row: UnnamedInRangeRow) => void;
  onSearchGyms: (row: UnnamedInRangeRow) => void;
  onOwnBoard: (row: UnnamedInRangeRow) => void;
};

/**
 * The board picker's In range slot: what the phone hears over Bluetooth, first
 * thing on the screen. Presentational: `inRangeView` (in-range-view.ts) decides
 * what shows, and the screen owns the scan, the picks and navigation.
 *
 * The states that are not about a board (Bluetooth off or refused, nothing
 * heard) are one quiet line with one button and no section title, so a climber
 * at home is not shown an empty card on every open.
 */
export function InRangeSection({
  view,
  BoardArt,
  onStart,
  onOpenSettings,
  onRetryLookup,
  onPickBoard,
  onUseMyLocation,
  onSearchGyms,
  onOwnBoard,
}: InRangeSectionProps) {
  const { t } = useTranslation('boards');
  const { content, scanning } = view;

  switch (content.kind) {
    case 'none':
      return null;
    case 'blocked_denied':
      return canOpenAppSettings() ? (
        <QuietLine
          text={t('mobile.inRange.blockedDenied')}
          action={t('mobile.firstBoard.openSettings')}
          onAction={onOpenSettings}
        />
      ) : (
        <QuietLine text={t('mobile.inRange.blockedDenied')} />
      );
    case 'blocked_off':
      return (
        <QuietLine text={t('mobile.inRange.blockedOff')} action={t('mobile.inRange.scanAgain')} onAction={onStart} />
      );
    case 'none_in_range':
      return (
        <QuietLine text={t('mobile.bluetooth.noResults')} action={t('mobile.inRange.scanAgain')} onAction={onStart} />
      );
    default:
      break;
  }

  const caption =
    content.kind === 'board_rows' && content.gymName
      ? t('mobile.inRange.gymWalls', { gym: content.gymName, count: content.boards.length })
      : undefined;

  return (
    <BoardSelectorSection
      title={t('mobile.inRange.title')}
      caption={caption}
      trailing={scanning ? <ActivityIndicator size="small" /> : null}
    >
      <View style={styles.slot}>
        {content.kind === 'permission_card' ? (
          <PromptCard
            title={t('mobile.inRange.permissionTitle')}
            body={t('mobile.inRange.permissionBody')}
            action={t('mobile.inRange.continue')}
            onAction={onStart}
          />
        ) : content.kind === 'tap_to_scan' ? (
          <PromptCard title={t('mobile.inRange.scanTitle')} action={t('mobile.inRange.scan')} onAction={onStart} />
        ) : content.kind === 'looking' ? (
          <LookingCard />
        ) : content.kind === 'hero' ? (
          <HeroCard item={content.board} BoardArt={BoardArt} onPick={onPickBoard} />
        ) : content.kind === 'board_rows' ? (
          <BoardRows items={content.boards} BoardArt={BoardArt} onPick={onPickBoard} />
        ) : content.kind === 'unnamed' ? (
          <UnnamedCard
            row={content.row}
            onUseMyLocation={onUseMyLocation}
            onSearchGyms={onSearchGyms}
            onOwnBoard={onOwnBoard}
          />
        ) : content.kind === 'lookup_failed' ? (
          <LookupFailedCard onRetry={onRetryLookup} />
        ) : null}
      </View>
    </BoardSelectorSection>
  );
}

/** One footnote line and an optional text button, with no section title. */
function QuietLine({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.quietLine} accessibilityLiveRegion="polite">
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.quietText}>
        {text}
      </Text>
      {action && onAction ? <Button title={action} variant="text" size="small" onPress={onAction} /> : null}
    </View>
  );
}

/** "In front of you" with the Bluetooth glyph, in the brand colour. */
function InFrontOfYou() {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  return (
    <View style={styles.inline}>
      <Icon name="bluetooth" size={13} color={brandColors.primary} />
      <Text variant="caption1" color={brandColors.primary}>
        {t('mobile.inRange.inFrontOfYou')}
      </Text>
    </View>
  );
}

/** The Continue card and the Scan card: a question, a reason and one button. */
function PromptCard({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body?: string;
  action: string;
  onAction: () => void;
}) {
  const { systemColors, brandColors } = useTheme();
  return (
    <Card>
      <View style={styles.stack}>
        <View style={styles.inline}>
          <Icon name="bluetooth" size={22} color={brandColors.primary} />
          <Text variant="headline" style={styles.flexText}>
            {title}
          </Text>
        </View>
        {body ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {body}
          </Text>
        ) : null}
        <View style={styles.buttonRow}>
          <Button title={action} size="small" onPress={onAction} />
        </View>
      </View>
    </Card>
  );
}

/**
 * Scanning with nothing heard yet. The same height as the hero, so the board
 * that turns up does not push the screen down.
 */
function LookingCard() {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <Card>
      <View style={styles.heroRow} accessibilityLiveRegion="polite">
        <View style={[styles.heroArt, { backgroundColor: systemColors.tertiaryBackground }]} />
        <View style={styles.heroText}>
          <Text variant="headline" color={systemColors.secondaryLabel}>
            {t('mobile.inRange.lookingTitle')}
          </Text>
          <Text variant="subheadline" color={systemColors.tertiaryLabel}>
            {t('mobile.inRange.lookingBody')}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/**
 * One board the phone can name: its art, its name and Climb here. Climb here is
 * the one control: a pressable card around a native button can fire both, and
 * a pick binds the board.
 */
const HeroCard = memo(function HeroCard({
  item,
  BoardArt,
  onPick,
}: {
  item: DiscoveryBoardItem;
  BoardArt: ComponentType<InRangeBoardArtProps>;
  onPick: (item: DiscoveryBoardItem) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const handlePick = useCallback(() => onPick(item), [item, onPick]);
  return (
    <Card>
      <View style={styles.heroRow}>
        <View style={[styles.heroArt, { backgroundColor: systemColors.tertiaryBackground }]}>
          <BoardArt item={item} size={HERO_ART_SIZE} />
        </View>
        <View style={styles.heroText}>
          <InFrontOfYou />
          <Text variant="headline" numberOfLines={2}>
            {item.title}
          </Text>
          {item.subtitle ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
              {item.subtitle}
            </Text>
          ) : null}
          <View style={styles.buttonRow}>
            <Button title={t('mobile.discovery.menu.climbHere')} size="small" icon="play.fill" onPress={handlePick} />
          </View>
        </View>
      </View>
    </Card>
  );
});

/** Two or more boards the phone can name, closest first, in one rounded block. */
function BoardRows({
  items,
  BoardArt,
  onPick,
}: {
  items: readonly DiscoveryBoardItem[];
  BoardArt: ComponentType<InRangeBoardArtProps>;
  onPick: (item: DiscoveryBoardItem) => void;
}) {
  const { systemColors } = useTheme();
  // A handful of rows at most (the boards one phone hears at once), so a map
  // rather than a list.
  return (
    <View style={[styles.rowsBlock, { backgroundColor: systemColors.secondaryBackground }]}>
      {items.map((item, index) => (
        <View key={item.key}>
          {index > 0 ? <View style={[styles.separator, { backgroundColor: systemColors.separator }]} /> : null}
          <InRangeBoardRowView item={item} closest={index === 0} BoardArt={BoardArt} onPick={onPick} />
        </View>
      ))}
    </View>
  );
}

const InRangeBoardRowView = memo(function InRangeBoardRowView({
  item,
  closest,
  BoardArt,
  onPick,
}: {
  item: DiscoveryBoardItem;
  closest: boolean;
  BoardArt: ComponentType<InRangeBoardArtProps>;
  onPick: (item: DiscoveryBoardItem) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const handlePick = useCallback(() => onPick(item), [item, onPick]);
  const closestLabel = t('mobile.inRange.closest');
  const label = [item.title, item.subtitle, closest ? closestLabel : null].filter(Boolean).join(', ');
  return (
    <PressableSurface onPress={handlePick} accessibilityRole="button" accessibilityLabel={label} style={styles.row}>
      <View style={[styles.rowArt, { backgroundColor: systemColors.tertiaryBackground }]}>
        <BoardArt item={item} size={ROW_ART_SIZE} />
      </View>
      <View style={styles.rowText}>
        <Text variant="body" numberOfLines={1} color={item.isActive ? brandColors.primary : undefined}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      {closest ? (
        <View style={[styles.pill, { backgroundColor: brandColors.primaryFill }]}>
          <Text variant="caption2" color={brandColors.onPrimary}>
            {closestLabel}
          </Text>
        </View>
      ) : null}
    </PressableSurface>
  );
});

/**
 * A board the phone heard but cannot name: what it is, and the three ways to
 * find it. Literal keys per kind: the i18n lint rejects a computed one.
 */
function UnnamedCard({
  row,
  onUseMyLocation,
  onSearchGyms,
  onOwnBoard,
}: {
  row: UnnamedInRangeRow;
  onUseMyLocation: (row: UnnamedInRangeRow) => void;
  onSearchGyms: (row: UnnamedInRangeRow) => void;
  onOwnBoard: (row: UnnamedInRangeRow) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const board = formatBoardDisplayName(row.boardType);
  let title: string;
  let body: string;
  switch (row.kind) {
    case 'moonboard':
      title = t('mobile.inRange.moonboardTitle');
      body = t('mobile.inRange.moonboardBody');
      break;
    case 'bare_name':
      title = t('mobile.inRange.typeTitle', { board });
      body = t('mobile.inRange.bareNameBody');
      break;
    case 'unknown_setup':
      title = t('mobile.inRange.typeTitle', { board });
      body = t('mobile.inRange.unknownSetupBody');
      break;
  }
  return (
    <Card>
      <View style={styles.stack}>
        <InFrontOfYou />
        <Text variant="headline">{title}</Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {body}
        </Text>
        <View style={styles.actionsRow}>
          <Button
            title={t('mobile.inRange.useMyLocation')}
            size="small"
            icon="location"
            onPress={() => onUseMyLocation(row)}
          />
          <Button
            title={t('mobile.inRange.searchGyms')}
            size="small"
            variant="tonal"
            icon="gym"
            onPress={() => onSearchGyms(row)}
          />
        </View>
        <View style={styles.textAction}>
          <Button
            title={t('mobile.bluetooth.ownBoard')}
            size="small"
            variant="text"
            icon="home"
            onPress={() => onOwnBoard(row)}
          />
        </View>
      </View>
    </Card>
  );
}

/** Serials heard but no signal to look them up. */
function LookupFailedCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <Card>
      <View style={styles.stack}>
        <InFrontOfYou />
        <Text variant="headline">{t('mobile.bluetooth.needSignalTitle')}</Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.bluetooth.needSignalBody')}
        </Text>
        <View style={styles.buttonRow}>
          <Button title={t('mobile.errorRetry')} size="small" variant="tonal" icon="refresh" onPress={onRetry} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  slot: {
    paddingHorizontal: spacing[4],
  },
  quietLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    minHeight: 44,
  },
  quietText: {
    flex: 1,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  flexText: {
    flex: 1,
  },
  stack: {
    gap: spacing[2],
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: spacing[1],
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[1],
  },
  textAction: {
    alignItems: 'flex-start',
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  heroArt: {
    width: HERO_ART_SIZE,
    height: HERO_ART_SIZE,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  heroText: {
    flex: 1,
    gap: spacing[1] / 2,
  },
  rowsBlock: {
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[2],
    minHeight: 60,
  },
  rowArt: {
    width: ROW_ART_SIZE,
    height: ROW_ART_SIZE,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  rowText: {
    flex: 1,
    gap: spacing[1] / 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: ROW_ART_SIZE + spacing[3],
  },
  pill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
});
