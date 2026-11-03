'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpSteps from '../help-steps';
import HelpPageShell from '../help-page-shell';
import HelpBand from '../help-band';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpWalkthrough } from '../help-clip';
import { HelpScreenshot } from '../help-screenshot';
import styles from './spray-walls-content.module.css';

/** The mobile wizard links here for photo advice and current editor gestures. */
export default function SprayWallsContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.spray.hero.title')}
      lead={t('help.spray.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.spray.breadcrumb')} />}
      jumpLabel={t('help.nav.jump')}
      jumpLinks={[
        { id: 'walkthrough', label: t('help.spray.watch.title') },
        { id: 'photo', label: t('help.spray.photo.title') },
        { id: 'add', label: t('help.spray.add.title') },
        { id: 'fix-holds', label: t('help.spray.fix.title') },
        { id: 'edit-later', label: t('help.spray.edit.title') },
      ]}
    >
      <HelpBand id="walkthrough" wide title={t('help.spray.watch.title')} lead={t('help.spray.watch.lead')}>
        <HelpWalkthrough name="spray-walls-walkthrough" alt={t('help.spray.watch.videoAlt')} />
      </HelpBand>

      <HelpBand
        id="photo"
        flip
        title={t('help.spray.photo.title')}
        lead={t('help.spray.photo.lead')}
        media={
          <Box component="figure" className={styles.photoFigure}>
            <Image
              src={resolveStaticAssetUrl('/images/help/spray-wall-photo.webp')}
              alt={t('help.spray.photo.exampleAlt')}
              width={1752}
              height={2047}
              sizes="(max-width: 900px) 260px, 340px"
              className={styles.photo}
            />
            <Typography component="figcaption" variant="body2" className={styles.photoCaption}>
              {t('help.spray.photo.exampleCaption')}
            </Typography>
          </Box>
        }
      >
        <ProseList>
          <li>{t('help.spray.photo.square')}</li>
          <li>{t('help.spray.photo.portrait')}</li>
          <li>{t('help.spray.photo.tilt')}</li>
          <li>{t('help.spray.photo.frame')}</li>
          <li>{t('help.spray.photo.lighting')}</li>
        </ProseList>
      </HelpBand>

      <HelpBand id="add" title={t('help.spray.add.title')} lead={t('help.spray.add.lead')}>
        <HelpSteps
          steps={[
            t('help.spray.add.step1'),
            t('help.spray.add.step2'),
            t('help.spray.add.step3'),
            t('help.spray.add.step4'),
            t('help.spray.add.step5'),
          ]}
        />
        <Prose>{t('help.spray.add.p1')}</Prose>
      </HelpBand>

      <HelpBand
        id="fix-holds"
        title={t('help.spray.fix.title')}
        lead={t('help.spray.fix.lead')}
        media={
          <HelpScreenshot
            shot="spray-editor-select"
            alt={t('help.spray.fix.imageAlt')}
            caption={t('help.spray.fix.imageCaption')}
          />
        }
      >
        <ProseList>
          <li>{t('help.spray.fix.select')}</li>
          <li>{t('help.spray.fix.add')}</li>
          <li>{t('help.spray.fix.trace')}</li>
          <li>{t('help.spray.fix.refine')}</li>
          <li>{t('help.spray.fix.join')}</li>
        </ProseList>
        <ProseList>
          <li>{t('help.spray.fix.maybe')}</li>
          <li>{t('help.spray.fix.toggle')}</li>
          <li>{t('help.spray.fix.longPress')}</li>
          <li>{t('help.spray.fix.gestures')}</li>
        </ProseList>
      </HelpBand>

      <HelpBand continues wide headingLevel={3} title={t('help.spray.fix.missedTitle')}>
        <HelpWalkthrough name="spray-holds-editor" alt={t('help.spray.fix.videoAlt')} />
      </HelpBand>

      <HelpBand
        continues
        flip
        media={
          <HelpScreenshot
            shot="spray-editor-draw"
            alt={t('help.spray.fix.drawAlt')}
            caption={t('help.spray.fix.drawCaption')}
          />
        }
      >
        <HelpSteps steps={[t('help.spray.fix.missed1'), t('help.spray.fix.missed2'), t('help.spray.fix.missed3')]} />
      </HelpBand>

      <HelpBand
        continues
        secondaryMedia
        media={
          <HelpScreenshot
            shot="spray-editor-corners"
            alt={t('help.spray.fix.cornersAlt')}
            caption={t('help.spray.fix.cornersCaption')}
          />
        }
      >
        <Prose>{t('help.spray.fix.corners')}</Prose>
      </HelpBand>

      <HelpBand id="edit-later" title={t('help.spray.edit.title')} lead={t('help.spray.edit.lead')}>
        <Prose>{t('help.spray.edit.p1')}</Prose>
        <Prose>{t('help.spray.edit.p2')}</Prose>
        <Prose>{t('help.spray.edit.p3')}</Prose>
        <Prose>{t('help.spray.edit.p4')}</Prose>
        <Prose>{t('help.spray.edit.p5')}</Prose>
      </HelpBand>

      <HelpBand id="apple-pencil" title={t('help.spray.pencil.title')} lead={t('help.spray.pencil.lead')}>
        <Prose>{t('help.spray.pencil.p1')}</Prose>
        <Prose>{t('help.spray.pencil.p2')}</Prose>
      </HelpBand>

      <HelpBand title={t('help.spray.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/logbook">
              {t('help.spray.next.logbook')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/sessions">
              {t('help.spray.next.sessions')}
            </MuiLink>
          </li>
        </ProseList>
      </HelpBand>
    </HelpPageShell>
  );
}
