'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpWalkthrough } from '../help-clip';
import styles from './spray-walls-content.module.css';

/** The mobile wizard links here for photo advice and current editor gestures. */
export default function SprayWallsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.sprayWalls.hero.title')}
      lead={t('help.sprayWalls.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.sprayWalls.breadcrumb')} />}
    >
      <PageSection title={t('help.sprayWalls.watch.title')}>
        <HelpWalkthrough name="spray-walls-walkthrough" alt={t('help.sprayWalls.watch.videoAlt')} />
        <Prose>{t('help.sprayWalls.watch.p1')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.photo.title')}>
        <Prose>{t('help.sprayWalls.photo.p1')}</Prose>
        <ProseList>
          <li>{t('help.sprayWalls.photo.square')}</li>
          <li>{t('help.sprayWalls.photo.portrait')}</li>
          <li>{t('help.sprayWalls.photo.tilt')}</li>
          <li>{t('help.sprayWalls.photo.frame')}</li>
          <li>{t('help.sprayWalls.photo.zoom')}</li>
          <li>{t('help.sprayWalls.photo.lighting')}</li>
        </ProseList>
        <Prose>{t('help.sprayWalls.photo.why')}</Prose>
        <Box component="figure" className={styles.photoFigure}>
          <Image
            src={resolveStaticAssetUrl('/images/help/spray-wall-photo.webp')}
            alt={t('help.sprayWalls.photo.exampleAlt')}
            width={1752}
            height={2047}
            sizes="(max-width: 760px) 100vw, 760px"
            className={styles.photo}
          />
          <Typography component="figcaption" variant="body2" className={styles.photoCaption}>
            {t('help.sprayWalls.photo.exampleCaption')}
          </Typography>
        </Box>
      </PageSection>

      <PageSection title={t('help.sprayWalls.add.title')}>
        <ProseList ordered>
          <li>{t('help.sprayWalls.add.step1')}</li>
          <li>{t('help.sprayWalls.add.step2')}</li>
          <li>{t('help.sprayWalls.add.step3')}</li>
          <li>{t('help.sprayWalls.add.step4')}</li>
          <li>{t('help.sprayWalls.add.step5')}</li>
        </ProseList>
      </PageSection>

      <PageSection title={t('help.sprayWalls.fix.title')}>
        <Prose>{t('help.sprayWalls.fix.p1')}</Prose>
        <ProseList>
          <li>{t('help.sprayWalls.fix.maybe')}</li>
          <li>{t('help.sprayWalls.fix.toggle')}</li>
          <li>{t('help.sprayWalls.fix.longPress')}</li>
          <li>{t('help.sprayWalls.fix.missed')}</li>
        </ProseList>
        <Prose>{t('help.sprayWalls.fix.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.later.title')}>
        <Prose>{t('help.sprayWalls.later.p1')}</Prose>
        <Prose>{t('help.sprayWalls.later.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/logbook">
              {t('help.sprayWalls.next.logbook')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/sessions">
              {t('help.sprayWalls.next.sessions')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.sprayWalls.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
