// The gym page's blocks, one per list cell. Each reads its own theme and copy,
// so the screen's `renderItem` depends on the data and one actions object only.

import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { SHELF_SECTION_GAP, ShelfHeader, ShelfSection, SHELF_HEADER_CONTENT_GAP } from '../ShelfHeader';
import { StatusPill } from '../StatusPill';
import { Text } from '../Text';
import { TextAction } from '../TextAction';
import type {
  GymClaimCard,
  GymInfoRow,
  GymPageViewModel,
  GymRunByLine,
  GymRunByPill,
  GymStaffTool,
  GymStartRow,
} from './gym-page-view-model';
import { gymWebsiteLabel } from './gym-page-view-model';

/** Everything a block can do, handed to every block as one stable object. */
export type GymPageActions = {
  onOpenAddress: () => void;
  onClaim: () => void;
  onSignIn: () => void;
  onStartRow: (row: GymStartRow) => void;
  onStaffTool: (tool: GymStaffTool) => void;
  onInfoRow: (row: GymInfoRow) => void;
  onSetUpBoard: () => void;
  onRetryBoards: () => void;
  onReport: () => void;
};

// --- the top block ---

function usePillLabel(pill: GymRunByPill): string {
  const { t } = useTranslation('boards');
  switch (pill) {
    case 'runByGym':
      return t('runBy.pillRunByGym');
    case 'climberListed':
      return t('runBy.pillClimberListed');
    case 'unclaimed':
      return t('runBy.pillUnclaimed');
    case 'youOwner':
      return t('runBy.pillYouOwner');
    case 'youAdmin':
      return t('runBy.pillYouAdmin');
    case 'youEditor':
      return t('runBy.pillYouEditor');
  }
}

function useRunByLine(line: GymRunByLine, gymName: string): string | null {
  const { t } = useTranslation('boards');
  switch (line.kind) {
    case 'staff':
      return t('runBy.lineStaff', { gym: gymName });
    case 'climber':
      return line.name ? t('runBy.lineClimber', { name: line.name }) : t('runBy.lineClimberHidden');
    case 'unclaimed':
      return t('runBy.lineUnclaimed');
    case 'none':
      return null;
  }
}

/**
 * Name, address (a tap opens maps) and who runs the gym: the run-by pill and
 * its one line, and "Run this gym? Claim it" where a claim is open.
 */
