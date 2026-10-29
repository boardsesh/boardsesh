'use client';

import React, { useEffect } from 'react';
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
import { brandCtaSx, brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import { SUPPORT_BANNER_SUPPORTER_KEY } from '@/app/components/home/support-banner-window';
import { setPreference } from '@/app/lib/user-preferences-db';
import type { SupportPageOptions } from './support-links';
import SupportChooser, { SUPPORT_CHOOSER_ID } from './support-chooser';
import { trackSupportCta } from './support-analytics';
import styles from './support.module.css';

const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/boardsesh';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
const LOCALE_CATALOGS_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';
const GITHUB_REPO_URL = 'https://github.com/boardsesh/boardsesh';
const DISCORD_URL = 'https://discord.gg/YXA8GsXfQK';
const DONATION_CTA_SX = brandCtaSx();
// With monthly first, GitHub Sponsors is the third option, so it steps down to
// the outlined pill and the monthly buttons keep the only fills on the card stack.
const SPONSORS_SECONDARY_SX = brandCtaOutlinedSx({ size: 'medium' });

type SupportContentProps = {
  /** Every link the env configured, already tagged with `src`. */
  options: SupportPageOptions;
  /** The sanitised `?src=`, for the click events. */
  src: string;
  /** `?thanks=1`: Stripe sends a giver back here after checkout. */
  thanks: boolean;
};

/**
 * Two layouts, picked by the env:
 *
 *  - Monthly first (any `SUPPORT_MONTHLY_LINKS_*` set): the chooser, with GitHub
 *    Sponsors as the third option under it.
 *  - Otherwise the page as it was: GitHub Sponsors up top, and a one-off Stripe
 *    card when a one-off link exists.
 */
export default function SupportContent({ options, src, thanks }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  const { monthlyFirst } = options;
  const onceCurrency = options.once[options.defaultCurrency] ? options.defaultCurrency : options.currencies[0];
  const stripeDonateUrl = onceCurrency ? options.once[onceCurrency] : undefined;
  // Someone Stripe just sent back here has given: the homepage's monthly
  // banner must not ask them again.
  useEffect(() => {
    if (thanks) void setPreference(SUPPORT_BANNER_SUPPORTER_KEY, true);
  }, [thanks]);
  const trackSponsors = (placement: 'hero' | 'options') =>
    trackSupportCta({ cadence: 'sponsors', currency: 'none', src, option: 1, placement });
  return (
    <PageShell
      title={t('support.hero.title')}
      lead={t('support.hero.subtitle')}
      width="wide"
      headerAlign="center"
      headerClassName={styles.hero}
      eyebrow={<Image src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp')} width={52} height={52} alt="" />}
      headerActions={
        <Box className={styles.heroActions}>
          {monthlyFirst ? (
            <Button
              variant="contained"
              color="primaryFill"
              size="large"
              href={`#${SUPPORT_CHOOSER_ID}`}
              startIcon={<FavoriteBorderOutlined />}
              sx={DONATION_CTA_SX}
            >
              {t('support.hero.ctaMonthly')}
            </Button>
          ) : (
            <Button
              variant="contained"
              color="primaryFill"
              size="large"
              href={GITHUB_SPONSORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              startIcon={<GitHub />}
              sx={DONATION_CTA_SX}
              onClick={() => trackSponsors('hero')}
            >
              {t('support.sponsors.cta')}
            </Button>
          )}
        </Box>
      }
    >
      {thanks ? (
        <PageCard variant="elevated" className={styles.thanksCard} data-testid="support-thanks" role="status">
          <Typography variant="h4" component="h2">
            {t('support.thanksState.title')}
          </Typography>
          <Typography variant="body1" component="p" color="text.secondary">
            {t('support.thanksState.body')}
          </Typography>
        </PageCard>
      ) : null}

      {/* The promise belongs next to the ask, not buried in the small print. */}
      <Box className={styles.promise}>
        <Typography variant="h5" component="p">
          {monthlyFirst ? t('support.promiseMonthly') : t('support.promise')}
        </Typography>
      </Box>

      <Box className={styles.contributionGrid}>
        <PageSection title={t('support.why.title')} icon={<FavoriteBorderOutlined />}>
          <Prose>{monthlyFirst ? t('support.why.p1Monthly') : t('support.why.p1')}</Prose>
          <Prose>{monthlyFirst ? t('support.why.p2Monthly') : t('support.why.p2')}</Prose>
        </PageSection>

        <PageSection title={t('support.rails.title')} className={styles.contributionOptions}>
          {/* The rails are the only cards on the page — that is what makes them
            findable. Everything else is prose on the page ground. */}
          <Box className={styles.rails}>
            {monthlyFirst ? <SupportChooser options={options} src={src} /> : null}
            <PageCard variant="elevated" className={styles.rail} data-testid="support-sponsors-rail">
              <Typography variant="h4" component="h3" className={styles.railTitle}>
                <GitHub fontSize="small" />
                {t('support.sponsors.title')}
              </Typography>
              <Typography variant="body1" component="p" color="text.secondary">
                {t('support.sponsors.body')}
              </Typography>
              <Box className={styles.railCta}>
                <Button
                  variant={monthlyFirst ? 'outlined' : 'contained'}
                  color={monthlyFirst ? 'primary' : 'primaryFill'}
                  href={GITHUB_SPONSORS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={monthlyFirst ? SPONSORS_SECONDARY_SX : DONATION_CTA_SX}
                  onClick={() => trackSponsors('options')}
                >
                  {t('support.sponsors.cta')}
                </Button>
              </Box>
            </PageCard>

            {!monthlyFirst && stripeDonateUrl && onceCurrency ? (
              <PageCard variant="elevated" className={styles.rail} data-testid="support-one-time-rail">
                <Typography variant="h4" component="h3" className={styles.railTitle}>
                  <CreditCardOutlined fontSize="small" />
                  {t('support.oneTime.title')}
                </Typography>
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('support.oneTime.body')}
                </Typography>
                <Box className={styles.railCta}>
                  <Button
                    variant="outlined"
                    href={stripeDonateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ borderRadius: 'var(--border-radius-full)', textTransform: 'none', minHeight: 44 }}
                    onClick={() =>
                      trackSupportCta({ cadence: 'once', currency: onceCurrency, src, option: 1, placement: 'options' })
                    }
                  >
                    {t('support.oneTime.cta')}
                  </Button>
                </Box>
              </PageCard>
            ) : null}
          </Box>
        </PageSection>
      </Box>

      <PageSection
        className={styles.disclosure}
        title={t('support.honesty.title')}
        icon={<InfoOutlined />}
        tone="neutral"
      >
        <Prose>{monthlyFirst ? t('support.honesty.p1Monthly') : t('support.honesty.p1')}</Prose>
        <Prose>{monthlyFirst ? t('support.honesty.p2Monthly') : t('support.honesty.p2')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/docs" className={styles.standaloneLink}>
            {t('support.docsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

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
          <MuiLink component={LocaleLink} href="/about" className={styles.standaloneLink}>
            {t('support.aboutLink')}
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
