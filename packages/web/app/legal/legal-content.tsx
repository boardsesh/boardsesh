'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GavelOutlined } from '@mui/icons-material';
import { Trans, useTranslation } from 'react-i18next';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';

export default function LegalContent() {
  const { t } = useTranslation('marketing');
  return (
    <PageShell title={t('legal.intro.title')}>
      <PageSection>
        <Prose>{t('legal.intro.p1')}</Prose>
        <Prose>{t('legal.intro.p2')}</Prose>
      </PageSection>

      <PageSection title={t('legal.climbData.title')} icon={<GavelOutlined />}>
        <PageSection headingLevel={3} title={t('legal.climbData.facts.title')}>
          <Prose>{t('legal.climbData.facts.p1')}</Prose>
          <Prose>
            <Trans i18nKey="legal.climbData.facts.p2" t={t} components={{ em: <em /> }} />
          </Prose>
        </PageSection>

        <PageSection headingLevel={3} title={t('legal.climbData.community.title')}>
          <Prose>{t('legal.climbData.community.p1')}</Prose>
          <Prose>{t('legal.climbData.community.p2')}</Prose>
          <Prose>
            <Trans i18nKey="legal.climbData.community.aurora" t={t} components={{ strong: <strong /> }} />
          </Prose>
          <Prose>
            <strong>{t('legal.climbData.community.moonLabel')}</strong> {t('legal.climbData.community.moonBody')}
          </Prose>
        </PageSection>

        <PageSection headingLevel={3} title={t('legal.climbData.compilation.title')}>
          <Prose>
            <Trans i18nKey="legal.climbData.compilation.body" t={t} components={{ em: <em /> }} />
          </Prose>
        </PageSection>
      </PageSection>

      <PageSection title={t('legal.attribution.title')}>
        <Prose>{t('legal.attribution.intro')}</Prose>
        <ProseList>
          <li>{t('legal.attribution.item1')}</li>
          <li>{t('legal.attribution.item2')}</li>
          <li>
            {t('legal.attribution.item3Start')}{' '}
            <MuiLink href="https://github.com/marcodejongh/boardsesh/issues" target="_blank" rel="noopener noreferrer">
              {t('legal.attribution.item3Link')}
            </MuiLink>{' '}
            {t('legal.attribution.item3End')}
          </li>
        </ProseList>
      </PageSection>

      <PageSection title={t('legal.interop.title')}>
        <Prose>{t('legal.interop.intro')}</Prose>

        <PageSection headingLevel={3} title={t('legal.interop.software.title')}>
          <Prose>
            <Trans i18nKey="legal.interop.software.body" t={t} components={{ em: <em /> }} />
          </Prose>
        </PageSection>

        <PageSection headingLevel={3} title={t('legal.interop.controller.title')}>
          <Prose>{t('legal.interop.controller.p1')}</Prose>
          <Prose>{t('legal.interop.controller.p2')}</Prose>
        </PageSection>
      </PageSection>

      <PageSection title={t('legal.trademark.title')}>
        <Prose>{t('legal.trademark.body')}</Prose>
      </PageSection>

      <PageSection title={t('legal.dmca.title')}>
        <Prose>{t('legal.dmca.intro')}</Prose>
        <ProseList ordered>
          <li>{t('legal.dmca.item1')}</li>
          <li>{t('legal.dmca.item2')}</li>
          <li>{t('legal.dmca.item3')}</li>
          <li>{t('legal.dmca.item4')}</li>
          <li>{t('legal.dmca.item5')}</li>
        </ProseList>
        <Prose>{t('legal.dmca.review1')}</Prose>
        <Prose>
          <strong>{t('legal.dmca.contactLabel')}</strong> {/* i18n-ignore-next-line -- contact email, not translated */}
          <MuiLink href="mailto:legal@boardsesh.com">legal@boardsesh.com</MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('legal.community.title')}>
        <Prose>{t('legal.community.p1')}</Prose>
        <Prose>{t('legal.community.p2')}</Prose>
        <Prose>{t('legal.community.p3')}</Prose>
      </PageSection>

      <PageSection title={t('legal.thirdParty.title')}>
        <ProseList>
          <li>
            <strong>{t('legal.thirdParty.iconLabel')}</strong> {t('legal.thirdParty.iconFrom')}{' '}
            <MuiLink href="https://fontawesome.com" target="_blank" rel="noopener noreferrer">
              {t('legal.thirdParty.fontAwesomeLink')}
            </MuiLink>{' '}
            {t('legal.thirdParty.byAuthor')} {t('legal.thirdParty.licenseLabel')}{' '}
            <MuiLink href="https://fontawesome.com/license/free" target="_blank" rel="noopener noreferrer">
              {t('legal.thirdParty.licenseLink')}
            </MuiLink>
            {t('legal.thirdParty.copyright')}
          </li>
        </ProseList>
      </PageSection>

      <PageSection>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('legal.footer')}
        </Typography>
      </PageSection>
    </PageShell>
  );
}
