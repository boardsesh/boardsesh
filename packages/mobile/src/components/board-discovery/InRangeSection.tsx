import { formatBoardDisplayName } from '@boardsesh/board-config';
import { memo, useCallback, useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { canOpenAppSettings } from '../../lib/open-app-settings';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { ArtRow } from '../ArtRow';
import { BoardThumbnailView } from '../boards/BoardThumbnail';
import { Button } from '../Button';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { InsetGroupedList } from '../InsetGroupedList';
import { SHELF_SECTION_GAP, ShelfSection } from '../ShelfHeader';
import { Text } from '../Text';
import { TextAction } from '../TextAction';
import type { BoardCardMenuAction, BoardCardMenuCapabilities, BoardCardMenuVia } from './board-card-menu';
import type { BluetoothOffFix } from './bluetooth-radio';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import { BoardRowList } from './BoardRowList';
import type { DiscoveryBoardArtProps } from './DiscoveryBoardArt';
import {
  AT_GYM_COLLAPSED_ROW_COUNT,
  type PickerScanNotice,
  type PickerTopView,
  type UnnamedInRangeRow,
} from './picker-top-view';

/** Side of the hero's art slot, in points: the board fits inside at its own aspect. */
const HERO_ART_SIZE = 80;

/**
 * What to say when the scan heard nothing and Android is plausibly
 * withholding its results (see `useAndroidScanLocationHint`): grant location
 * on old binaries, or turn Location on on Android 6 to 11. The action rescans
 * when it works.
 */
export type InRangeLocationHint = {
  kind: 'grant_location' | 'enable_location_services';
  busy: boolean;
  onPress: () => void;
};

export type InRangeSectionProps = {
  view: PickerTopView<DiscoveryBoardItem>;
  /** Draws a board's art in its slot: the real thumbnail in the app, a fixture in stories. */
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
  /** Continue, Allow Bluetooth, Scan and Scan again: asks for Bluetooth when it has to, then scans. */
  onStart: () => void;
  onOpenSettings: () => void;
  /** What "Bluetooth is off" offers on this platform (`bluetoothOffFix`). */
  bluetoothOffFix: BluetoothOffFix;
  /** Turn on Bluetooth, on the Android line: the system's dialog. */
  onTurnOnBluetooth: () => void;
  /** Not now on the Bluetooth card: the card becomes one line from then on. Absent: no Not now. */
  onBluetoothNotNow?: () => void;
  onRetryLookup: () => void;
  /** Climb here on the hero, or a tap on a row At {gym} (with its place as drawn). */
  onPickBoard: (item: DiscoveryBoardItem, position?: number) => void;
  /** The three ways forward for a board it heard but cannot name. */
  onUseMyLocation: (row: UnnamedInRangeRow) => void;
  onSearchGyms: (row: UnnamedInRangeRow) => void;
  onOwnBoard: (row: UnnamedInRangeRow) => void;
  /** Shown when the scan heard nothing and Android hides the results; null otherwise. */
  locationHint?: InRangeLocationHint | null;
  /** The card menu At {gym}'s rows offer, as Your boards does. Absent: plain rows. */
  atGymMenuCapabilities?: BoardCardMenuCapabilities;
  onAtGymMenuAction?: (
    item: DiscoveryBoardItem,
    action: BoardCardMenuAction,
    via: BoardCardMenuVia,
    position: number,
  ) => void;
  /** The At {gym} rows that are the climber's own or followed boards: the only ones with a menu. */
  atGymMenuKeys?: ReadonlySet<string>;
  /** "See gym" on the At {gym} shelf: the gym's page. Absent draws no action. */
  onSeeGym?: (gymUuid: string) => void;
};

/** The notices that are one quiet line rather than a card. */
type QuietNotice = Extract<
  PickerScanNotice,
  { kind: 'permission_line' | 'blocked_denied' | 'blocked_off' | 'unreachable' }
>;

function isQuietNotice(notice: PickerScanNotice | null): notice is QuietNotice {
  return (
    notice?.kind === 'permission_line' ||
    notice?.kind === 'blocked_denied' ||
    notice?.kind === 'blocked_off' ||
    notice?.kind === 'unreachable'
  );
}

/** The scan's own card under "In range": Continue, Scan, or need signal on its own. */
function isNoticeCard(notice: PickerScanNotice | null): boolean {
  return (
    notice?.kind === 'permission_card' ||
    notice?.kind === 'tap_to_scan' ||
    (notice?.kind === 'lookup_failed' && !notice.besideHeardBoards)
  );
}

function hasInRangeSection(view: PickerTopView<DiscoveryBoardItem>): boolean {
  return isNoticeCard(view.notice) || view.unnamed !== null || view.content.kind === 'looking';
}

/**
 * The top of the board picker. Presentational: `decidePickerTop` and
 * `buildPickerTopView` (picker-top-view.ts) decide what shows, and the screen
 * owns the scan, the picks and navigation. Top to bottom, each a shelf of the
 * picker's own spacing:
 * - the scan's quiet line (Bluetooth not allowed after Not now, off, refused or
 *   unreachable), with no title, so a climber at home is not shown an empty
 *   card;
 * - the Android location hint, when the scan heard nothing because of it;
 * - the one board heard somewhere else (the hero), with Climb here, no title;
 * - "In range": the scan's own card (Continue, Scan, need signal), the box it
 *   cannot name, or one row's worth of placeholder while it looks;
 * - "At {gym}": the gym's walls A to Z, the board you're on among them. A box
 *   it cannot name is above it when the board you're on named the gym: the
 *   scan heard something the gym's list doesn't say.
 */
export function InRangeSection({
  view,
  BoardArt,
  onStart,
  onOpenSettings,
  bluetoothOffFix,
  onTurnOnBluetooth,
  onBluetoothNotNow,
  onRetryLookup,
  onPickBoard,
  onUseMyLocation,
  onSearchGyms,
  onOwnBoard,
  locationHint = null,
  atGymMenuCapabilities,
  onAtGymMenuAction,
  atGymMenuKeys,
  onSeeGym,
}: InRangeSectionProps) {
  const { t } = useTranslation('boards');
  const { notice, content, unnamed, scanning, heardNothing } = view;
  const needSignalBeside = notice?.kind === 'lookup_failed' && notice.besideHeardBoards;
  // One spinner while the scan listens, by the title of what it is filling.
  const spinner = scanning ? <ActivityIndicator size="small" /> : undefined;

  return (
    <>
      {isQuietNotice(notice) ? (
        <View style={styles.block}>
          <QuietNoticeLine
            notice={notice}
            bluetoothOffFix={bluetoothOffFix}
            onStart={onStart}
            onOpenSettings={onOpenSettings}
            onTurnOnBluetooth={onTurnOnBluetooth}
          />
        </View>
      ) : null}
      {heardNothing && locationHint ? (
        <View style={styles.block}>
          <LocationHintBlock hint={locationHint} />
        </View>
      ) : null}
      {content.kind === 'hero' ? (
        <View style={[styles.gutter, styles.stack, styles.block]}>
          <HeroCard
            item={content.board}
            inFrontOfYou={content.strongestSignal}
            BoardArt={BoardArt}
            onPick={onPickBoard}
          />
          {needSignalBeside ? <NeedSignalRow onRetry={onRetryLookup} /> : null}
        </View>
      ) : null}
      {hasInRangeSection(view) ? (
        <ShelfSection title={t('mobile.inRange.title')} trailing={content.kind === 'at_gym' ? undefined : spinner}>
          <View style={[styles.gutter, styles.stack]}>
            {notice?.kind === 'permission_card' ? (
              <PromptCard
                title={t('mobile.inRange.permissionTitle')}
                body={t('mobile.inRange.permissionBody')}
                action={t('mobile.inRange.continue')}
                onAction={onStart}
                secondaryAction={onBluetoothNotNow ? t('mobile.inRange.notNow') : undefined}
                onSecondaryAction={onBluetoothNotNow}
              />
            ) : notice?.kind === 'tap_to_scan' ? (
              <PromptCard title={t('mobile.inRange.scanTitle')} action={t('mobile.inRange.scan')} onAction={onStart} />
            ) : notice?.kind === 'lookup_failed' && !notice.besideHeardBoards ? (
              <LookupFailedCard onRetry={onRetryLookup} />
            ) : null}
            {content.kind === 'looking' ? <LookingRow /> : null}
            {unnamed !== null ? (
              <UnnamedCard
                // A card left on one box's actions closes when another box takes its place.
                key={unnamed.key}
                row={unnamed}
                onUseMyLocation={onUseMyLocation}
                onSearchGyms={onSearchGyms}
                onOwnBoard={onOwnBoard}
              />
            ) : null}
          </View>
        </ShelfSection>
      ) : null}
      {content.kind === 'at_gym' ? (
        <ShelfSection
          title={t('mobile.inRange.atGym', { gym: content.gymName })}
          action={
            onSeeGym
              ? {
                  label: t('mobile.gyms.seeGym'),
                  accessibilityLabel: t('mobile.gyms.seeGymAria', { gym: content.gymName }),
                  onPress: () => onSeeGym(content.gymUuid),
                }
              : undefined
          }
          trailing={spinner}
        >
          <BoardRowList
            // Keyed by the gym, so Show all closes when the top moves to another gym.
            key={content.gymUuid}
            items={content.rows}
            onSelect={onPickBoard}
            menuCapabilities={atGymMenuCapabilities}
            onMenuAction={onAtGymMenuAction}
            menuKeys={atGymMenuKeys}
            collapsedRowCount={AT_GYM_COLLAPSED_ROW_COUNT}
            alwaysShownKeys={content.heardKeys}
            BoardArt={BoardArt}
            testID="picker-at-gym"
          />
          {needSignalBeside ? (
            <View style={[styles.gutter, styles.afterList]}>
              <NeedSignalRow onRetry={onRetryLookup} />
            </View>
          ) : null}
        </ShelfSection>
      ) : null}
    </>
  );
}

/**
 * Bluetooth not allowed (after Not now), off, refused for good or unreachable:
 * one quiet line and the button that can fix it. The line opens the page and a
 * shelf header follows 28pt below, whose action leans up: this one leans up
 * too, into the page's top.
 *
 * Off leads with the fix: Turn on Bluetooth on Android (the system's dialog),
 * the Control Center hint on iOS, which has no way to turn it on for you. The
 * scan starts by itself once the radio is on; iOS keeps Scan again in case it
 * doesn't.
 */
function QuietNoticeLine({
  notice,
  bluetoothOffFix,
  onStart,
  onOpenSettings,
  onTurnOnBluetooth,
}: {
  notice: QuietNotice;
  bluetoothOffFix: BluetoothOffFix;
  onStart: () => void;
  onOpenSettings: () => void;
  onTurnOnBluetooth: () => void;
}) {
  const { t } = useTranslation('boards');
  switch (notice.kind) {
    case 'permission_line':
      return (
        <EmptyState
          size="quiet"
          title={t('mobile.inRange.permissionLine')}
          actions={<TextAction reach="up" label={t('mobile.inRange.allowBluetooth')} onPress={onStart} />}
        />
      );
    case 'blocked_denied':
      return (
        <EmptyState
          size="quiet"
          title={t('mobile.inRange.blockedDenied')}
          actions={
            canOpenAppSettings() ? (
              <TextAction reach="up" label={t('mobile.firstBoard.openSettings')} onPress={onOpenSettings} />
            ) : undefined
          }
        />
      );
    case 'blocked_off':
      return bluetoothOffFix === 'turn_on' ? (
        <EmptyState
          size="quiet"
          title={t('mobile.inRange.blockedOffTitle')}
          actions={<TextAction reach="up" label={t('mobile.inRange.turnOnBluetooth')} onPress={onTurnOnBluetooth} />}
        />
      ) : (
        <EmptyState
          size="quiet"
          title={t('mobile.inRange.blockedOffControlCenter')}
          actions={<TextAction reach="up" label={t('mobile.inRange.scanAgain')} onPress={onStart} />}
        />
      );
    case 'unreachable':
      return (
        <EmptyState
          size="quiet"
          title={t('mobile.inRange.unreachable')}
          actions={<TextAction reach="up" label={t('mobile.inRange.scanAgain')} onPress={onStart} />}
        />
      );
  }
}

/**
 * Android is withholding what the scan heard: say why and offer the fix, in
 * the device picker's own words. Literal keys per kind: the i18n lint rejects a
 * computed one.
 */
function LocationHintBlock({ hint }: { hint: InRangeLocationHint }) {
  const { t } = useTranslation('settings');
  const grant = hint.kind === 'grant_location';
  return (
    <View style={styles.hintBlock} accessibilityLiveRegion="polite">
      <Text variant="footnote" tone="secondary">
        {grant ? t('ble.locationHintTitle') : t('ble.locationServicesHintTitle')}
      </Text>
      <Text variant="caption1" tone="secondary">
        {grant ? t('ble.locationHintBody') : t('ble.locationServicesHintBody')}
      </Text>
      <View style={styles.textAction}>
        <Button
          title={grant ? t('ble.locationHintGrant') : t('ble.locationServicesHintEnable')}
          variant="text"
          size="small"
          loading={hint.busy}
          onPress={hint.onPress}
        />
      </View>
    </View>
  );
}

/**
 * "In front of you" with the Bluetooth glyph, in secondary label: it says
 * where, it does nothing. "Nearby" when a box was heard louder than this board:
 * the climber may be standing at that one.
 */
function InFrontOfYou({ nearby = false }: { nearby?: boolean }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <View style={styles.inline}>
      <Icon name="bluetooth" size={13} color={systemColors.secondaryLabel} />
      <Text variant="caption1" tone="secondary">
        {nearby ? t('mobile.inRange.nearby') : t('mobile.inRange.inFrontOfYou')}
      </Text>
    </View>
  );
}

