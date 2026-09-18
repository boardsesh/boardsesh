'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { GitHub, GroupOutlined, FavoriteBorderOutlined, ApiOutlined, RocketLaunchOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';

export default function AboutContent() {
  const { t } = useTranslation('marketing');
  return (
    <PageShell title={t('about.hero.title')} lead={t('about.hero.subtitle')}>
      <PageSection title={t('about.vision.title')} icon={<RocketLaunchOutlined />}>
        <Prose>{t('about.vision.p1')}</Prose>
        <Prose>{t('about.vision.p2')}</Prose>
      </PageSection>

      <PageSection title={t('about.features.title')} icon={<GroupOutlined />} tone="neutral">
        <ProseList>
          <li>
            <Typography variant="body1" component="span" fontWeight={600}>
              {t('about.features.queueLabel')}
            </Typography>{' '}
            {t('about.features.queueDescription')}
          </li>
          <li>
            <Typography variant="body1" component="span" fontWeight={600}>
              {t('about.features.partyLabel')}
            </Typography>{' '}
            {t('about.features.partyDescription')}
          </li>
          <li>
            <Typography variant="body1" component="span" fontWeight={600}>
              {t('about.features.multiBoardLabel')}
            </Typography>{' '}
            {t('about.features.multiBoardDescription')}
          </li>
          <li>
            <Typography variant="body1" component="span" fontWeight={600}>
              {t('about.features.communityLabel')}
            </Typography>{' '}
            {t('about.features.communityDescription')}
          </li>
          <li>
            <Typography variant="body1" component="span" fontWeight={600}>
              {t('about.features.selfHostedLabel')}
            </Typography>{' '}
            {t('about.features.selfHostedDescription')}
          </li>
        </ProseList>
      </PageSection>

      <PageSection title={t('about.openSource.title')} icon={<GitHub />} tone="neutral">
        <Prose>{t('about.openSource.body')}</Prose>
        <Prose>
          <MuiLink href="https://github.com/marcodejongh/boardsesh" target="_blank" rel="noopener noreferrer">
            {t('about.openSource.cta')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('about.api.title')} icon={<ApiOutlined />}>
        <Prose>{t('about.api.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/docs">
            {t('about.api.cta')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('about.community.title')} icon={<FavoriteBorderOutlined />}>
        <Prose>{t('about.community.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/legal">
            {t('about.legalLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('about.footer')}
        </Typography>
      </PageSection>
    </PageShell>
  );
}
