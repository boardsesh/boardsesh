'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpCallout from '../help-callout';
import HelpSteps from '../help-steps';
import HelpInstallSection from '../help-install-section';
import { HelpClip, HelpShots } from '../help-clip';
import { HelpScreenshot } from '../help-screenshot';

/**
 * /help/logbook. Logging, editing, the Kilter / Tension import and beta videos.
 *
 * Beta-video labels are checked against packages/mobile: `share-beta.tsx`,
 * `AddBetaVideoSheet.tsx`, `DeferredSections.tsx` and `ProfileBetaShelf.tsx`.
 * Only Instagram and TikTok links are accepted, attaching has no confirm step,
 * and there is no mutation to remove an attached video, so the copy says so.
 * `#bring-your-logbook` is linked from the hub.
 */
export default function LogbookContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.log.hero.title')}
      lead={t('help.log.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.log.breadcrumb')} />}
    >
      <PageSection id="log" title={t('help.log.log.title')} lead={t('help.log.log.lead')}>
        <HelpShots>
          <HelpScreenshot shot="board-view" alt={t('help.log.log.shotAlt')} caption={t('help.log.log.shotCaption')} />
          <HelpScreenshot
            shot="logbook"
            alt={t('help.log.log.logbookShotAlt')}
            caption={t('help.log.log.logbookShotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.log.log.p1')}</Prose>
        <Prose>{t('help.log.log.p2')}</Prose>
      </PageSection>

      <PageSection id="edit" title={t('help.log.edit.title')} lead={t('help.log.edit.lead')}>
        <HelpShots>
          <HelpClip
            name="logbook-swipe-edit-delete"
            alt={t('help.log.edit.clipAlt')}
            caption={t('help.log.edit.clipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.log.edit.p1')}</Prose>
        <Prose>{t('help.log.edit.p2')}</Prose>
        <Prose>{t('help.log.edit.p3')}</Prose>
      </PageSection>

      <PageSection id="repeats" title={t('help.log.repeats.title')} lead={t('help.log.repeats.lead')}>
        <Prose>{t('help.log.repeats.p1')}</Prose>
        <Prose>{t('help.log.repeats.p2')}</Prose>
      </PageSection>

      <PageSection id="bring-your-logbook" title={t('help.log.bring.title')} lead={t('help.log.bring.lead')}>
        <HelpSteps steps={[t('help.log.bring.step1'), t('help.log.bring.step2'), t('help.log.bring.step3')]} />
        <Prose>{t('help.log.bring.p1')}</Prose>
        {/* Sync direction. The app's "pending sync" label gets read as a push
            back to Kilter; there is none (kilter-sync push-back is stubbed). */}
        <Prose>{t('help.log.bring.p2')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/aurora-migration">
            {t('help.log.bring.link')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection id="beta-videos" title={t('help.log.beta.title')} lead={t('help.log.beta.lead')}>
        {/* The share-sheet path leads because it is the feature nobody finds. */}
        <HelpSteps steps={[t('help.log.beta.step1'), t('help.log.beta.step2'), t('help.log.beta.step3')]} />
        <HelpCallout>{t('help.log.beta.callout')}</HelpCallout>
        <Prose>{t('help.log.beta.p1')}</Prose>
        <Prose>{t('help.log.beta.p2')}</Prose>
        <Prose>{t('help.log.beta.p3')}</Prose>
      </PageSection>

      <PageSection id="find-beta" title={t('help.log.findBeta.title')} lead={t('help.log.findBeta.lead')}>
        <Prose>
          {t('help.log.findBeta.p1')}{' '}
          <MuiLink component={LocaleLink} href="/help/finding-climbs#filters">
            {t('help.log.findBeta.filtersLink')}
          </MuiLink>
        </Prose>
        <Prose>{t('help.log.findBeta.p2')}</Prose>
      </PageSection>

      <HelpInstallSection />

      <PageSection title={t('help.log.next.title')}>
        <Prose>
          <MuiLink component={LocaleLink} href="/help/finding-climbs#climb-menu">
            {t('help.log.next.climbMenu')}
          </MuiLink>
        </Prose>
      </PageSection>
    </HelpPageShell>
  );
}
