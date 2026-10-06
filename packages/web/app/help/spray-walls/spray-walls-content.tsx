'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpShots, HelpWalkthrough } from '../help-clip';

/**
 * The mobile wizard's photo step links here ("How to shoot it"), so the photo
 * advice comes first: the hold finder reads the picture as it is, and a skewed
 * shot costs the climber every hold it misses. The editor labels quoted below
 * (Bigger, Trace, Join, Draw, Corners, Publish holds) are the app's own words.
 */
export default function SprayWallsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.sprayWalls.hero.title')}
      lead={t('help.sprayWalls.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.sprayWalls.breadcrumb')} />}
    >
      <PageSection title={t('help.sprayWalls.watch.title')}>
        <HelpShots>
          <HelpWalkthrough
            name="spray-walls-walkthrough"
            alt={t('help.sprayWalls.watch.videoAlt')}
            caption={t('help.sprayWalls.watch.videoCaption')}
          />
        </HelpShots>
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
        </ProseList>
        <Prose>{t('help.sprayWalls.photo.why')}</Prose>
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