export const GymPageTopBlock = memo(function GymPageTopBlock({
  gym,
  model,
  canOpenAddress,
  actions,
}: {
  gym: Pick<Gym, 'name' | 'address'>;
  model: GymPageViewModel;
  canOpenAddress: boolean;
  actions: GymPageActions;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const pillLabel = usePillLabel(model.pill);
  const line = useRunByLine(model.runByLine, gym.name);
  const address = gym.address?.trim() || null;
  return (
    <View style={styles.top}>
      <Text variant="title1" emphasized accessibilityRole="header">
        {gym.name}
      </Text>
      {address ? (
        canOpenAddress ? (
          <PressableSurface
            onPress={actions.onOpenAddress}
            feedback="opacity"
            accessibilityRole="link"
            accessibilityHint={t('mobile.gymPage.addressHint')}
            style={styles.address}
          >
            <Icon name="location" size={15} color={systemColors.accent} />
            <Text variant="subheadline" color={systemColors.accent} style={styles.addressText}>
              {address}
            </Text>
          </PressableSurface>
        ) : (
          <Text variant="subheadline" tone="secondary" style={styles.addressPlain}>
            {address}
          </Text>
        )
      ) : null}
      <View style={styles.runBy}>
        <StatusPill label={pillLabel} tone={model.pillTone} testID="gym-page-run-by-pill" />
        {line ? (
          <Text variant="subheadline" tone="secondary">
            {line}
          </Text>
        ) : null}
        {model.inlineClaim ? (
          <View style={styles.inlineClaim}>
            <TextAction
              label={t('runBy.claimInline')}
              onPress={model.claimCard === 'signIn' ? actions.onSignIn : actions.onClaim}
              reach="down"
              testID="gym-page-claim-inline"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});

// --- rows ---

/**
 * One row of a small inset group: a glyph, a label and a chevron, or ↗ when it
 * leaves the app for the website (with the hint saying so).
 */
const GymLinkRow = memo(function GymLinkRow({
  icon,
  label,
  external,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  external?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      rippleColor={systemColors.label as string}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={label}
      accessibilityHint={external ? t('mobile.gymPage.opensWebsite') : undefined}
      style={insetGroupedRowStyles.row}
      testID={testID}
    >
      <View style={insetGroupedRowStyles.leading}>
        <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      </View>
      <Text variant="body" color={systemColors.label} style={insetGroupedRowStyles.text}>
        {label}
      </Text>
      <Icon
        name={external ? 'open.external' : 'chevron.right'}
        size={external ? 15 : 16}
        color={systemColors.tertiaryLabel}
      />
    </PressableSurface>
  );
});

const START_ICONS: Record<GymStartRow, IconName> = { boards: 'boards', hours: 'clock', tv: 'tv' };
const TOOL_ICONS: Record<GymStaffTool, IconName> = {
  editDetails: 'edit',
  nearbyBoards: 'location',
  kiosks: 'tv',
  insights: 'chart.bar',
};

function useStartLabel(row: GymStartRow): string {
  const { t } = useTranslation('boards');
  switch (row) {
    case 'boards':
      return t('mobile.gymPage.startBoards');
    case 'hours':
      return t('mobile.gymPage.startHours');
    case 'tv':
      return t('mobile.gymPage.startTv');
  }
}

function useToolLabel(tool: GymStaffTool): string {
  const { t } = useTranslation('boards');
  switch (tool) {
    case 'editDetails':
      return t('mobile.gymPage.editDetails');
    case 'nearbyBoards':
      return t('mobile.gymPage.nearbyBoards');
    case 'kiosks':
      return t('mobile.gymPage.kiosks');
    case 'insights':
      return t('gymReporting.title');
  }
}

const StartRow = memo(function StartRow({ row, onPress }: { row: GymStartRow; onPress: (row: GymStartRow) => void }) {
  const label = useStartLabel(row);
  const handlePress = useCallback(() => onPress(row), [onPress, row]);
  return (
    <GymLinkRow
      icon={START_ICONS[row]}
      label={label}
      external={row === 'tv'}
      onPress={handlePress}
      testID={`gym-page-start-${row}`}
    />
  );
});

const ToolRow = memo(function ToolRow({
  tool,
  onPress,
}: {
  tool: GymStaffTool;
  onPress: (tool: GymStaffTool) => void;
}) {
  const label = useToolLabel(tool);
  const handlePress = useCallback(() => onPress(tool), [onPress, tool]);
  return (
    <GymLinkRow
      icon={TOOL_ICONS[tool]}
      label={label}
      external={tool === 'nearbyBoards' || tool === 'kiosks'}
      onPress={handlePress}
      testID={`gym-page-tool-${tool}`}
    />
  );
});

/** "Start here": at most three steps for staff who have just started running the gym. */
export const GymStartHereSection = memo(function GymStartHereSection({
  rows,
  actions,
}: {
  rows: readonly GymStartRow[];
  actions: GymPageActions;
}) {
  const { t } = useTranslation('boards');
  return (
    <ShelfSection title={t('mobile.gymPage.startTitle')} testID="gym-page-start">
      <View style={styles.gutter}>
        <InsetGroupedList>
          {rows.map((row) => (
            <StartRow key={row} row={row} onPress={actions.onStartRow} />
          ))}
        </InsetGroupedList>
      </View>
    </ShelfSection>
  );
});

/** Staff tools: details and analytics in the app, board and TV management on the website. */
export const GymStaffToolsSection = memo(function GymStaffToolsSection({
  tools,
  actions,
}: {
  tools: readonly GymStaffTool[];
  actions: GymPageActions;
}) {
  const { t } = useTranslation('boards');
  return (
    <ShelfSection title={t('mobile.gymPage.staffTitle')} testID="gym-page-staff">
      <View style={styles.gutter}>
        <InsetGroupedList>
          {tools.map((tool) => (
            <ToolRow key={tool} tool={tool} onPress={actions.onStaffTool} />
          ))}
        </InsetGroupedList>
      </View>
    </ShelfSection>
  );
});

// --- boards ---

/** The Boards shelf's header, with the count once the list is in. */
export const GymBoardsHeader = memo(function GymBoardsHeader({ count }: { count: number | null }) {
  const { t } = useTranslation('boards');
  return (
    <View style={styles.boardsHeader}>
      <ShelfHeader
        title={t('mobile.gymPage.boardsTitle')}
        caption={count !== null && count > 0 ? t('mobile.gyms.boardCount', { count }) : undefined}
        testID="gym-page-boards-header"
      />
    </View>
  );
});

export const GymBoardsLoading = memo(function GymBoardsLoading() {
  return (
    <View style={styles.boardsState}>
      <ActivityIndicator />
    </View>
  );
});

export const GymBoardsError = memo(function GymBoardsError({ actions }: { actions: GymPageActions }) {
  const { t } = useTranslation('boards');
  return (
    <View style={styles.sectionEnd}>
      <EmptyState
        size="quiet"
        title={t('mobile.gymPage.boardsError')}
        actions={<TextAction label={t('mobile.gymPage.boardsRetry')} onPress={actions.onRetryBoards} />}
      />
    </View>
  );
});

export const GymBoardsEmpty = memo(function GymBoardsEmpty({ actions }: { actions: GymPageActions }) {
  const { t } = useTranslation('boards');
  return (
    <View style={styles.boardsState}>
      <EmptyState
        size="section"
        icon="boards"
        title={t('mobile.gymPage.emptyBoardsTitle')}
        body={t('mobile.gymPage.emptyBoardsBody')}
        actions={<Button title={t('mobile.gymPage.emptyBoardsAction')} onPress={actions.onSetUpBoard} />}
        testID="gym-page-boards-empty"
      />
    </View>
  );
});

// --- info ---

const InfoRow = memo(function InfoRow({
  label,
  value,
  detail,
  external,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  detail?: string;
  external?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const { systemColors } = useTheme();
  const body = (
    <>
      <View style={insetGroupedRowStyles.text}>
        <Text variant="footnote" tone="secondary">
          {label}
        </Text>
        <Text variant="body" color={onPress ? systemColors.accent : systemColors.label} selectable={!onPress}>
          {value}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="secondary">
            {detail}
          </Text>
        ) : null}
      </View>
      {external ? <Icon name="open.external" size={15} color={systemColors.tertiaryLabel} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={insetGroupedRowStyles.row} accessible testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      rippleColor={systemColors.label as string}
      accessibilityRole="link"
      style={insetGroupedRowStyles.row}
      testID={testID}
    >
      {body}
    </PressableSurface>
  );
});

/** Hours, website, phone and email: only the ones the gym has set. */
export const GymInfoSection = memo(function GymInfoSection({
  gym,
  rows,
  actions,
}: {
  gym: Pick<Gym, 'hours' | 'hoursUpdatedAt' | 'website' | 'contactPhone' | 'contactEmail'>;
  rows: readonly GymInfoRow[];
  actions: GymPageActions;
}) {
  const { t } = useTranslation('boards');
  const openWebsite = useCallback(() => actions.onInfoRow('website'), [actions]);
  const callPhone = useCallback(() => actions.onInfoRow('phone'), [actions]);
  const sendEmail = useCallback(() => actions.onInfoRow('email'), [actions]);
  const hoursUpdated = formatRelativeTime(gym.hoursUpdatedAt);
  return (
    <ShelfSection title={t('mobile.gymPage.infoTitle')} testID="gym-page-info">
      <View style={styles.gutter}>
        <InsetGroupedList separatorInset="gutter">
          {rows.map((row) => {
            switch (row) {
              case 'hours':
                return (
                  <InfoRow
                    key={row}
                    label={t('mobile.gymPage.hours')}
                    value={gym.hours?.trim() ?? ''}
                    detail={hoursUpdated ? t('mobile.gymPage.hoursUpdated', { when: hoursUpdated }) : undefined}
                    testID="gym-page-info-hours"
                  />
                );
              case 'website':
                return (
                  <InfoRow
                    key={row}
                    label={t('mobile.gymPage.website')}
                    value={gymWebsiteLabel(gym.website ?? '')}
                    external
                    onPress={openWebsite}
                    testID="gym-page-info-website"
                  />
                );
              case 'phone':
                return (
                  <InfoRow
                    key={row}
                    label={t('mobile.gymPage.phone')}
                    value={gym.contactPhone?.trim() ?? ''}
                    onPress={callPhone}
                    testID="gym-page-info-phone"
                  />
                );
              case 'email':
                return (
                  <InfoRow
                    key={row}
                    label={t('mobile.gymPage.email')}
                    value={gym.contactEmail?.trim() ?? ''}
                    onPress={sendEmail}
                    testID="gym-page-info-email"
                  />
                );
            }
          })}
        </InsetGroupedList>
      </View>
    </ShelfSection>
  );
});

// --- claim and report ---

/** "Run this gym?" for anyone who can claim it; the pending note once they have. */
export const GymClaimCardBlock = memo(function GymClaimCardBlock({
  card,
  gymName,
  actions,
}: {
  card: Exclude<GymClaimCard, 'hidden'>;
  gymName: string;
  actions: GymPageActions;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <View style={[styles.gutter, styles.sectionEnd]} testID="gym-page-claim-card">
      <Card>
        {card === 'denied' || card === 'deniedClosed' ? (
          <View style={styles.claim} testID="gym-page-claim-denied">
            <View style={styles.pending}>
              <Icon name="info" size={20} color={systemColors.secondaryLabel} />
              <Text variant="subheadline" tone="secondary" style={styles.pendingText}>
                {/* One card for a denial, an expiry and a revert. Without Try again
                    (the gym can't be claimed now), the copy doesn't offer it either. */}
                {card === 'denied'
                  ? t('mobile.gymPage.claimDenied', { gym: gymName })
                  : t('mobile.gymPage.claimDeniedClosed', { gym: gymName })}
              </Text>
            </View>
            {card === 'denied' ? (
              <Button
                title={t('mobile.gymPage.claimRetry')}
                variant="tonal"
                onPress={actions.onClaim}
                style={styles.claimButton}
              />
            ) : null}
          </View>
        ) : card === 'pending' ? (
          <View style={styles.pending}>
            <Icon name="clock" size={20} color={systemColors.secondaryLabel} />
            <Text variant="subheadline" tone="secondary" style={styles.pendingText}>
              {t('mobile.gymPage.claimPending')}
            </Text>
          </View>
        ) : (
          <View style={styles.claim}>
            <Text variant="headline" accessibilityRole="header">
              {t('mobile.gymPage.claimTitle')}
            </Text>
            <Text variant="subheadline" tone="secondary">
              {t('mobile.gymPage.claimBody')}
            </Text>
            <Button
              title={card === 'signIn' ? t('mobile.gymPage.claimCtaSignedOut') : t('mobile.gymPage.claimCta')}
              variant="tonal"
              onPress={card === 'signIn' ? actions.onSignIn : actions.onClaim}
              style={styles.claimButton}
            />
          </View>
        )}
      </Card>
    </View>
  );
});

/** Report a problem: the last row of the page, in its own group. */
export const GymReportSection = memo(function GymReportSection({ actions }: { actions: GymPageActions }) {
  const { t } = useTranslation('boards');
  return (
    <View style={[styles.gutter, styles.sectionEnd]}>
      <InsetGroupedList>
        <GymLinkRow
          icon="flag"
          label={t('mobile.gymPage.report')}
          onPress={actions.onReport}
          testID="gym-page-report"
        />
      </InsetGroupedList>
    </View>
  );
});

const ADDRESS_MIN_TARGET = 44;

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: spacing[4],
  },
  top: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: SHELF_SECTION_GAP,
    gap: spacing[2],
  },
  address: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    alignSelf: 'flex-start',
    // The address is a link: a full tap target even on one line of text.
    minHeight: ADDRESS_MIN_TARGET,
  },
  addressText: {
    flexShrink: 1,
  },
  addressPlain: {
    marginTop: spacing[1],
  },
  runBy: {
    alignItems: 'flex-start',
    gap: spacing[2],
    marginTop: spacing[1],
  },
  inlineClaim: {
    alignSelf: 'flex-start',
  },
  boardsHeader: {
    paddingBottom: SHELF_HEADER_CONTENT_GAP,
  },
  boardsState: {
    paddingBottom: SHELF_SECTION_GAP,
    paddingHorizontal: spacing[4],
  },
  sectionEnd: {
    paddingBottom: SHELF_SECTION_GAP,
  },
  claim: {
    gap: spacing[2],
  },
  claimButton: {
    marginTop: spacing[2],
    alignSelf: 'flex-start',
  },
  pending: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[3],
  },
  pendingText: {
    flex: 1,
  },
});
