// The 2.7 preview-first spotlight, pinned above the What's New timeline (see
// `lib/preview-first-spotlight.ts` for why it is pinned and when it retires).
// It says what changed in the climber's language and links to the board help's
// driving section, for climbers who read release notes rather than tips.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { buildHelpSectionUrl } from '../../lib/help-url';
import { openExternalUrl } from '../../lib/open-url';
import {
  dismissPreviewFirstSpotlight,
  isPreviewFirstSpotlightActive,
  loadPreviewFirstSpotlight,
  markPreviewFirstSpotlightShown,
  type PreviewFirstSpotlightRecord,
} from '../../lib/preview-first-spotlight';

/** Got it's floor: a small Compose button lands at 40 dp, under Material's 48. */
const DISMISS_MIN_HEIGHT = Platform.OS === 'android' ? 48 : 44;

type PreviewFirstSpotlightCardProps = {
  style?: StyleProp<ViewStyle>;
};

function PreviewFirstSpotlightCardComponent({ style }: PreviewFirstSpotlightCardProps) {
  const { t, i18n } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  const [visible, setVisible] = useState(false);
  const recordRef = useRef<PreviewFirstSpotlightRecord | null>(null);

  useEffect(() => {
    // A captured store screen never shows it, like the "New" pill.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    let active = true;
    void loadPreviewFirstSpotlight().then(async (loaded) => {
      const now = Date.now();
      if (!active || !isPreviewFirstSpotlightActive(loaded, now)) return;
      recordRef.current = loaded;
      setVisible(true);
      try {
        recordRef.current = await markPreviewFirstSpotlightShown(loaded, now);
      } catch {
        // Not knowing when it first showed only keeps it a little longer.
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const handleOpenHelp = useCallback(() => {
    void openExternalUrl(buildHelpSectionUrl('board-and-bluetooth', 'driving', language), 'whats-new-preview-first');
  }, [language]);
  const handleDismiss = useCallback(() => {
    setVisible(false);
    const record = recordRef.current;
    if (record) void dismissPreviewFirstSpotlight(record).catch(() => undefined);
  }, []);

  if (!visible) return null;

  return (
    <View
      testID="preview-first-spotlight-card"
      style={[
        styles.card,
        { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
        style,
      ]}
    >
      <View style={styles.header}>
        <Icon name="lightbulb.fill" size={22} color={brandColors.primary} />
        <Text variant="headline" accessibilityRole="header" style={styles.title}>
          {t('mobile.changelog.previewFirstSpotlight.title')}
        </Text>
      </View>
      <Text variant="subheadline" color={systemColors.label}>
        {t('mobile.changelog.previewFirstSpotlight.tap')}
      </Text>
      <Text variant="subheadline" color={systemColors.label}>
        {t('mobile.changelog.previewFirstSpotlight.swipe')}
      </Text>
      <Text variant="subheadline" color={systemColors.label}>
        {t('mobile.changelog.previewFirstSpotlight.back')}
      </Text>
      <Button
        testID="preview-first-spotlight-help"
        title={t('mobile.changelog.previewFirstSpotlight.cta')}
        variant="filled"
        onPress={handleOpenHelp}
        style={styles.primary}
      />
      <View style={styles.dismissRow}>
        <Button
          testID="preview-first-spotlight-dismiss"
          title={t('mobile.changelog.previewFirstSpotlight.dismiss')}
          variant="text"
          size="small"
          minHeight={DISMISS_MIN_HEIGHT}
          onPress={handleDismiss}
        />
      </View>
    </View>
  );
}

export const PreviewFirstSpotlightCard = memo(PreviewFirstSpotlightCardComponent);

const styles = StyleSheet.create({
  card: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[4],
    gap: spacing[2],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  primary: {
    marginTop: spacing[2],
    alignSelf: 'stretch',
  },
  dismissRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
});
