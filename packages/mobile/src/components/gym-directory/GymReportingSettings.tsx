import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { gymReportingAliasSources, gymReportingAliasTargets, hasGraphqlErrorCode } from '@boardsesh/graphql';
import type { GymStats } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { AppMenu } from '../AppMenu';
import { Button } from '../Button';
import { Text } from '../Text';
import { openValidatedUrl } from '../../lib/open-external-link';

const GEOCODING_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
const openGeocodingAttribution = () =>
  void openValidatedUrl(GEOCODING_ATTRIBUTION_URL, (url) => url === GEOCODING_ATTRIBUTION_URL);

type Props = {
  stats: GymStats;
  saveZone: (zone: string | null) => Promise<void>;
  saveAlias: (boardUuid: string, rootBoardUuid: string | null) => Promise<void>;
};

export function GymReportingSettings({ stats, saveZone, saveAlias }: Props) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const [editingZone, setEditingZone] = useState(false);
  const [zone, setZone] = useState(stats.timeZoneConfigured ? stats.timeZone : '');
  const [sourceUuid, setSourceUuid] = useState<string | null>(null);
  const [targetUuid, setTargetUuid] = useState<string | null>(null);
  const [unlink, setUnlink] = useState(false);
  const [confirmingAlias, setConfirmingAlias] = useState(false);
  const [pending, setPending] = useState(false);
  const [zoneError, setZoneError] = useState<'invalid' | 'save' | null>(null);
  const [aliasError, setAliasError] = useState(false);
  const sources = gymReportingAliasSources(stats.boards);
  const source = sources.find((board) => board.uuid === sourceUuid);
  const targets = gymReportingAliasTargets(stats.boards, source);
  const target = targets.find((board) => board.uuid === targetUuid);
  const canConfirm = !!source && (!!target || (unlink && !!source.rootUuid));

  async function updateZone() {
    setPending(true);
    setZoneError(null);
    try {
      await saveZone(zone.trim() || null);
      setEditingZone(false);
    } catch (error) {
      setZoneError(hasGraphqlErrorCode(error, 'INVALID_TIME_ZONE') ? 'invalid' : 'save');
    } finally {
      setPending(false);
    }
  }

  async function updateAlias() {
    if (!source || !canConfirm) return;
    setPending(true);
    setAliasError(false);
    try {
      await saveAlias(source.uuid, target?.uuid ?? null);
      setSourceUuid(null);
      setTargetUuid(null);
      setUnlink(false);
      setConfirmingAlias(false);
    } catch {
      setAliasError(true);
    } finally {
      setPending(false);
    }
  }

  const aliasTargets = [
    ...(source?.rootUuid ? [{ uuid: null, name: t('gymReporting.independentBoard') }] : []),
    ...targets,
  ];

  return (
    <View style={styles.section}>
      <Text variant="footnote" accessibilityRole="link" onPress={openGeocodingAttribution}>
        {t('gymReporting.locationAttribution')}
      </Text>
      {editingZone ? (
        <View style={styles.group}>
          <Text variant="headline">{t('gymReporting.timeZone')}</Text>
          <AccessibleTextInput
            accessibilityLabel={t('gymReporting.timeZone')}
            autoCapitalize="none"
            autoCorrect={false}
            value={zone}
            onChangeText={setZone}
            editable={!pending}
            placeholder={t('gymReporting.zoneExample')}
            placeholderTextColor={systemColors.tertiaryLabel}
            style={[
              styles.input,
              {
                color: systemColors.label,
                backgroundColor: systemColors.secondaryBackground,
                borderColor: systemColors.separator,
              },
            ]}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.zoneHint')}
          </Text>
          {zoneError && (
            <Text accessibilityRole="alert">
              {t(zoneError === 'invalid' ? 'gymReporting.invalidZone' : 'gymReporting.saveError')}
            </Text>
          )}
          <View style={styles.actions}>
            <Button
              title={t('gymReporting.cancel')}
              disabled={pending}
              variant="outlined"
              onPress={() => {
                setEditingZone(false);
                setZoneError(null);
              }}
            />
            <Button title={t('gymReporting.save')} disabled={pending} onPress={() => void updateZone()} />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            title={t('gymReporting.editZone')}
            disabled={pending}
            variant="outlined"
            onPress={() => {
              setZone(stats.timeZoneConfigured ? stats.timeZone : '');
              setEditingZone(true);
            }}
          />
        </View>
      )}
      {stats.canManageBoardAliases && sources.length > 0 && (
        <View style={styles.group}>
          <Text accessibilityRole="header" variant="headline">
            {t('gymReporting.groupBoards')}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.groupHint')}
          </Text>
          <Text variant="subheadline">{t('gymReporting.sourceBoard')}</Text>
          <AppMenu
            label={source?.name ?? t('gymReporting.chooseBoard')}
            accessibilityLabel={t('gymReporting.sourceBoard')}
            actions={sources.map((board) => ({
              label: board.name,
              selected: board.uuid === sourceUuid,
              disabled: pending,
            }))}
            onSelectIndex={(index) => {
              setSourceUuid(sources[index]?.uuid ?? null);
              setTargetUuid(null);
              setUnlink(false);
              setConfirmingAlias(false);
              setAliasError(false);
            }}
          />
          {source && (
            <>
              <Text variant="subheadline">{t('gymReporting.targetBoard')}</Text>
              <AppMenu
                label={target?.name ?? (unlink ? t('gymReporting.independentBoard') : t('gymReporting.chooseBoard'))}
                accessibilityLabel={t('gymReporting.targetBoard')}
                actions={aliasTargets.map((board) => ({
                  label: board.name,
                  selected: board.uuid === null ? unlink : board.uuid === targetUuid,
                  disabled: pending,
                }))}
                onSelectIndex={(index) => {
                  const selected = aliasTargets[index];
                  if (!selected) return;
                  setTargetUuid(selected.uuid);
                  setUnlink(selected.uuid === null);
                  setConfirmingAlias(false);
                  setAliasError(false);
                }}
              />
            </>
          )}
          {canConfirm && !confirmingAlias && (
            <View style={styles.actions}>
              <Button
                title={t('gymReporting.reviewGrouping')}
                variant="outlined"
                disabled={pending}
                onPress={() => setConfirmingAlias(true)}
              />
            </View>
          )}
          {confirmingAlias && source && canConfirm && (
            <>
              <Text accessibilityRole="alert" variant="subheadline">
                {target
                  ? t('gymReporting.confirmGroup', { source: source.name, target: target.name })
                  : t('gymReporting.confirmUngroup', { source: source.name })}
              </Text>
              <View style={styles.actions}>
                <Button
                  title={t('gymReporting.cancel')}
                  variant="outlined"
                  disabled={pending}
                  onPress={() => setConfirmingAlias(false)}
                />
                <Button
                  title={t('gymReporting.confirmGrouping')}
                  disabled={pending}
                  onPress={() => void updateAlias()}
                />
              </View>
            </>
          )}
          {aliasError && <Text accessibilityRole="alert">{t('gymReporting.groupError')}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[4] },
  group: { gap: spacing[2], alignItems: 'stretch' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  input: {
    minHeight: 48,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[3],
  },
});
