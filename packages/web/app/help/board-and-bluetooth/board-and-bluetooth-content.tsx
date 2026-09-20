'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * 2,326 climbers hit a failed board connection in 90 days, which makes this the
 * busiest support topic we have. Two of its sections exist because Discord asked
 * the same thing twice: a board listed twice, and two boards in range. Where the
 * app has no control to offer (there is no "forget this device") the page says
 * so instead of inventing one. The last section names the Live Activity so
 * `/help/board-and-bluetooth#live-activity` is a link we can hand out.
 *
 * Every label, alert text and sheet order quoted here is checked against
 * settings.json / common.json and the BleControlSheet, DevicePickerSheet,
 * use-board-bluetooth and live-activity-bridge sources in packages/mobile.
 */
export default function BoardAndBluetoothContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.bluetooth.hero.title')}
      lead={t('help.bluetooth.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.bluetooth.breadcrumb')} />}
    >
      <PageSection id="connect" title={t('help.bluetooth.connect.title')}>
        <HelpShots>
          <HelpScreenshot
            shot="board-sheet"
            alt={t('help.bluetooth.connect.shotAlt')}
            caption={t('help.bluetooth.connect.shotCaption')}
          />
          <HelpScreenshot
            shot="board-view"
            alt={t('help.bluetooth.connect.litShotAlt')}
            caption={t('help.bluetooth.connect.litShotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.bluetooth.connect.p1')}</Prose>
        <Prose>{t('help.bluetooth.connect.p2')}</Prose>
        <Prose>{t('help.bluetooth.connect.p3')}</Prose>
      </PageSection>

      <PageSection id="failed" title={t('help.bluetooth.failed.title')} lead={t('help.bluetooth.failed.intro')}>
        <ProseList>
          <li>{t('help.bluetooth.failed.fix1')}</li>
          <li>{t('help.bluetooth.failed.fix2')}</li>
          <li>{t('help.bluetooth.failed.fix3')}</li>
          <li>{t('help.bluetooth.failed.fix4')}</li>
          <li>{t('help.bluetooth.failed.fix5')}</li>
        </ProseList>
        <Prose>{t('help.bluetooth.failed.p1')}</Prose>
      </PageSection>

      <PageSection id="hold-the-lightbulb" title={t('help.bluetooth.hidden.title')}>
        <Prose>{t('help.bluetooth.hidden.p1')}</Prose>
        <ProseList ordered>
          <li>{t('help.bluetooth.hidden.row1')}</li>
          <li>{t('help.bluetooth.hidden.row2')}</li>
          <li>{t('help.bluetooth.hidden.row3')}</li>
          <li>{t('help.bluetooth.hidden.row4')}</li>
          <li>{t('help.bluetooth.hidden.row5')}</li>
          <li>{t('help.bluetooth.hidden.row6')}</li>
          <li>{t('help.bluetooth.hidden.row7')}</li>
        </ProseList>
        <Prose>{t('help.bluetooth.hidden.p2')}</Prose>
      </PageSection>

      <PageSection id="two-boards" title={t('help.bluetooth.twoBoards.title')}>
        <Prose>{t('help.bluetooth.twoBoards.p1')}</Prose>
        <Prose>{t('help.bluetooth.twoBoards.p2')}</Prose>
      </PageSection>

      <PageSection id="listed-twice" title={t('help.bluetooth.duplicate.title')}>
        <Prose>{t('help.bluetooth.duplicate.p1')}</Prose>
        <Prose>{t('help.bluetooth.duplicate.p2')}</Prose>
        <Prose>{t('help.bluetooth.duplicate.p3')}</Prose>
      </PageSection>

      <PageSection id="someone-else" title={t('help.bluetooth.control.title')}>
        <Prose>{t('help.bluetooth.control.p1')}</Prose>
        <Prose>
          {t('help.bluetooth.control.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/sessions">
            {t('help.bluetooth.control.sessionsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection
        id="live-activity"
        title={t('help.bluetooth.liveActivity.title')}
        lead={t('help.bluetooth.liveActivity.intro')}
      >
        <Prose>{t('help.bluetooth.liveActivity.p1')}</Prose>
        <Prose>{t('help.bluetooth.liveActivity.p2')}</Prose>
        <Prose>{t('help.bluetooth.liveActivity.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.bluetooth.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/finding-climbs">
              {t('help.bluetooth.next.findingClimbs')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.bluetooth.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
