'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { GavelOutlined } from '@mui/icons-material';
import { Trans, useTranslation } from 'react-i18next';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import styles from '../../about/about.module.css';

const LICENCE_EMAIL = 'mailto:legal@boardsesh.com';
const VOLUME_EMAIL = 'mailto:support@boardsesh.com';

/**
 * The manufacturing licence that ships with every build-plans pack.
 *
 * Deliberately a plain reading page, not a sales page: the copy above it sells
 * the packs, this states the terms. The DRAFT banner is the first thing in the
 * document flow because the text has not been through an Australian IP lawyer
 * yet, and someone landing here from a purchase flow has to see that before
 * they read a price.
 */
export default function LicenceContent() {
  const { t } = useTranslation('cnc-legal');

  const definitions = [
    { key: 'boardsesh', term: t('licence.parties.boardsesh.term'), body: t('licence.parties.boardsesh.definition') },
    { key: 'licensee', term: t('licence.parties.licensee.term'), body: t('licence.parties.licensee.definition') },
    { key: 'pack', term: t('licence.parties.pack.term'), body: t('licence.parties.pack.definition') },
    { key: 'wall', term: t('licence.parties.wall.term'), body: t('licence.parties.wall.definition') },
  ];

  const personalAllowed = [t('licence.personal.allowed1'), t('licence.personal.allowed2')];
  const personalNotAllowed = [
    t('licence.personal.notAllowed1'),
    t('licence.personal.notAllowed2'),
    t('licence.personal.notAllowed3'),
    t('licence.personal.notAllowed4'),
  ];
  const commercialAllowed = [t('licence.commercial.allowed1'), t('licence.commercial.allowed2')];
  const commercialNotAllowed = [
    t('licence.commercial.notAllowed1'),
    t('licence.commercial.notAllowed2'),
    t('licence.commercial.notAllowed3'),
  ];

  const renderRules = (label: string, rules: string[]) => (
    <>
      <Typography variant="subtitle2" component="p" sx={{ mt: 2 }}>
        {label}
      </Typography>
      <ul className={styles.featureList}>
        {rules.map((rule) => (
          <li key={rule}>
            <Typography variant="body1" component="span">
              {rule}
            </Typography>
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <Box className={styles.pageLayout}>
      <Box component="header" className={styles.header}>
        {/* Home, not /build-plans: the shop page arrives in a later PR, and a
            back button that lands on a 404 is worse than one that lands home. */}
        <BackButton fallbackUrl="/" />
        <Typography variant="h4" className={styles.headerTitle}>
          {t('licence.headerTitle')}
        </Typography>
      </Box>

      <Box component="main" className={styles.content}>
        <Alert severity="warning" className={styles.alert}>
          <AlertTitle>{t('licence.draft.title')}</AlertTitle>
          {t('licence.draft.body')}
        </Alert>

        <MuiCard>
          <CardContent>
            <Stack spacing={3} className={styles.cardContent}>
              <section>
                <Typography variant="h3" component="h1">
                  <GavelOutlined className={`${styles.sectionIcon} ${styles.primaryIcon}`} />
                  {t('licence.intro.title')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.intro.p1')}
                </Typography>
              </section>

              {/* 1. Parties and definitions */}
              <section>
                <Typography variant="h3">{t('licence.parties.title')}</Typography>
                {definitions.map((definition) => (
                  <Typography key={definition.key} variant="body1" component="p">
                    <strong>{definition.term}</strong> {definition.body}
                  </Typography>
                ))}
              </section>

              {/* 2. What you get */}
              <section>
                <Typography variant="h3">{t('licence.grant.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.grant.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.grant.p2')}
                </Typography>
              </section>

              {/* 3. Personal licence */}
              <section>
                <Typography variant="h3">{t('licence.personal.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.personal.summary')}
                </Typography>
                {renderRules(t('licence.labels.allowed'), personalAllowed)}
                {renderRules(t('licence.labels.notAllowed'), personalNotAllowed)}
              </section>

              {/* 4. Commercial single-build licence */}
              <section>
                <Typography variant="h3">{t('licence.commercial.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.commercial.summary')}
                </Typography>
                {renderRules(t('licence.labels.allowed'), commercialAllowed)}
                {renderRules(t('licence.labels.notAllowed'), commercialNotAllowed)}
              </section>

              {/* 5. Ten builds and OEM */}
              <section>
                <Typography variant="h3">{t('licence.volume.title')}</Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="licence.volume.body" t={t} components={{ mail: <MuiLink href={VOLUME_EMAIL} /> }} />
                </Typography>
              </section>

              {/* 6. Fingerprinting and enforcement */}
              <section>
                <Typography variant="h3">{t('licence.fingerprint.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.fingerprint.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.fingerprint.p2')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.fingerprint.p3')}
                </Typography>
              </section>

              {/* 7. Compatibility */}
              <section>
                <Typography variant="h3">{t('licence.compatibility.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.compatibility.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  <Trans
                    i18nKey="licence.compatibility.p2"
                    t={t}
                    components={{ legal: <MuiLink component={LocaleLink} href="/legal" /> }}
                  />
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.compatibility.p3')}
                </Typography>
              </section>

              {/* 8. Safety and responsibility */}
              <section>
                <Typography variant="h3">{t('licence.safety.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.safety.p1')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.safety.p2')}
                </Typography>
                <Typography variant="body1" component="p">
                  {t('licence.safety.p3')}
                </Typography>
              </section>

              {/* 9. Refunds */}
              <section>
                <Typography variant="h3">{t('licence.refunds.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.refunds.body')}
                </Typography>
              </section>

              {/* 10. Privacy */}
              <section>
                <Typography variant="h3">{t('licence.privacy.title')}</Typography>
                <Typography variant="body1" component="p">
                  <Trans
                    i18nKey="licence.privacy.body"
                    t={t}
                    components={{ privacy: <MuiLink component={LocaleLink} href="/privacy" /> }}
                  />
                </Typography>
              </section>

              {/* 11. Governing law */}
              <section>
                <Typography variant="h3">{t('licence.governingLaw.title')}</Typography>
                <Typography variant="body1" component="p">
                  {t('licence.governingLaw.body')}
                </Typography>
              </section>

              {/* 12. Contact */}
              <section>
                <Typography variant="h3">{t('licence.contact.title')}</Typography>
                <Typography variant="body1" component="p">
                  <Trans i18nKey="licence.contact.body" t={t} components={{ mail: <MuiLink href={LICENCE_EMAIL} /> }} />
                </Typography>
              </section>

              <section className={styles.callToAction}>
                <Typography variant="body2" component="p" color="text.secondary">
                  {t('licence.footer')}
                </Typography>
              </section>
            </Stack>
          </CardContent>
        </MuiCard>
      </Box>
    </Box>
  );
}
