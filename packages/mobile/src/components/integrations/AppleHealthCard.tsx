import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { ListRow } from '../ListRow';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import {
  getAppleHealthAuthorizationStatus,
  requestAppleHealthAuthorization,
  useHealthKitAutoSavePreference,
} from '../../lib/integrations';

/**
 * Apple Health auto-save card. iOS-only — the integration registry already
 * filters this out elsewhere, but we guard defensively so the component is safe
 * to render unconditionally.
 *
 * The auto-save preference is kept independent of the HealthKit grant: a user
 * can leave the toggle on even after denying the OS permission (the save simply
 * no-ops until they grant it in Settings). We surface that state with the
 * `denied` footnote + an Open Settings shortcut.
 */
export function AppleHealthCard() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { enabled, loaded, setEnabled } = useHealthKitAutoSavePreference();
  const [denied, setDenied] = useState(false);

  // On mount, reflect a previously-denied permission so the hint shows even
  // before the user touches the toggle. This is a read-only status probe —
  // it must never present the OS consent sheet (requestAuthorization would,
  // for users who haven't decided yet).
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let cancelled = false;
    getAppleHealthAuthorizationStatus()
      .then((status) => {
        if (!cancelled) setDenied(status === 'denied');
      })
      .catch(() => {
        // A native bridge failure here is non-fatal — leave the hint hidden
        // rather than crashing the settings screen.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(
    (next: boolean) => {
      // Persist the preference regardless of the grant result — see the class
      // comment. Only an "on" toggle needs to trigger the authorization flow,
      // and only for users who haven't decided yet (HealthKit never re-shows
      // the sheet for an already-decided type).
      setEnabled(next);
      if (!next) return;
      void (async () => {
        try {
          const status = await getAppleHealthAuthorizationStatus();
          if (status === 'notDetermined') {
            const granted = await requestAppleHealthAuthorization();
            setDenied(!granted);
          } else {
            setDenied(status === 'denied');
          }
        } catch {
          // Same rationale as the mount effect — non-fatal.
        }
      })();
    },
    [setEnabled],
  );

  if (Platform.OS !== 'ios') return null;

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <SwitchRow
        label={t('integrations.appleHealth.autoSave')}
        description={t('integrations.appleHealth.autoSaveDescription')}
        value={enabled}
        onValueChange={handleToggle}
        disabled={!loaded}
      />
      {denied ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.deniedHint}>
            {t('integrations.appleHealth.permissionDenied')}
          </Text>
          <ListRow
            title={t('integrations.appleHealth.openSettings')}
            showChevron
            showSeparator={false}
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  deniedHint: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
    paddingBottom: spacing[2],
  },
});
