'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Box from '@mui/material/Box';
import { GitHub, FavoriteBorderOutlined, CreditCardOutlined, InfoOutlined, GroupOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import styles from './support.module.css';

const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/boardsesh';

type SupportContentProps = {
  /** Stripe Payment Link. Unset in most environments — the rail hides itself. */
  stripeDonateUrl: string | undefined;
};

export default function SupportContent({ stripeDonateUrl }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  return (
    <PageShell title={t('support.hero.title')} lead={t('support.hero.subtitle')} headerAlign="center">
      <PageSection title={t('support.why.title')} icon={<FavoriteBorderOutlined />}>
        <Prose>{t('support.why.p1')}</Prose>
        <Prose>{t('support.why.p2')}</Prose>
      </PageSection>

      <PageSection title={t('support.rails.title')}>
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
            <Typography variant="body1" component="p" className={styles.railCta}>
              <MuiLink href={GITHUB_SPONSORS_URL} target="_blank" rel="noopener noreferrer">
                {t('support.sponsors.cta')}
              </MuiLink>
            </Typography>
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
              <Typography variant="body1" component="p" className={styles.railCta}>
                <MuiLink href={stripeDonateUrl} target="_blank" rel="noopener noreferrer">
                  {t('support.oneTime.cta')}
                </MuiLink>
              </Typography>
            </PageCard>
          ) : null}
        </Box>
      </PageSection>

      <PageSection title={t('support.honesty.title')} icon={<InfoOutlined />} tone="accent">
        <Prose>{t('support.honesty.p1')}</Prose>
        <Prose>{t('support.honesty.p2')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/docs">
            {t('support.docsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('support.thanks.title')} icon={<GroupOutlined />} tone="neutral">
        <Prose>{t('support.thanks.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/about">
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
