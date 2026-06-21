import { useCallback } from 'react';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BoardseshLogo } from '../src/components/BoardseshLogo';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { PressableSurface } from '../src/components/PressableSurface';
import { SectionHeader } from '../src/components/SectionHeader';
import { Text } from '../src/components/Text';
import { useBottomChromeMetrics } from '../src/hooks/use-bottom-chrome-metrics';
import { useStackScreenOptions } from '../src/hooks/use-stack-screen-options';
import { openDiscordInvite } from '../src/lib/discord';
import { openExternalUrl } from '../src/lib/open-url';
import { openPartnershipsEmail, PARTNERSHIPS_EMAIL } from '../src/lib/partnerships';
import { useTheme } from '../src/providers/theme-provider';
import { useToast } from '../src/providers/toast-provider';
import { borderRadius, spacing } from '../src/theme/tokens';
import type { IconName } from '../src/components/icon-map';

const GITHUB_REPO_URL = 'https://github.com/boardsesh/boardsesh';

type AboutCard = {
  icon: IconName;
  title: string;
  body: string;
};

export default function AboutScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const screenOptions = useStackScreenOptions();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const { showToast } = useToast();
  const handleJoinDiscord = useCallback(() => {
    void openDiscordInvite('about');
  }, []);
  const handlePartnerEmail = useCallback(() => {
    // If no mail handler opens, surface the address so it can still be copied.
    void openPartnershipsEmail().then((opened) => {
      if (!opened) showToast(PARTNERSHIPS_EMAIL, 'info');
    });
  }, [showToast]);
  const handleOpenAcknowledgements = useCallback(() => {
    router.push('/acknowledgements');
  }, [router]);
  const handleOpenChangelog = useCallback(() => {
    router.push('/changelog');
  }, [router]);
  const handleOpenGithub = useCallback(() => {
    void openExternalUrl(GITHUB_REPO_URL, 'about-github');
  }, []);
  const cards: AboutCard[] = [
    {
      icon: 'lightbulb',
      title: t('mobile.about.whatItDoesTitle'),
      body: t('mobile.about.whatItDoesBody'),
    },
    {
      icon: 'boards',
      title: t('mobile.about.boardsTitle'),
      body: t('mobile.about.boardsBody'),
    },
  ];

  return (
    <>
      {/* Variant-aware header (transparent blur on Liquid Glass, opaque M3 on
          Material) from the shared hook; this screen just turns it on + titles it. */}
      <Stack.Screen options={{ ...screenOptions, title: t('mobile.about.title'), headerShown: true }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.container, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[6] }]}
      >
        <View style={[styles.hero, { backgroundColor: systemColors.secondaryBackground }]}>
          <BoardseshLogo size={88} style={styles.heroLogo} />
          <Text variant="title1" style={styles.heroTitle}>
            {t('mobile.about.heroTitle')}
          </Text>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.heroBody}>
            {t('mobile.about.heroBody')}
          </Text>
        </View>

        <View style={styles.section}>
          <SectionHeader title={t('mobile.about.sectionTitle')} />
          <View style={styles.cardStack}>
            {cards.map((card) => (
              <View key={card.title} style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
                <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
                  <Icon name={card.icon} size={22} color={systemColors.accent} />
                </View>
                <View style={styles.cardText}>
                  <Text variant="headline" style={styles.cardTitle}>
                    {card.title}
                  </Text>
                  <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.cardBody}>
                    {card.body}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View style={[styles.notice, { backgroundColor: systemColors.secondaryBackground }]}>
          <View style={styles.noticeHeader}>
            <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
              <Icon name="github" size={22} color={systemColors.accent} />
            </View>
            <Text variant="headline" style={styles.noticeHeaderTitle}>
              {t('mobile.about.openTitle')}
            </Text>
          </View>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.noticeBody}>
            {t('mobile.about.openBody')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.noticeBody}>
            {t('mobile.about.independentBody')}
          </Text>
          <Button
            title={t('mobile.about.viewOnGithub')}
            icon="github"
            size="large"
            variant="outlined"
            onPress={handleOpenGithub}
            style={styles.partnerButton}
          />
        </View>

        <View style={[styles.notice, { backgroundColor: systemColors.secondaryBackground }]}>
          <View style={styles.noticeHeader}>
            <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
              <Icon name="boards.fill" size={22} color={systemColors.accent} />
            </View>
            <Text variant="headline" style={styles.noticeHeaderTitle}>
              {t('mobile.about.partnerTitle')}
            </Text>
          </View>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.noticeBody}>
            {t('mobile.about.partnerBody')}
          </Text>
          <Button
            title={PARTNERSHIPS_EMAIL}
            icon="mail"
            size="large"
            variant="outlined"
            onPress={handlePartnerEmail}
            style={styles.partnerButton}
          />
        </View>

        <PressableSurface
          onPress={handleOpenChangelog}
          feedback="opacity"
          opacityTo={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.about.changelogLink')}
          style={[styles.linkRow, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
            <Icon name="flash" size={22} color={systemColors.accent} />
          </View>
          <View style={styles.cardText}>
            <Text variant="headline" style={styles.cardTitle}>
              {t('mobile.about.changelogLink')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.cardBody}>
              {t('mobile.about.changelogLinkBody')}
            </Text>
          </View>
          <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
        </PressableSurface>

        <PressableSurface
          onPress={handleOpenAcknowledgements}
          feedback="opacity"
          opacityTo={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.about.acknowledgementsLink')}
          style={[styles.linkRow, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <View style={[styles.cardIcon, { backgroundColor: systemColors.fill }]}>
            <Icon name="favorite.fill" size={22} color={systemColors.accent} />
          </View>
          <View style={styles.cardText}>
            <Text variant="headline" style={styles.cardTitle}>
              {t('mobile.about.acknowledgementsLink')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.cardBody}>
              {t('mobile.about.acknowledgementsLinkBody')}
            </Text>
          </View>
          <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
        </PressableSurface>

        <Button title={t('mobile.about.joinDiscord')} icon="open.external" size="large" onPress={handleJoinDiscord} />
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
    paddingVertical: spacing[8],
  },
  heroLogo: {
    marginBottom: spacing[4],
  },
  heroTitle: {
    textAlign: 'center',
    fontWeight: '800',
  },
  heroBody: {
    marginTop: spacing[3],
    textAlign: 'center',
    lineHeight: 22,
  },
  section: {
    gap: spacing[2],
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
  notice: {
    borderRadius: borderRadius.lg,
    padding: spacing[4],
  },
  noticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  noticeHeaderTitle: {
    flex: 1,
    fontWeight: '700',
  },
  noticeBody: {
    marginTop: spacing[2],
    lineHeight: 20,
  },
  partnerButton: {
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
