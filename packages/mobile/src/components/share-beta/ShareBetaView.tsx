import { FlashList, type FlashListProps } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { shareBetaListItemType, shareBetaListKey, type ShareBetaListItem } from '../../lib/share-beta-list';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { ChromeIconButton, useChromeIconButtonSize } from '../ChromeIconButton';
import { Icon } from '../Icon';
import { Text } from '../Text';
export function ShareBetaView({
  isAuthenticated,
  onSignIn,
  onClose,
  thumbnail,
  caption,
  link,
  previewLoading,
  searchText,
  onSearchChange,
  attachError,
  attaching,
  loading,
  loadingMore,
  listItems,
  renderItem,
  handleEndReached,
  isSearching,
  onViewableItemsChanged,
}: {
  isAuthenticated: boolean;
  onSignIn: () => void;
  onClose: () => void;
  thumbnail: string | null;
  caption: string | null;
  link: string;
  previewLoading: boolean;
  searchText: string;
  onSearchChange: (text: string) => void;
  attachError: string | null;
  attaching: boolean;
  loading: boolean;
  loadingMore: boolean;
  listItems: ShareBetaListItem[];
  onViewableItemsChanged?: FlashListProps<ShareBetaListItem>['onViewableItemsChanged'];
  renderItem: FlashListProps<ShareBetaListItem>['renderItem'];
  handleEndReached: () => void;
  isSearching: boolean;
}) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const listContentStyle = useMemo(() => ({ paddingBottom: insets.bottom + spacing[6] }), [insets.bottom]);
  // The empty flank matches the close button, so the title stays centred.
  const closeButtonSize = useChromeIconButtonSize();

  const containerStyle = [styles.container, { backgroundColor: systemColors.background, paddingTop: insets.top }];

  // Defense in depth — the provider stashes shares until login, so this is rare.
  if (!isAuthenticated) {
    return (
      <View style={containerStyle}>
        <View style={styles.centered}>
          <Icon name="person" size={40} color={systemColors.secondaryLabel} />
          <Text variant="title3" style={styles.centeredText}>
            {t('mobile.betaVideos.shareSignIn')}
          </Text>
          <Button title={t('mobile.betaVideos.shareSignInButton')} variant="filled" size="large" onPress={onSignIn} />
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <View style={styles.header}>
        <ChromeIconButton
          testID="share-beta-close"
          icon="close"
          onPress={onClose}
          accessibilityLabel={t('mobile.betaVideos.shareClose')}
        />
        <Text variant="headline">{t('mobile.betaVideos.shareTargetTitle')}</Text>
        <View style={{ width: closeButtonSize, height: closeButtonSize }} />
      </View>

      <View style={[styles.linkCard, { backgroundColor: systemColors.secondaryBackground }]}>
        {thumbnail ? (
          <Image
            source={{ uri: thumbnail }}
            style={styles.thumb}
            contentFit="cover"
            transition={150}
            // Remote thumbnail — skip expo-image's main-thread downscale resample.
            allowDownscaling={false}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Icon name="video" size={20} color={brandColors.primary} />
          </View>
        )}
        <View style={styles.linkText}>
          <Text variant="subheadline" color={systemColors.label} numberOfLines={2}>
            {caption ?? link}
          </Text>
          {previewLoading && (
            <Text variant="caption2" color={systemColors.secondaryLabel}>
              {t('mobile.betaVideos.shareReadingCaption')}
            </Text>
          )}
        </View>
      </View>

      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.prompt}>
        {t('mobile.betaVideos.shareTargetPrompt')}
      </Text>

      <TextInput
        value={searchText}
        onChangeText={onSearchChange}
        placeholder={t('mobile.betaVideos.shareSearchPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.input, { color: systemColors.label, borderColor: systemColors.separator }]}
      />

      {attachError && (
        <View style={[styles.errorBanner, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name="error" size={18} color={brandColors.error} />
          <Text variant="footnote" color={brandColors.error} style={styles.errorText}>
            {attachError}
          </Text>
        </View>
      )}

      <View style={styles.listWrapper} pointerEvents={attaching ? 'none' : 'auto'}>
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          <FlashList
            data={listItems}
            renderItem={renderItem}
            onViewableItemsChanged={onViewableItemsChanged}
            keyExtractor={shareBetaListKey}
            // Separate recycler pools for the section headers and the ascent
            // rows. No `estimatedItemSize` — FlashList v2 self-measures and
            // removed the prop; mixed row heights are its normal case.
            getItemType={shareBetaListItemType}
            keyboardShouldPersistTaps="handled"
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            contentContainerStyle={listContentStyle}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Icon name="tick.outline" size={44} color={systemColors.tertiaryLabel} />
                <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyText}>
                  {isSearching ? t('mobile.betaVideos.shareNoResults') : t('mobile.betaVideos.shareNoAscents')}
                </Text>
              </View>
            }
          />
        )}
      </View>

      {attaching && (
        <View style={styles.overlay} pointerEvents="auto">
          <ActivityIndicator size="large" />
        </View>
      )}
    </View>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    linkCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      marginHorizontal: spacing[4],
      padding: spacing[3],
      borderRadius: borderRadius.md,
    },
    thumb: { width: 44, height: 44, borderRadius: borderRadius.sm },
    thumbFallback: { alignItems: 'center', justifyContent: 'center' },
    linkText: { flex: 1, gap: 2 },
    sectionLabel: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
      paddingBottom: spacing[1],
      fontWeight: '600',
    },
    prompt: { paddingHorizontal: spacing[4], marginTop: spacing[4], marginBottom: spacing[2] },
    input: {
      marginHorizontal: spacing[4],
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: textStyles.callout.fontSize,
      marginBottom: spacing[2],
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
      marginHorizontal: spacing[4],
      marginBottom: spacing[2],
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      borderRadius: borderRadius.md,
    },
    errorText: { flex: 1 },
    listWrapper: { flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4], padding: spacing[6] },
    centeredText: { textAlign: 'center' },
    footer: { paddingVertical: spacing[5], alignItems: 'center' },
    empty: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 96,
      paddingHorizontal: spacing[8],
      gap: spacing[3],
    },
    emptyText: { textAlign: 'center' },
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.15)',
    },
  });
