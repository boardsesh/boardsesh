import { memo, useCallback, useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from '../src/components/ActivityIndicator';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { PressableSurface } from '../src/components/PressableSurface';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import { useStackScreenOptions } from '../src/hooks/use-stack-screen-options';
import { loadOssLicenses, type OssLicense } from '../src/lib/oss-licenses';
import { openExternalUrl } from '../src/lib/open-url';
import { useTheme } from '../src/providers/theme-provider';
import { spacing } from '../src/theme/tokens';

const keyExtractor = (item: OssLicense) => `${item.name}@${item.version}`;

const Separator = memo(function Separator() {
  const { systemColors } = useTheme();
  return <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />;
});

type LicenseRowProps = { license: OssLicense; onPress: (license: OssLicense) => void };

const LicenseRow = memo(function LicenseRow({ license, onPress }: LicenseRowProps) {
  const { systemColors } = useTheme();
  // Stable per-row handler so the memo isn't defeated by a fresh inline closure.
  const handlePress = useCallback(() => onPress(license), [onPress, license]);
  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      opacityTo={0.7}
      accessibilityRole="button"
      accessibilityLabel={license.name}
      style={styles.row}
    >
      <View style={styles.rowText}>
        <Text variant="body" numberOfLines={1}>
          {license.name}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
          {license.version} · {license.license}
        </Text>
      </View>
      <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );
});

export default function LicensesScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();
  const [selected, setSelected] = useState<OssLicense | null>(null);
  // Lazily pull in the ~1 MB manifest only once this screen mounts.
  const [licenses, setLicenses] = useState<OssLicense[] | null>(null);
  useEffect(() => {
    let active = true;
    void loadOssLicenses().then((loaded) => {
      if (active) setLicenses(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleSelect = useCallback((license: OssLicense) => setSelected(license), []);
  const handleClose = useCallback(() => setSelected(null), []);
  const handleViewSource = useCallback(() => {
    if (selected?.repository) void openExternalUrl(selected.repository, 'license-source');
  }, [selected]);

  const renderItem = useCallback(
    ({ item }: { item: OssLicense }) => <LicenseRow license={item} onPress={handleSelect} />,
    [handleSelect],
  );

  // Variant-aware header from the shared hook: a transparent blur header on Liquid
  // Glass (iOS), an opaque M3 app bar on Material — including the forced-Material-
  // on-iOS / Android paths where a transparent header would slide content under the
  // status bar.
  const screenOptions = useStackScreenOptions();

  return (
    <>
      <Stack.Screen options={{ ...screenOptions, title: t('mobile.licenses.title'), headerShown: true }} />
      <View style={styles.flex}>
        {licenses === null ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          // FlashList v2 self-measures rows — `estimatedItemSize` was removed and
          // no longer typechecks (see BoardCarousel for the same note).
          <FlashList
            data={licenses}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }}
            ItemSeparatorComponent={Separator}
            ListHeaderComponent={
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.intro}>
                {t('mobile.licenses.intro')}
              </Text>
            }
          />
        )}
      </View>

      <Modal
        visible={selected !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleClose}
      >
        <View style={[styles.modal, { backgroundColor: systemColors.background, paddingTop: insets.top + spacing[2] }]}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitle}>
              <Text variant="headline" numberOfLines={1}>
                {selected?.name}
              </Text>
              <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
                {selected?.version} · {selected?.license}
              </Text>
            </View>
            <Pressable
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.licenses.close')}
              hitSlop={12}
            >
              <Icon name="close" size={22} color={systemColors.secondaryLabel} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.licenseText}>
              {selected?.licenseText ?? selected?.license}
            </Text>
          </ScrollView>
          {selected?.repository ? (
            <View style={[styles.modalFooter, { paddingBottom: insets.bottom + spacing[3] }]}>
              <Button
                title={t('mobile.licenses.viewSource')}
                icon="link"
                size="large"
                variant="outlined"
                onPress={handleViewSource}
              />
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  intro: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[3],
    minHeight: 56,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4],
  },
  modal: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  modalTitle: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  modalBody: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[6],
  },
  licenseText: {
    lineHeight: 18,
  },
  modalFooter: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
