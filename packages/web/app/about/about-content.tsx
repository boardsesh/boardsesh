'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Avatar from '@mui/material/Avatar';
import { GitHub, GroupOutlined, FavoriteBorderOutlined, ApiOutlined, RocketLaunchOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose } from '@/app/components/ui/page-shell';
import { MarketingScreenshot, MarketingPreviewSwitch } from '@/app/components/marketing/marketing-screenshot';
import styles from './about.module.css';
import { sponsors } from '@boardsesh/acknowledgements';
import type { PublicSupporter } from '@boardsesh/graphql/operations/support';

export default function AboutContent({ stripeSupporters }: { stripeSupporters: PublicSupporter[] }) {
  const { t } = useTranslation('marketing');
  return (
    <PageShell title={t('about.hero.title')} lead={t('about.hero.subtitle')} width="wide">
      <Box className={styles.story}>
        {/* The old "Our Vision" said the same thing the landing page says, in the
            same words. This is the part only About can tell: what the problem
            actually was, and what happened when it bit. The Aurora outage is
            written up properly on /aurora-migration — link to it rather than
            re-litigate someone else's dispute on a marketing page. */}
        <PageSection title={t('about.story.title')} icon={<RocketLaunchOutlined />} className={styles.vision}>
          <Prose>{t('about.story.p1')}</Prose>
          <Prose>{t('about.story.p2')}</Prose>
          <Prose>
            <MuiLink component={LocaleLink} href="/aurora-migration">
              {t('about.story.link')}
            </MuiLink>
          </Prose>
        </PageSection>
        <Box component="figure" className={styles.preview}>
          <Typography component="figcaption" className={styles.caption}>
            {t('about.profile.title')}
          </Typography>
          <MarketingPreviewSwitch />
          <MarketingScreenshot
            shot="profile"
            alt={t('about.profile.shotAlt')}
            preload
            className={styles.screenshot}
            sizes="(max-width: 760px) 240px, 280px"
          />
        </Box>

        {/* The feature list that was here repeated the landing page's own feature
            strip as bolded-label bullets. Who builds it, and what is coming, are
            the things a reader cannot get anywhere else. */}
        <PageSection title={t('about.who.title')} icon={<GroupOutlined />} tone="neutral" className={styles.features}>
          <Prose>{t('about.who.body')}</Prose>
          <Prose>
            <MuiLink
              href="https://github.com/boardsesh/boardsesh/graphs/contributors"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.who.cta')}
            </MuiLink>
          </Prose>
        </PageSection>

        <PageSection title={t('about.next.title')} icon={<ApiOutlined />} tone="neutral" className={styles.features}>
          <Prose>{t('about.next.body')}</Prose>
          <Prose>
            <MuiLink
              href="https://github.com/boardsesh/boardsesh/blob/main/ROADMAP.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('about.next.cta')}
            </MuiLink>
          </Prose>
        </PageSection>
      </Box>

      <Box className={styles.openProject}>
        <PageSection
          title={t('about.openSource.title')}
          icon={<GitHub />}
          tone="neutral"
          className={styles.projectSection}
        >
          <Prose>{t('about.openSource.body')}</Prose>
          <Prose>
            <MuiLink href="https://github.com/boardsesh/boardsesh" target="_blank" rel="noopener noreferrer">
              {t('about.openSource.cta')}
            </MuiLink>
          </Prose>
        </PageSection>

        <PageSection title={t('about.api.title')} icon={<ApiOutlined />} className={styles.projectSection}>
          <Prose>{t('about.api.body')}</Prose>
          <Prose>
            <MuiLink component={LocaleLink} href="/docs">
              {t('about.api.cta')}
            </MuiLink>
          </Prose>
        </PageSection>
      </Box>

      <PageSection title={t('about.supporters.title')} icon={<FavoriteBorderOutlined />} className={styles.supporters}>
        <Prose>{t('about.supporters.body')}</Prose>
        {stripeSupporters.length > 0 ? (
          <Box className={styles.supporterGroup}>
            <Typography variant="h5" component="h3">
              {t('about.supporters.stripeTitle')}
            </Typography>
            <Box className={styles.supporterList}>
              {stripeSupporters.map((supporter) => (
                <MuiLink
                  key={supporter.userId}
                  component={LocaleLink}
                  href={`/profile/${supporter.userId}`}
                  className={styles.supporter}
                >
                  <Avatar src={supporter.avatarUrl ?? undefined} alt="" className={styles.supporterAvatar} />
                  {supporter.displayName}
                </MuiLink>
              ))}
            </Box>
          </Box>
        ) : null}
        {sponsors.length > 0 ? (
          <Box className={styles.supporterGroup}>
            <Typography variant="h5" component="h3">
              {t('about.supporters.githubTitle')}
            </Typography>
            <Box className={styles.supporterList}>
              {sponsors.map((sponsor) => (
                <MuiLink
                  key={sponsor.login}
                  href={sponsor.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.supporter}
                >
                  <Avatar src={sponsor.avatarUrl} alt="" className={styles.supporterAvatar} />
                  {sponsor.name ?? sponsor.login}
                </MuiLink>
              ))}
            </Box>
          </Box>
        ) : null}
      </PageSection>

      <PageSection title={t('about.community.title')} icon={<FavoriteBorderOutlined />} className={styles.community}>
        <Prose>{t('about.community.body')}</Prose>
        <Box className={styles.communityLinks}>
          <MuiLink href="https://discord.gg/YXA8GsXfQK" target="_blank" rel="noopener noreferrer">
            {t('about.community.discord')}
          </MuiLink>
          <MuiLink component={LocaleLink} href="/support">
            {t('about.community.support')}
          </MuiLink>
        </Box>
        <Prose>
          <MuiLink component={LocaleLink} href="/legal">
            {t('about.legalLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('about.footer')}
        </Typography>
      </PageSection>
    </PageShell>
  );
}
