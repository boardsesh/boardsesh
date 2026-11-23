'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GitHub, GroupOutlined, FavoriteBorderOutlined, ApiOutlined, RocketLaunchOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose } from '@/app/components/ui/page-shell';
import TrustFaq from '@/app/components/marketing/trust-faq';
import { MarketingScreenshot } from '@/app/components/marketing/marketing-screenshot';
import { MarketingPreviewSwitch } from '@/app/components/marketing/marketing-preview-switch';
import styles from './about.module.css';
import type { DeveloperDocsState } from '@/app/lib/developer-apps/docs-access';

export default function AboutContent({
  developerDocsState = 'unavailable',
}: {
  developerDocsState?: DeveloperDocsState;
}) {
  const { t } = useTranslation('marketing');
  return (
    <PageShell title={t('about.hero.title')} lead={t('about.hero.subtitle')} width="wide">
      <Box className={styles.story}>
        <PageSection title={t('about.story.title')} icon={<RocketLaunchOutlined />} className={styles.vision}>
          <Prose>{t('about.story.p1')}</Prose>
          <Prose>{t('about.story.p2')}</Prose>
          <Prose>
            <MuiLink component={LocaleLink} href="/bring-your-logbook#old-kilter-app">
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
          <Prose>{t(`about.api.status.${developerDocsState}`)}</Prose>
          {developerDocsState !== 'unavailable' ? (
            <Prose>
              <MuiLink component={LocaleLink} href="/developers">
                {t('about.api.cta')}
              </MuiLink>
            </Prose>
          ) : null}
        </PageSection>
      </Box>

      <TrustFaq />

      <PageSection title={t('funding.title')}>
        <Prose>{t('funding.body')}</Prose>
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