/** The Continue card and the Scan card: a question, a reason, one button and, on Continue, Not now. */
function PromptCard({
  title,
  body,
  action,
  onAction,
  secondaryAction,
  onSecondaryAction,
}: {
  title: string;
  body?: string;
  action: string;
  onAction: () => void;
  secondaryAction?: string;
  onSecondaryAction?: () => void;
}) {
  const { systemColors } = useTheme();
  return (
    <Card>
      <View style={styles.stack}>
        <View style={styles.inline}>
          <Icon name="bluetooth" size={22} color={systemColors.secondaryLabel} />
          <Text variant="headline" style={styles.flexText}>
            {title}
          </Text>
        </View>
        {body ? (
          <Text variant="subheadline" tone="secondary">
            {body}
          </Text>
        ) : null}
        <View style={styles.promptActions}>
          <Button title={action} size="small" onPress={onAction} />
          {secondaryAction && onSecondaryAction ? (
            <TextAction label={secondaryAction} onPress={onSecondaryAction} />
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const LOOKING_ART = <BoardThumbnailView size="regular" aspectRatio={null} placeholder="boards" art={null} />;

/**
 * Scanning with no gym known yet, or while the serial lookup is out: one row
 * of an inset list, the height a board row will take, so what turns up does
 * not push the screen down much.
 */
function LookingRow() {
  const { t } = useTranslation('boards');
  return (
    <View accessibilityLiveRegion="polite">
      <InsetGroupedList>
        <ArtRow
          art={LOOKING_ART}
          artSize="regular"
          titleVariant="body"
          title={t('mobile.inRange.lookingTitle')}
          subtitle={t('mobile.inRange.lookingBody')}
        />
      </InsetGroupedList>
    </View>
  );
}

/**
 * One board the phone can name, somewhere other than the board you're on: its
 * art, its name and Climb here. Climb here is the one control and the one
 * filled button: a pressable card around a native button can fire both, and a
 * pick binds the board.
 */
const HeroCard = memo(function HeroCard({
  item,
  inFrontOfYou,
  BoardArt,
  onPick,
}: {
  item: DiscoveryBoardItem;
  /** No box was heard louder: "In front of you", else "Nearby". */
  inFrontOfYou: boolean;
  BoardArt: ComponentType<DiscoveryBoardArtProps>;
  onPick: (item: DiscoveryBoardItem, position?: number) => void;
}) {
  const { t } = useTranslation('boards');
  const handlePick = useCallback(() => onPick(item), [item, onPick]);
  return (
    <Card>
      <View style={styles.heroRow}>
        <View style={styles.heroArt}>
          <BoardArt item={item} size={HERO_ART_SIZE} />
        </View>
        <View style={styles.heroText}>
          <InFrontOfYou nearby={!inFrontOfYou} />
          <Text variant="headline" numberOfLines={2}>
            {item.title}
          </Text>
          {item.subtitle ? (
            <Text variant="subheadline" tone="secondary" numberOfLines={1}>
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

type UnnamedActionsProps = {
  onUseMyLocation: (row: UnnamedInRangeRow) => void;
  onSearchGyms: (row: UnnamedInRangeRow) => void;
  onOwnBoard: (row: UnnamedInRangeRow) => void;
};

/**
 * A board the phone heard but cannot name, with no gym known: what it is, and
 * the three ways to find it. Literal keys per kind: the i18n lint rejects a
 * computed one.
 */
function UnnamedCard({
  row,
  onUseMyLocation,
  onSearchGyms,
  onOwnBoard,
}: UnnamedActionsProps & { row: UnnamedInRangeRow }) {
  const { t } = useTranslation('boards');
  const { fontScale } = useWindowDimensions();
  const pairedButtonStyle = useMemo(() => ({ height: pairedButtonHeight(fontScale) }), [fontScale]);
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
        <Text variant="subheadline" tone="secondary">
          {body}
        </Text>
        <View style={styles.actionsRow}>
          <Button
            title={t('mobile.inRange.useMyLocation')}
            size="small"
            icon="location"
            style={pairedButtonStyle}
            onPress={() => onUseMyLocation(row)}
          />
          <Button
            title={t('mobile.inRange.searchGyms')}
            size="small"
            variant="tonal"
            icon="gym"
            style={pairedButtonStyle}
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

/**
 * Serials the lookup could not name, beside boards the scan did name: one
 * compact line with Retry under them.
 */
function NeedSignalRow({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <View style={[styles.needSignalRow, { backgroundColor: systemColors.secondaryBackground }]}>
      <Text variant="subheadline" tone="secondary" style={styles.flexText}>
        {t('mobile.inRange.alsoNeedSignal')}
      </Text>
      <TextAction label={t('mobile.errorRetry')} onPress={onRetry} />
    </View>
  );
}

/** Serials heard but no signal to look them up, with nothing named beside them. */
function LookupFailedCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('boards');
  return (
    <Card>
      <View style={styles.stack}>
        <InFrontOfYou />
        <Text variant="headline">{t('mobile.bluetooth.needSignalTitle')}</Text>
        <Text variant="subheadline" tone="secondary">
          {t('mobile.bluetooth.needSignalBody')}
        </Text>
        <View style={styles.buttonRow}>
          <Button title={t('mobile.errorRetry')} size="small" variant="tonal" icon="refresh" onPress={onRetry} />
        </View>
      </View>
    </Card>
  );
}

/** The unnamed card's button pair at the default text size: the 44pt tap target. */
const PAIRED_BUTTON_HEIGHT = 44;
/** A small button's label line: footnote's 18pt on iOS, labelLarge's 20dp on Material. The larger. */
const SMALL_BUTTON_LABEL_LINE = 20;

/**
 * The one height of the unnamed card's two buttons. A filled and a tonal button
 * measure differently from the same label (each native style pads its own way),
 * and a button that measures itself can't be stretched to its neighbour's
 * height: its native host writes its own height back over the row's. So both
 * are pinned: 44pt, plus a label line for each step of text size past the
 * default, always at least the taller button's own height. The labels are
 * never capped; the pin grows with them.
 */
function pairedButtonHeight(fontScale: number): number {
  return Math.round(PAIRED_BUTTON_HEIGHT + SMALL_BUTTON_LABEL_LINE * (Math.max(1, fontScale) - 1));
}

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: spacing[4],
  },
  // A block with no shelf header still keeps the shelves' rhythm below it.
  block: {
    paddingBottom: SHELF_SECTION_GAP,
  },
  afterList: {
    paddingTop: spacing[2],
  },
  hintBlock: {
    paddingHorizontal: spacing[4],
    gap: spacing[1],
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
  promptActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[3],
    marginTop: spacing[1],
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: {
    flex: 1,
    gap: spacing[1] / 2,
  },
  needSignalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    minHeight: 44,
  },
});
