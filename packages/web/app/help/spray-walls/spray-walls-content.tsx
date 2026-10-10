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
import { HelpScreenshot, HelpShots } from '../help-screenshot';
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
          <li>{t('help.sprayWalls.fix.select')}</li>
          <li>{t('help.sprayWalls.fix.add')}</li>
          <li>{t('help.sprayWalls.fix.trace')}</li>
          <li>{t('help.sprayWalls.fix.refine')}</li>
          <li>{t('help.sprayWalls.fix.join')}</li>
        </ProseList>
        <HelpScreenshot
          shot="spray-editor-select"
          alt={t('help.sprayWalls.fix.imageAlt')}
          caption={t('help.sprayWalls.fix.imageCaption')}
        />
        <ProseList>
          <li>{t('help.sprayWalls.fix.maybe')}</li>
          <li>{t('help.sprayWalls.fix.toggle')}</li>
          <li>{t('help.sprayWalls.fix.longPress')}</li>
          <li>{t('help.sprayWalls.fix.gestures')}</li>
        </ProseList>
      </PageSection>

      <PageSection title={t('help.sprayWalls.editor.title')}>
        <Prose>{t('help.sprayWalls.editor.p1')}</Prose>
        <HelpWalkthrough name="spray-holds-editor" alt={t('help.sprayWalls.editor.videoAlt')} />
        <ProseList ordered>
          <li>{t('help.sprayWalls.editor.step1')}</li>
          <li>{t('help.sprayWalls.editor.step2')}</li>
          <li>{t('help.sprayWalls.editor.step3')}</li>
          <li>{t('help.sprayWalls.editor.step4')}</li>
          <li>{t('help.sprayWalls.editor.step5')}</li>
        </ProseList>
        <HelpShots>
          <HelpScreenshot
            shot="spray-editor-draw"
            alt={t('help.sprayWalls.editor.drawAlt')}
            caption={t('help.sprayWalls.editor.drawCaption')}
          />
          <HelpScreenshot
            shot="spray-editor-corners"
            alt={t('help.sprayWalls.editor.cornersAlt')}
            caption={t('help.sprayWalls.editor.cornersCaption')}
          />
        </HelpShots>
        <Prose>{t('help.sprayWalls.editor.corners')}</Prose>
        <Prose>{t('help.sprayWalls.fix.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.later.title')}>
        <Prose>{t('help.sprayWalls.later.p1')}</Prose>
        <Prose>{t('help.sprayWalls.later.missed')}</Prose>
        <Prose>{t('help.sprayWalls.later.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.used.title')}>
        <Prose>{t('help.sprayWalls.used.removal')}</Prose>
        <Prose>{t('help.sprayWalls.used.confirm')}</Prose>
        <Prose>{t('help.sprayWalls.used.changes')}</Prose>
        <Prose>{t('help.sprayWalls.used.remix')}</Prose>
      </PageSection>

      <PageSection title={t('help.sprayWalls.pencil.title')}>
        <Prose>{t('help.sprayWalls.pencil.layout')}</Prose>
        <Prose>{t('help.sprayWalls.pencil.draw')}</Prose>
        <Prose>{t('help.sprayWalls.pencil.setting')}</Prose>
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
