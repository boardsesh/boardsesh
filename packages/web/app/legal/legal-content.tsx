'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GavelOutlined } from '@mui/icons-material';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { Trans, useTranslation } from 'react-i18next';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import styles from '../about/about.module.css';

type LegalContentProps = {
  /**
   * Whether to show the build-plans section. It links to
   * `/build-plans/licence`, which 404s while the `cnc-packs` flag is off — an
   * indexed page must not carry a link into a 404, so the section appears with
   * the rest of the surface rather than ahead of it.
   */
  showBuildPlans?: boolean;
};

export default function LegalContent({ showBuildPlans = false }: LegalContentProps) {
  const { t } = useTranslation('marketing');
  return (
    <Box className={styles.pageLayout}>
      <Box component="header" className={styles.header}>
        <BackButton fallbackUrl="/" />
        <Typography variant="h4" className={styles.headerTitle}>
          {t('legal.headerTitle')}
        </Typography>
      </Box>

      <Box component="main" className={styles.content}>
        <MuiCard>
          <CardContent>
            <Stack spacing={3} className={styles.cardContent}>
              {/* Intro */}
              <section>
                <Typography variant="h3">
                  <GavelOutlined className={`${styles.sectionIcon} ${styles.primaryIcon}`} />
                  {t('legal.intro.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.intro.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.intro.p2')}
                </Typography>
              </section>

              {/* Climb Data */}
              <section>
                <Typography variant="h3">{t('legal.climbData.title')}</Typography>

                <Typography variant="h4" sx={{ mt: 2 }}>
                  {t('legal.climbData.facts.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.climbData.facts.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="legal.climbData.facts.p2" t={t} components={{ em: <em /> }} />
                </Typography>

                <Typography variant="h4" sx={{ mt: 2 }}>
                  {t('legal.climbData.community.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.climbData.community.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.climbData.community.p2')}
                </Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="legal.climbData.community.aurora" t={t} components={{ strong: <strong /> }} />
                </Typography>
                <Typography variant="body1" component="p">
                  <strong>{t('legal.climbData.community.moonLabel')}</strong> {t('legal.climbData.community.moonBody')}
                </Typography>

                <Typography variant="h4" sx={{ mt: 2 }}>
                  {t('legal.climbData.compilation.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="legal.climbData.compilation.body" t={t} components={{ em: <em /> }} />
                </Typography>
              </section>

              {/* Attribution */}
              <section>
                <Typography variant="h3">{t('legal.attribution.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('legal.attribution.intro')}
                </Typography>
                <ul className={styles.featureList}>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.attribution.item1')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.attribution.item2')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.attribution.item3Start')}{' '}
                      <MuiLink
                        href="https://github.com/marcodejongh/boardsesh/issues"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('legal.attribution.item3Link')}
                      </MuiLink>{' '}
                      {t('legal.attribution.item3End')}
                    </Typography>
                  </li>
                </ul>
              </section>

              {/* Interoperability */}
              <section>
                <Typography variant="h3">{t('legal.interop.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('legal.interop.intro')}
                </Typography>

                <Typography variant="h4" sx={{ mt: 2 }}>
                  {t('legal.interop.software.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="legal.interop.software.body" t={t} components={{ em: <em /> }} />
                </Typography>

                <Typography variant="h4" sx={{ mt: 2 }}>
                  {t('legal.interop.controller.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.interop.controller.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.interop.controller.p2')}
                </Typography>
              </section>

              {/* Trademark */}
              <section>
                <Typography variant="h3">{t('legal.trademark.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('legal.trademark.body')}
                </Typography>
              </section>

              {/* Build plans */}
              {showBuildPlans && (
                <section>
                  <Typography variant="h3">{t('legal.buildPlans.title')}</Typography>
                  <Typography variant="body1" component="p">
                    <Trans
                      i18nKey="legal.buildPlans.body"
                      t={t}
                      components={{ licence: <MuiLink component={LocaleLink} href="/build-plans/licence" /> }}
                    />
                  </Typography>
                </section>
              )}

              {/* DMCA */}
              <section>
                <Typography variant="h3">{t('legal.dmca.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('legal.dmca.intro')}
                </Typography>
                <ol className={styles.featureList}>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.dmca.item1')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.dmca.item2')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.dmca.item3')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.dmca.item4')}
                    </Typography>
                  </li>
                  <li>
                    <Typography variant="body1" component="span">
                      {t('legal.dmca.item5')}
                    </Typography>
                  </li>
                </ol>
                <Typography variant="body1" component="p">
                  {t('legal.dmca.review1')}
                </Typography>
                <Typography variant="body1" component="p">
                  <strong>{t('legal.dmca.contactLabel')}</strong>{' '}
                  {/* i18n-ignore-next-line -- contact email, not translated */}
                  <MuiLink href="mailto:legal@boardsesh.com">legal@boardsesh.com</MuiLink>
                </Typography>
              </section>

              {/* Community Note */}
              <section>
                <Typography variant="h3">{t('legal.community.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('legal.community.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.community.p2')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('legal.community.p3')}
                </Typography>
              </section>

              {/* Third-Party Notices */}
              <section>
                <Typography variant="h3">{t('legal.thirdParty.title')}</Typography>
                <ul className={styles.featureList}>
                  <li>
                    <Typography variant="body1" component="span">
                      <strong>{t('legal.thirdParty.iconLabel')}</strong> {t('legal.thirdParty.iconFrom')}{' '}
                      <MuiLink href="https://fontawesome.com" target="_blank" rel="noopener noreferrer">
                        {t('legal.thirdParty.fontAwesomeLink')}
                      </MuiLink>{' '}
                      {t('legal.thirdParty.byAuthor')} {t('legal.thirdParty.licenseLabel')}{' '}
                      <MuiLink href="https://fontawesome.com/license/free" target="_blank" rel="noopener noreferrer">
                        {t('legal.thirdParty.licenseLink')}
                      </MuiLink>
                      {t('legal.thirdParty.copyright')}
                    </Typography>
                  </li>
                </ul>
              </section>

              {/* Footer */}
              <section className={styles.callToAction}>
                <Typography variant="body2" component="p" color="text.secondary">
                  {t('legal.footer')}
                </Typography>
              </section>
            </Stack>
          </CardContent>
        </MuiCard>
      </Box>
    </Box>
  );
}
