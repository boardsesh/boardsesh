'use client';

import React from 'react';
import Image from 'next/image';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import {
  GitHub,
  FavoriteBorderOutlined,
  CreditCardOutlined,
  InfoOutlined,
  GroupOutlined,
  VolunteerActivismOutlined,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import styles from './support.module.css';

const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/boardsesh';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
const LOCALE_CATALOGS_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';
const GITHUB_REPO_URL = 'https://github.com/boardsesh/boardsesh';
const DISCORD_URL = 'https://discord.gg/YXA8GsXfQK';

type SupportContentProps = {
  /** Stripe Payment Link. Unset in most environments — the rail hides itself. */
  stripeDonateUrl: string | undefined;
};

export default function SupportContent({ stripeDonateUrl }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  return (
    <PageShell
      title={t('support.hero.title')}
      lead={t('support.hero.subtitle')}
      width="wide"
      headerAlign="center"
      headerClassName={styles.hero}
      eyebrow={<Image src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.png')} width={52} height={52} alt="" />}
      headerActions={
        <Box className={styles.heroActions}>
          <Button
            variant="contained"
            color="primaryFill"
            size="large"
            href={GITHUB_SPONSORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            startIcon={<GitHub />}
          >
            {t('support.sponsors.cta')}
          </Button>
        </Box>
      }
    >
      {/* The promise belongs next to the ask, not buried in the small print. */}
      <Box className={styles.promise}>
        <Typography variant="h5" component="p">
          {t('support.promise')}
        </Typography>
      </Box>

      <Box className={styles.contributionGrid}>
        <PageSection title={t('support.why.title')} icon={<FavoriteBorderOutlined />}>
          <Prose>{t('support.why.p1')}</Prose>
          <Prose>{t('support.why.p2')}</Prose>
        </PageSection>

        <PageSection title={t('support.rails.title')} className={styles.contributionOptions}>
          {/* The rails are the only cards on the page — that is what makes them
            findable. Everything else is prose on the page ground. */}
          <Box className={styles.rails}>
            <PageCard variant="elevated" className={styles.rail}>
              <Typography variant="h4" component="h3" className={styles.railTitle}>
                <GitHub fontSize="small" />
                {t('support.sponsors.title')}
              </Typography>
              <Typography variant="body1" component="p" color="text.secondary">
                {t('support.sponsors.body')}
              </Typography>
              <Box className={styles.railCta}>
                <Button
                  variant="contained"
                  color="primaryFill"
                  href={GITHUB_SPONSORS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('support.sponsors.cta')}
                </Button>
              </Box>
            </PageCard>

            {stripeDonateUrl ? (
              <PageCard variant="elevated" className={styles.rail} data-testid="support-one-time-rail">
                <Typography variant="h4" component="h3" className={styles.railTitle}>
                  <CreditCardOutlined fontSize="small" />
                  {t('support.oneTime.title')}
                </Typography>
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('support.oneTime.body')}
                </Typography>
                <Box className={styles.railCta}>
                  <Button variant="outlined" href={stripeDonateUrl} target="_blank" rel="noopener noreferrer">
                    {t('support.oneTime.cta')}
                  </Button>
                </Box>
              </PageCard>
            ) : null}
          </Box>
        </PageSection>
      </Box>

      {/* The page's second column of substance. Without it, an environment with
          no Stripe link is one card and a lot of prose. */}
      <PageSection
        title={t('support.otherWays.title')}
        lead={t('support.otherWays.body')}
        icon={<VolunteerActivismOutlined />}
        tone="neutral"
        className={styles.communitySection}
      >
        <Box className={styles.helpGrid}>
          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.bug.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.bug.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.bug.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.translate.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.translate.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={LOCALE_CATALOGS_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.translate.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.patch.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.patch.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.patch.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.discord.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.discord.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.discord.cta')}
              </MuiLink>
            </Typography>
          </Box>
        </Box>
      </PageSection>

      <PageSection title={t('support.thanks.title')} icon={<GroupOutlined />} tone="neutral">
        <Prose>{t('support.thanks.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/about">
            {t('support.aboutLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection
        className={styles.disclosure}
        title={t('support.honesty.title')}
        icon={<InfoOutlined />}
        tone="neutral"
      >
        <Prose>{t('support.honesty.p1')}</Prose>
        <Prose>{t('support.honesty.p2')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/docs">
            {t('support.docsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('support.footer')}
        </Typography>
      </PageSection>
    </PageShell>
  );
}
