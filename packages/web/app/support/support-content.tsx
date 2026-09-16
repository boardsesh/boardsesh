'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { GitHub, FavoriteBorderOutlined, CreditCardOutlined, InfoOutlined, GroupOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import styles from './support.module.css';

const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/boardsesh';

type SupportContentProps = {
  /** Stripe Payment Link. Unset in most environments — the rail hides itself. */
  stripeDonateUrl: string | undefined;
};

export default function SupportContent({ stripeDonateUrl }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  return (
    <Box className={styles.pageLayout}>
      <Box component="header" className={styles.header}>
        <BackButton fallbackUrl="/" />
        <Logo size="sm" showText={false} />
        {/* `component="p"`: page chrome, not a heading — a literal <h4> here
            would sit above the hero's <h1> and scramble the outline. */}
        <Typography variant="h4" component="p" className={styles.headerTitle}>
          {t('support.headerTitle')}
        </Typography>
      </Box>

      <Box component="main" className={styles.content}>
        <MuiCard>
          <CardContent>
            <Stack spacing={3} className={styles.cardContent}>
              <div className={styles.heroSection}>
                <Logo size="lg" linkToHome={false} />
                <Typography variant="h2" component="h1" className={styles.heroTitle}>
                  {t('support.hero.title')}
                </Typography>
                <Typography variant="body2" component="span" color="text.secondary" className={styles.heroSubtitle}>
                  {t('support.hero.subtitle')}
                </Typography>
              </div>

              <section>
                <Typography variant="h3" component="h2">
                  <FavoriteBorderOutlined className={`${styles.sectionIcon} ${styles.primaryIcon}`} />
                  {t('support.why.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('support.why.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('support.why.p2')}
                </Typography>
              </section>

              <section>
                <Typography variant="h3" component="h2">
                  {t('support.rails.title')}
                </Typography>
                <Box className={styles.rails}>
                  <Box className={styles.rail}>
                    <Typography variant="h4" component="h3" className={styles.railTitle}>
                      <GitHub className={styles.sectionIcon} />
                      {t('support.sponsors.title')}
                    </Typography>
                    <Typography variant="body2" component="p" color="text.secondary">
                      {t('support.sponsors.body')}
                    </Typography>
                    <Typography variant="body1" component="p" className={styles.railCta}>
                      <MuiLink href={GITHUB_SPONSORS_URL} target="_blank" rel="noopener noreferrer">
                        {t('support.sponsors.cta')}
                      </MuiLink>
                    </Typography>
                  </Box>

                  {stripeDonateUrl ? (
                    <Box className={styles.rail} data-testid="support-one-time-rail">
                      <Typography variant="h4" component="h3" className={styles.railTitle}>
                        <CreditCardOutlined className={`${styles.sectionIcon} ${styles.successIcon}`} />
                        {t('support.oneTime.title')}
                      </Typography>
                      <Typography variant="body2" component="p" color="text.secondary">
                        {t('support.oneTime.body')}
                      </Typography>
                      <Typography variant="body1" component="p" className={styles.railCta}>
                        <MuiLink href={stripeDonateUrl} target="_blank" rel="noopener noreferrer">
                          {t('support.oneTime.cta')}
                        </MuiLink>
                      </Typography>
                    </Box>
                  ) : null}
                </Box>
              </section>

              <section>
                <Typography variant="h3" component="h2">
                  <InfoOutlined className={`${styles.sectionIcon} ${styles.warningIcon}`} />
                  {t('support.honesty.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('support.honesty.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('support.honesty.p2')}
                </Typography>
                <Typography variant="body1" component="p">
                  <MuiLink component={LocaleLink} href="/docs">
                    {t('support.docsLink')}
                  </MuiLink>
                </Typography>
              </section>

              <section>
                <Typography variant="h3" component="h2">
                  <GroupOutlined className={`${styles.sectionIcon} ${styles.successIcon}`} />
                  {t('support.thanks.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('support.thanks.body')}
                </Typography>
                <Typography variant="body1" component="p">
                  <MuiLink component={LocaleLink} href="/about">
                    {t('support.aboutLink')}
                  </MuiLink>
                </Typography>
              </section>

              <section className={styles.callToAction}>
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('support.footer')}
                </Typography>
              </section>
            </Stack>
          </CardContent>
        </MuiCard>
      </Box>
    </Box>
  );
}
