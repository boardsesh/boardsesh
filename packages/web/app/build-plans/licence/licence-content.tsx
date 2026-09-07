'use client';

import React from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Trans, useTranslation } from 'react-i18next';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageFrame } from '../ui';
import styles from '../build-plans.module.css';

const LICENCE_EMAIL = 'mailto:legal@boardsesh.com';
const VOLUME_EMAIL = 'mailto:support@boardsesh.com';

/**
 * The manufacturing licence that ships with every build-plans pack.
 *
 * Deliberately a plain reading page, not a sales page: the copy on
 * `/build-plans` sells the packs, this states the terms. So the type here is
 * set for reading rather than scanning — a 68ch measure, 1.7 leading, clauses
 * separated by a rule instead of by twelve cards — and the only colour is the
 * violet on the links.
 *
 * The DRAFT banner is the first thing in the document flow because the text has
 * not been through an Australian IP lawyer yet, and someone landing here from a
 * purchase flow has to see that before they read a price.
 *
 * Clause numbers come from the catalog strings ("3. Personal licence (A$149)"),
 * not from a CSS counter: those numbers are part of the licence a buyer may
 * quote back at us, so they belong in the translated text.
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
    <Box>
      <Typography variant="body2" component="p" className={styles.ruleLabel}>
        {label}
      </Typography>
      <Box component="ul" className={styles.ruleList}>
        {rules.map((rule) => (
          <Typography key={rule} variant="body2" component="li">
            {rule}
          </Typography>
        ))}
      </Box>
    </Box>
  );

  const renderParagraphs = (paragraphs: string[]) => (
    <Box className={styles.clauseBody}>
      {paragraphs.map((paragraph) => (
        <Typography key={paragraph} variant="body1" component="p">
          {paragraph}
        </Typography>
      ))}
    </Box>
  );

  // One list, so the contents rail and the document cannot disagree about what
  // is in the licence or what order it is in.
  const clauses = [
    {
      id: 'parties',
      title: t('licence.parties.title'),
      body: (
        <Box className={styles.clauseBody}>
          {definitions.map((definition) => (
            <Typography key={definition.key} variant="body1" component="p" className={styles.definition}>
              <strong>{definition.term}</strong> {definition.body}
            </Typography>
          ))}
        </Box>
      ),
    },
    {
      id: 'grant',
      title: t('licence.grant.title'),
      body: renderParagraphs([t('licence.grant.p1'), t('licence.grant.p2')]),
    },
    {
      id: 'personal',
      title: t('licence.personal.title'),
      body: (
        <Box className={styles.clauseBody}>
          <Typography variant="body1" component="p">
            {t('licence.personal.summary')}
          </Typography>
          <Box className={styles.ruleColumns}>
            {renderRules(t('licence.labels.allowed'), personalAllowed)}
            {renderRules(t('licence.labels.notAllowed'), personalNotAllowed)}
          </Box>
        </Box>
      ),
    },
    {
      id: 'commercial',
      title: t('licence.commercial.title'),
      body: (
        <Box className={styles.clauseBody}>
          <Typography variant="body1" component="p">
            {t('licence.commercial.summary')}
          </Typography>
          <Box className={styles.ruleColumns}>
            {renderRules(t('licence.labels.allowed'), commercialAllowed)}
            {renderRules(t('licence.labels.notAllowed'), commercialNotAllowed)}
          </Box>
        </Box>
      ),
    },
    {
      id: 'volume',
      title: t('licence.volume.title'),
      body: (
        <Box className={styles.clauseBody}>
          <Typography variant="body1" component="p">
            <Trans i18nKey="licence.volume.body" t={t} components={{ mail: <MuiLink href={VOLUME_EMAIL} /> }} />
          </Typography>
        </Box>
      ),
    },
    {
      id: 'fingerprint',
      title: t('licence.fingerprint.title'),
      body: renderParagraphs([t('licence.fingerprint.p1'), t('licence.fingerprint.p2'), t('licence.fingerprint.p3')]),
    },
    {
      id: 'compatibility',
      title: t('licence.compatibility.title'),
      body: (
        <Box className={styles.clauseBody}>
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
        </Box>
      ),
    },
    {
      id: 'safety',
      title: t('licence.safety.title'),
      body: renderParagraphs([t('licence.safety.p1'), t('licence.safety.p2'), t('licence.safety.p3')]),
    },
    {
      id: 'refunds',
      title: t('licence.refunds.title'),
      body: renderParagraphs([t('licence.refunds.body')]),
    },
    {
      id: 'privacy',
      title: t('licence.privacy.title'),
      body: (
        <Box className={styles.clauseBody}>
          <Typography variant="body1" component="p">
            <Trans
              i18nKey="licence.privacy.body"
              t={t}
              components={{ privacy: <MuiLink component={LocaleLink} href="/privacy" /> }}
            />
          </Typography>
        </Box>
      ),
    },
    {
      id: 'governing-law',
      title: t('licence.governingLaw.title'),
      body: renderParagraphs([t('licence.governingLaw.body')]),
    },
    {
      id: 'contact',
      title: t('licence.contact.title'),
      body: (
        <Box className={styles.clauseBody}>
          <Typography variant="body1" component="p">
            <Trans i18nKey="licence.contact.body" t={t} components={{ mail: <MuiLink href={LICENCE_EMAIL} /> }} />
          </Typography>
        </Box>
      ),
    },
  ];

  return (
    <PageFrame
      title={t('licence.headerTitle')}
      intro={t('licence.intro.p1')}
      eyebrow={<BackButton fallbackUrl="/build-plans" />}
    >
      <Alert severity="warning">
        <AlertTitle>{t('licence.draft.title')}</AlertTitle>
        {t('licence.draft.body')}
      </Alert>

      <Box className={styles.licenceLayout}>
        <Box component="nav" aria-label={t('licence.contents')} className={styles.licenceToc}>
          <Typography variant="subtitle2" component="h2" className={styles.tocHeading}>
            {t('licence.contents')}
          </Typography>
          <Box component="ol" className={styles.tocList}>
            {clauses.map((clause) => (
              <li key={clause.id}>
                <Typography variant="body2" component="a" href={`#${clause.id}`} className={styles.tocLink}>
                  {clause.title}
                </Typography>
              </li>
            ))}
          </Box>
        </Box>

        <Box component="article">
          <Typography variant="h2" component="h2" className={styles.documentTitle}>
            {t('licence.intro.title')}
          </Typography>
          <Box component="ol" className={styles.clauseList}>
            {clauses.map((clause) => (
              <li key={clause.id} id={clause.id} className={styles.clause}>
                <Typography variant="h4" component="h3" className={styles.clauseTitle}>
                  {clause.title}
                </Typography>
                {clause.body}
              </li>
            ))}
          </Box>
          <Typography variant="body2" component="p" className={styles.licenceFooter}>
            {t('licence.footer')}
          </Typography>
        </Box>
      </Box>
    </PageFrame>
  );
}
