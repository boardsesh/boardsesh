import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from 'react-i18next';
import { AppMenu } from './AppMenu';

import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { SwitchRow } from './SwitchRow';
import { Text } from './Text';

import { appReleaseLabel, translateAppReleaseLabel } from './AppUpdatesCard.logic';

import { otaBranchKind } from '../lib/qa/pr-branch';

import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';

import type { ComponentProps } from 'react';
import type { MoreRow } from './MoreForm.types';
export function AppUpdatesCardView({
  buildDetails,
  releaseLabel,
  context,
  isPending,
  busy,
  updateControl,
  available,
  actions,
  onChannelPick: handleChannelPick,
  showEarlyUpdates,
  earlyRow,
  earlyState,
  onEarlyUpdatesChange,
  showQa,
  currentPrNumber,
  onOpenPreviews,
  onOpenQa,
}: {
  buildDetails: ReactNode;
  releaseLabel: ReturnType<typeof appReleaseLabel>;
  context: Parameters<typeof appReleaseLabel>[0];
  isPending: boolean;
  busy: boolean;
  updateControl: () => ReactNode;
  available: boolean;
  actions: ComponentProps<typeof AppMenu>['actions'];
  onChannelPick: (index: number) => void;
  showEarlyUpdates: boolean;
  earlyRow: MoreRow | undefined;
  earlyState: string;
  onEarlyUpdatesChange: (enabled: boolean) => void;
  showQa: boolean;
  currentPrNumber: number | null;
  onOpenPreviews: () => void;
  onOpenQa: () => void;
}) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <Text variant="body">{translateAppReleaseLabel(releaseLabel, t)}</Text>
      {buildDetails}
      {context.automaticCanary === true ? (
        <View style={styles.canaryNote}>
          <Icon name="info" size={16} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.releaseLabel}>
            {t('mobile.changelog.updates.canaryBody')}
          </Text>
        </View>
      ) : !isPending &&
        context.automaticCanary === null &&
        context.channel === 'production' &&
        otaBranchKind(context.branch ?? null) === 'default' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.changelog.updates.statusUnknown')}
        </Text>
      ) : null}
      <PressableSurface
        feedback="opacity"
        onPress={() => setOptionsExpanded((expanded) => !expanded)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.changelog.updates.options')}
        accessibilityState={{ expanded: optionsExpanded, disabled: busy }}
        style={styles.navigationRow}
      >
        <Text variant="body" style={styles.releaseLabel}>
          {t('mobile.changelog.updates.options')}
        </Text>
        <Icon name={optionsExpanded ? 'chevron.up' : 'chevron.down'} size={16} color={systemColors.tertiaryLabel} />
      </PressableSurface>
      {optionsExpanded ? (
        <View style={styles.options}>
          <View style={styles.controls}>
            {updateControl()}
            {available ? (
              <AppMenu
                label={t('mobile.changelog.updates.changeRelease')}
                actions={actions}
                onSelectIndex={handleChannelPick}
              />
            ) : null}
          </View>
          {showEarlyUpdates && earlyRow ? (
            <View style={[styles.section, { borderTopColor: systemColors.separator }]}>
              {earlyRow.kind === 'toggle' ? (
                <SwitchRow
                  label={earlyRow.label}
                  description={earlyState === 'off' ? undefined : earlyRow.subtitle}
                  wrapDescription
                  value={earlyRow.value}
                  disabled={busy}
                  onValueChange={(next) => {
                    onEarlyUpdatesChange(next);
                  }}
                />
              ) : earlyRow.kind === 'info' ? (
                <>
                  <Text variant="subheadline">{earlyRow.label}</Text>
                  <Text variant="footnote" color={systemColors.secondaryLabel}>
                    {earlyRow.body}
                  </Text>
                </>
              ) : null}
              {earlyRow.kind === 'toggle' ? (
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {t('mobile.changelog.updates.earlyUpdatesHelp')}
                </Text>
              ) : null}
            </View>
          ) : null}
          {showQa && currentPrNumber !== null ? (
            <PressableSurface
              feedback="opacity"
              onPress={onOpenPreviews}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.changelog.updates.testPreview')}
              style={styles.navigationRow}
            >
              <Text variant="body" style={styles.releaseLabel}>
                {t('mobile.changelog.updates.testPreview')}
              </Text>
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            </PressableSurface>
          ) : null}
        </View>
      ) : null}
      {showQa ? (
        <View style={[styles.navigationSection, { borderTopColor: systemColors.separator }]}>
          <PressableSurface
            feedback="opacity"
            onPress={onOpenQa}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={t(
              currentPrNumber !== null
                ? 'mobile.changelog.updates.finishTesting'
                : 'mobile.changelog.updates.testPreview',
              { prNumber: currentPrNumber },
            )}
            style={styles.navigationRow}
          >
            <Text variant="body" style={styles.releaseLabel}>
              {t(
                currentPrNumber !== null
                  ? 'mobile.changelog.updates.finishTesting'
                  : 'mobile.changelog.updates.testPreview',
                { prNumber: currentPrNumber },
              )}
            </Text>
            <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: spacing[4], borderRadius: borderRadius.lg, gap: spacing[1] },
  canaryNote: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  releaseLabel: { flex: 1 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3] },
  options: { gap: spacing[3], paddingBottom: spacing[2] },
  navigationSection: { borderTopWidth: StyleSheet.hairlineWidth },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing[3], gap: spacing[2] },
  navigationRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing[2] },
});
