import { useCallback } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { PressableSurface } from '../src/components/PressableSurface';
import { SectionHeader } from '../src/components/SectionHeader';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import {
  contributors,
  sponsors,
  privateSponsorCount,
  friends,
  dogName,
  SPONSORS_URL,
} from '../src/lib/acknowledgements';
import { openDiscordInvite } from '../src/lib/discord';
import { openExternalUrl } from '../src/lib/open-url';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { borderRadius, spacing } from '../src/theme/tokens';
import type { IconName } from '../src/components/icon-map';

function Chip({ label, icon, onPress }: { label: string; icon?: IconName; onPress: () => void }) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      opacityTo={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: systemColors.fill }]}
    >
      {icon ? <Icon name={icon} size={13} color={systemColors.secondaryLabel} /> : null}
      <Text variant="subheadline" numberOfLines={1}>
        {label}
      </Text>
    </PressableSurface>
  );
}

function ThanksCard({
  icon,
  title,
  body,
  onPress,
}: {
  icon: IconName;
  title: string;
  body: string;
  onPress?: () => void;
}) {
  const { systemColors } = useTheme();
  const content = (
    <>
      <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
        <Icon name={icon} size={22} color={systemColors.accent} />
      </View>
      <View style={styles.cardText}>
        <Text variant="headline" style={styles.cardTitle}>
          {title}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.cardBody}>
          {body}
        </Text>
      </View>
      {onPress ? <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} /> : null}
    </>
  );
  if (onPress) {
    return (
      <PressableSurface
        onPress={onPress}
        feedback="opacity"
        opacityTo={0.7}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={[styles.card, styles.cardPressable, { backgroundColor: systemColors.secondaryBackground }]}
      >
        {content}
      </PressableSurface>
    );
  }
  return <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>{content}</View>;
}

