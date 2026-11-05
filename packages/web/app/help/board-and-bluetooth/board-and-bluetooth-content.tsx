'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpCallout from '../help-callout';
import HelpInstallSection from '../help-install-section';
import HelpSteps from '../help-steps';
import { HelpScreenshot } from '../help-screenshot';
import { HelpClip, HelpShots } from '../help-clip';

/**
 * 2,326 climbers hit a failed board connection in 90 days, which makes this the
 * busiest support topic we have. Two of its sections exist because Discord asked
 * the same thing twice: a board listed twice, and two boards in range. They now
 * live under `#failed`, with `#two-boards` and `#listed-twice` kept as alias
 * ids so old links still land. Where the app has no control to offer (there is
 * no "forget this device") the page says so instead of inventing one.
 *
 * Every label, alert text and sheet order quoted here is checked against
 * settings.json / common.json / session.json and the BleControlSheet,
 * DevicePickerSheet, use-board-bluetooth and live-activity-bridge sources in
 * packages/mobile. `#driving` is where the What's New spotlight and the mobile
 * help links send climbers (packages/mobile/src/lib/help-url.ts pins the id),
 * so never rename it.
 */
export default function BoardAndBluetoothContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.board.hero.title')}
      lead={t('help.board.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.board.breadcrumb')} />}
    >
      <PageSection id="connect" title={t('help.board.connect.title')} lead={t('help.board.connect.lead')}>
        <HelpShots>
          <HelpClip
            name="put-on-board-timed-drive"
            alt={t('help.board.connect.clipAlt')}
            caption={t('help.board.connect.clipCaption')}
          />
        </HelpShots>
        <HelpSteps
          steps={[t('help.board.connect.step1'), t('help.board.connect.step2'), t('help.board.connect.step3')]}
        />
        <Prose>{t('help.board.connect.otherBoard')}</Prose>
        <Prose>{t('help.board.connect.changeBoard')}</Prose>
      </PageSection>

      <PageSection id="driving" title={t('help.board.driving.title')} lead={t('help.board.driving.lead')}>
        <Prose>{t('help.board.driving.looking')}</Prose>
        <Prose>{t('help.board.driving.waysIntro')}</Prose>
        <ProseList ordered>
          <li>{t('help.board.driving.way1')}</li>
          <li>{t('help.board.driving.way2')}</li>
          <li>{t('help.board.driving.way3')}</li>
        </ProseList>
        <HelpShots>
          <HelpClip
            name="wall-swipe-to-drive"
            alt={t('help.board.driving.clipAlt')}
            caption={t('help.board.driving.clipCaption')}
          />
        </HelpShots>
        <HelpCallout>{t('help.board.driving.tell')}</HelpCallout>
        <HelpShots>
          <HelpScreenshot
            shot="preview"
            alt={t('help.board.driving.states.lookingAlt')}
            caption={t('help.board.driving.states.lookingCaption')}
          />
          <HelpScreenshot
            shot="drive-timed"
            alt={t('help.board.driving.states.timedAlt')}
            caption={t('help.board.driving.states.timedCaption')}
          />
          <HelpScreenshot
            shot="drive-open"
            alt={t('help.board.driving.states.openAlt')}
            caption={t('help.board.driving.states.openCaption')}
          />
        </HelpShots>
        <Prose>{t('help.board.driving.tellClock')}</Prose>
        <Prose>{t('help.board.driving.endsIntro')}</Prose>
        <ProseList>
          <li>{t('help.board.driving.end1')}</li>
          <li>{t('help.board.driving.end2')}</li>
          <li>{t('help.board.driving.end3')}</li>
          <li>{t('help.board.driving.end4')}</li>
        </ProseList>
        <Prose>{t('help.board.driving.after')}</Prose>
      </PageSection>

      <PageSection id="board-history" title={t('help.board.history.title')} lead={t('help.board.history.lead')}>
        <Prose>{t('help.board.history.p1')}</Prose>
        <Prose>{t('help.board.history.p2')}</Prose>
      </PageSection>

      <PageSection id="hold-the-lightbulb" title={t('help.board.controls.title')} lead={t('help.board.controls.lead')}>
        <HelpShots>
          <HelpScreenshot
            shot="board-sheet"
            alt={t('help.board.controls.shotAlt')}
            caption={t('help.board.controls.shotCaption')}
          />
          <HelpScreenshot
            shot="board-lighting"
            alt={t('help.board.controls.lightingShotAlt')}
            caption={t('help.board.controls.lightingShotCaption')}
          />
        </HelpShots>
        <ProseList>
          <li>{t('help.board.controls.row1')}</li>
          <li>{t('help.board.controls.row2')}</li>
          <li>{t('help.board.controls.row3')}</li>
          <li>{t('help.board.controls.row4')}</li>
          <li>{t('help.board.controls.row5')}</li>
        </ProseList>
        <Prose>{t('help.board.controls.settingsIntro')}</Prose>
        <ProseList>
          <li>{t('help.board.controls.setting1')}</li>
          <li>{t('help.board.controls.setting2')}</li>
          <li>{t('help.board.controls.setting3')}</li>
          <li>{t('help.board.controls.setting4')}</li>
        </ProseList>
        <Prose>{t('help.board.controls.bulb')}</Prose>
      </PageSection>

      <PageSection id="someone-else" title={t('help.board.control.title')} lead={t('help.board.control.lead')}>
        <Prose>{t('help.board.control.p1')}</Prose>
        <Prose>
          {t('help.board.control.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/sessions">
            {t('help.board.control.sessionsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection
        id="live-activity"
        title={t('help.board.liveActivity.title')}
        lead={t('help.board.liveActivity.lead')}
      >
        <Prose>{t('help.board.liveActivity.p1')}</Prose>
        <Prose>{t('help.board.liveActivity.p2')}</Prose>
        <Prose>{t('help.board.liveActivity.p3')}</Prose>
      </PageSection>

      <Box component="span" id="two-boards" />
      <Box component="span" id="listed-twice" />
      <PageSection id="failed" title={t('help.board.failed.title')} lead={t('help.board.failed.lead')}>
        <ProseList>
          <li>{t('help.board.failed.fix1')}</li>
          <li>{t('help.board.failed.fix2')}</li>
          <li>{t('help.board.failed.fix3')}</li>
          <li>{t('help.board.failed.fix4')}</li>
          <li>{t('help.board.failed.fix5')}</li>
        </ProseList>
        <Prose>{t('help.board.failed.twoBoards')}</Prose>
        <Prose>{t('help.board.failed.duplicate')}</Prose>
        <Prose>{t('help.board.failed.duplicateYourBoards')}</Prose>
      </PageSection>

      <HelpInstallSection />

      <PageSection title={t('help.board.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/finding-climbs">
              {t('help.board.next.findingClimbs')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.board.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </HelpPageShell>
  );
}
