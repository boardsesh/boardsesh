import React from 'react';
import type { Metadata } from 'next';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, PageShell, Prose, ProseList } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getGymMcpAvailability } from '@/app/lib/gym-mcp/availability.server';
import EndpointCopy from '@/app/developers/gym-mcp/endpoint-copy';

/** Setup utility: useful server-rendered copy, self canonical, excluded from the sitemap. */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('developers');
  return createNoIndexMetadata({
    title: t('gymMcp.title'),
    description: t('gymMcp.lead'),
    path: '/developers/gym-mcp',
    locale,
  });
}

export default async function GymMcpGuidePage() {
  const { t } = await getServerTranslation('developers');
  const availability = await getGymMcpAvailability();
  return (
    <PageShell title={t('gymMcp.title')} lead={t('gymMcp.lead')}>
      <PageSection>
        <Prose>{availability.invitationRequired ? t('gymMcp.pilotAvailability') : t('gymMcp.availability')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/gyms">
            {t('gymMcp.links.gyms')}
          </MuiLink>
          {' · '}
          <MuiLink component={LocaleLink} href="/settings">
            {t('gymMcp.links.connections')}
          </MuiLink>
          {' · '}
          <MuiLink component={LocaleLink} href="/support">
            {t('gymMcp.links.support')}
          </MuiLink>
        </Prose>
      </PageSection>
      <PageSection title={t('gymMcp.setup.title')}>
        <EndpointCopy
          label={t('gymMcp.setup.endpoint')}
          copy={t('gymMcp.setup.copy')}
          copied={t('gymMcp.setup.copied')}
          failed={t('gymMcp.setup.copyFailed')}
        />
        <ProseList ordered>
          <li>{t('gymMcp.setup.steps.add')}</li>
          <li>{t('gymMcp.setup.steps.paste')}</li>
          <li>{t('gymMcp.setup.steps.signIn')}</li>
          <li>{t('gymMcp.setup.steps.try')}</li>
        </ProseList>
        <Prose>{t('gymMcp.setup.requirements')}</Prose>
        <Prose>
          <MuiLink
            href="https://developers.openai.com/api/docs/guides/custom-mcp-server"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('gymMcp.setup.chatgptGuide')}
          </MuiLink>
          {' · '}
          <MuiLink
            href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('gymMcp.setup.claudeGuide')}
          </MuiLink>
        </Prose>
      </PageSection>
      <PageSection title={t('gymMcp.access.title')}>
        <Prose>{t('gymMcp.access.gyms')}</Prose>
        <Prose>{t('gymMcp.access.actions')}</Prose>
        <Prose>{t('gymMcp.access.approvals')}</Prose>
        <Prose>{t('gymMcp.access.privacy')}</Prose>
      </PageSection>
      <PageSection title={t('gymMcp.examples.title')}>
        <ProseList>
          <li>{t('gymMcp.examples.activity')}</li>
          <li>{t('gymMcp.examples.tv')}</li>
          <li>{t('gymMcp.examples.profile')}</li>
        </ProseList>
        <Prose>{t('gymMcp.examples.photos')}</Prose>
      </PageSection>
      <PageSection title={t('gymMcp.disconnect.title')}>
        <Prose>{t('gymMcp.disconnect.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/settings">
            {t('gymMcp.links.connections')}
          </MuiLink>
        </Prose>
      </PageSection>
    </PageShell>
  );
}
