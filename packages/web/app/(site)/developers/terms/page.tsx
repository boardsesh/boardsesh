import React from 'react';
import type { Metadata } from 'next';
import { PARTNER_DEVELOPER_TERMS_VERSION } from '@boardsesh/auth-protocol/partner-oauth';
import { PageSection, PageShell, Prose, ProseList } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { requireDeveloperConsoleAccess } from '@/app/developers/developer-console-access.server';

export const dynamic = 'force-dynamic';

const TERMS_PATH = '/developers/terms';

/** The bullets of each section, in order, as keys under `terms.<section>.items`. */
const SECTIONS = [
  { section: 'data', items: ['purpose', 'noSale', 'setterClimbs', 'delete', 'privacyPolicy', 'security'] },
  { section: 'api', items: ['limits', 'scopes', 'catalog', 'service'] },
  { section: 'names', items: ['worksWith', 'ownName', 'boardBrands'] },
  { section: 'ours', items: ['suspend', 'changes', 'asIs'] },
] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('developers');
  return createNoIndexMetadata({
    title: t('terms.metadata.title'),
    description: t('terms.metadata.description'),
    path: TERMS_PATH,
    locale,
  });
}

/**
 * The developer terms an app accepts at registration
 * (`PARTNER_DEVELOPER_TERMS_VERSION`, docs/integrations/integration-platform.md "Data
 * boundaries and LEGAL.md"). Behind the same flag as the console, and English
 * in every locale: the other catalogs carry the English text on purpose.
 */
export default async function DeveloperTermsPage() {
  const { t, locale } = await getServerTranslation('developers');
  await requireDeveloperConsoleAccess(TERMS_PATH, locale);

  return (
    <PageShell
      eyebrow={t('page.eyebrow')}
      title={t('terms.title')}
      lead={t('terms.version', { version: PARTNER_DEVELOPER_TERMS_VERSION })}
    >
      <PageSection>
        <Prose>{t('terms.intro')}</Prose>
      </PageSection>
      {SECTIONS.map(({ section, items }) => (
        <PageSection key={section} title={t(`terms.${section}.title`)}>
          <ProseList>
            {items.map((item) => (
              <li key={item}>{t(`terms.${section}.items.${item}`)}</li>
            ))}
          </ProseList>
        </PageSection>
      ))}
      <PageSection title={t('terms.ending.title')}>
        <Prose>{t('terms.ending.body')}</Prose>
        <Prose>{t('terms.contact')}</Prose>
      </PageSection>
    </PageShell>
  );
}