export default function AcknowledgementsScreen() {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const friendsLine = friends.join(', ');

  const handleOpenProfile = useCallback((url: string) => {
    void openExternalUrl(url, 'acknowledgements');
  }, []);
  const handleBecomeSponsor = useCallback(() => {
    void openExternalUrl(SPONSORS_URL, 'acknowledgements-sponsor');
  }, []);
  const handleJoinDiscord = useCallback(() => {
    void openDiscordInvite('acknowledgements');
  }, []);
  const handleOpenScout = useCallback(() => {
    router.push('/scout');
  }, [router]);
  const handleOpenLicenses = useCallback(() => {
    router.push('/licenses');
  }, [router]);

  // The transparent, blur-under-content header is an iOS-only feature (headerBlurEffect):
  // on iOS, Liquid Glass gets it and Material's opaque M3 app bar does not. On Android
  // — including a forced Liquid Glass user, where there's no glass surface — keep the
  // header opaque so scroll content doesn't slide under the status bar (dual-axis:
  // aesthetic AND platform). The hook is called unconditionally; only the value is gated.
  const prefersGlassHeader = useVariantValue({ liquidGlass: true, material: false });
  const headerTransparent = Platform.OS === 'ios' && prefersGlassHeader;

  return (
    <>
      <Stack.Screen
        options={{
          title: t('mobile.acknowledgements.title'),
          headerShown: true,
          headerLargeTitle: false,
          headerTransparent,
          headerBlurEffect: 'systemMaterial',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }]}
      >
        <View style={[styles.hero, { backgroundColor: systemColors.secondaryBackground }]}>
          <View style={[styles.heroIcon, { backgroundColor: brandColors.primaryFill }]}>
            <Icon name="favorite.fill" size={28} color={brandColors.onPrimary} />
          </View>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.heroBody}>
            {t('mobile.acknowledgements.intro')}
          </Text>
        </View>

        <View style={styles.section}>
          <SectionHeader title={t('mobile.acknowledgements.contributorsTitle')} />
          <View style={[styles.groupCard, { backgroundColor: systemColors.secondaryBackground }]}>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.sectionBody}>
              {t('mobile.acknowledgements.contributorsBody')}
            </Text>
            <View style={styles.chips}>
              {contributors.map((contributor) => (
                <Chip
                  key={contributor.login}
                  label={contributor.name ?? contributor.login}
                  onPress={() => handleOpenProfile(contributor.htmlUrl)}
                />
              ))}
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title={t('mobile.acknowledgements.sponsorsTitle')} />
          {sponsors.length > 0 ? (
            <View style={[styles.groupCard, { backgroundColor: systemColors.secondaryBackground }]}>
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.sectionBody}>
                {t('mobile.acknowledgements.sponsorsBody')}
              </Text>
              <View style={styles.chips}>
                {sponsors.map((sponsor) => (
                  <Chip
                    key={sponsor.login}
                    icon="favorite.fill"
                    label={sponsor.name ?? sponsor.login}
                    onPress={() => handleOpenProfile(sponsor.url)}
                  />
                ))}
              </View>
              {privateSponsorCount > 0 ? (
                <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.privateThanks}>
                  {t('mobile.acknowledgements.privateSponsorsThanks', { count: privateSponsorCount })}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={[styles.groupCard, { backgroundColor: systemColors.secondaryBackground }]}>
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.sectionBody}>
                {privateSponsorCount > 0
                  ? t('mobile.acknowledgements.privateSponsorsThanks', { count: privateSponsorCount })
                  : t('mobile.acknowledgements.sponsorsEmpty')}
              </Text>
              <Button
                title={t('mobile.acknowledgements.becomeSponsor')}
                icon="favorite"
                size="large"
                variant="outlined"
                onPress={handleBecomeSponsor}
                style={styles.sponsorButton}
              />
            </View>
          )}
        </View>

        <View style={styles.section}>
          <SectionHeader title={t('mobile.acknowledgements.personalTitle')} />
          <View style={styles.cardStack}>
            <ThanksCard
              icon="discord"
              title={t('mobile.acknowledgements.discordTitle')}
              body={t('mobile.acknowledgements.discordBody')}
              onPress={handleJoinDiscord}
            />
            <ThanksCard
              icon="people"
              title={t('mobile.acknowledgements.friendsTitle')}
              body={t('mobile.acknowledgements.friendsBody', { names: friendsLine })}
            />
            <ThanksCard
              icon="person"
              title="Alex"
              body={t('mobile.acknowledgements.alexBody')}
            />
            <ThanksCard
              icon="paw"
              title={dogName}
              body={t('mobile.acknowledgements.dogBody')}
              onPress={handleOpenScout}
            />
          </View>
        </View>

        <PressableSurface
          onPress={handleOpenLicenses}
          feedback="opacity"
          opacityTo={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.acknowledgements.ossLicensesLink')}
          style={[styles.linkRow, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
            <Icon name="doc.text" size={22} color={systemColors.accent} />
          </View>
          <View style={styles.cardText}>
            <Text variant="headline" style={styles.cardTitle}>
              {t('mobile.acknowledgements.ossLicensesLink')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.cardBody}>
              {t('mobile.acknowledgements.ossLicensesBody')}
            </Text>
          </View>
          <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[6],
  },
  hero: {
    alignItems: 'center',
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[6],
  },
  heroIcon: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
    marginBottom: spacing[4],
  },
  heroBody: {
    textAlign: 'center',
    lineHeight: 22,
  },
  section: {
    gap: spacing[2],
  },
  groupCard: {
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
  sectionBody: {
    lineHeight: 20,
  },
  privateThanks: {
    lineHeight: 20,
    fontStyle: 'italic',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
  },
  cardStack: {
    gap: spacing[3],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
  cardPressable: {
    alignItems: 'center',
  },
  cardIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontWeight: '700',
  },
  cardBody: {
    marginTop: spacing[1],
    lineHeight: 20,
  },
  sponsorButton: {
    marginTop: spacing[4],
    alignSelf: 'flex-start',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
});
