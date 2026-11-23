import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { quietLinkSx } from '@/app/components/ui/quiet-link';
import { PageSection, PageShell, Prose, ProseList } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { NOINDEX_FOLLOW_ROBOTS, createNoIndexMetadata, createPageMetadata } from '@/app/lib/seo/metadata';
import { PUBLIC_API_CHANGELOG, generatePublicApiDocument } from '@boardsesh/public-api';
import DocsCodeBlock from './docs-code-block';
import { EXAMPLE_URL, GUIDE_SECTIONS, GUIDE_SLUGS, guideCode, type GuideSlug } from './guide-documents';
import { OPENAPI_URL } from './developers-docs-samples';
import PartnerApiReference from './partner-api-reference';

export async function guideMetadata(slug: GuideSlug): Promise<Metadata> {
  const state = getDeveloperDocsState();
  if (state === 'unavailable') return { robots: NOINDEX_FOLLOW_ROBOTS };
  const { t, locale } = await getServerTranslation('developers');
  const options = {
    title: t(`guides.${slug}.title`),
    description: t(`guides.${slug}.description`),
    path: `/developers/${slug}`,
    locale,
  };
  return state === 'open' ? createPageMetadata(options) : createNoIndexMetadata(options);
}

/** Useful prose and navigation are server rendered, including on the reference page. */
export async function DeveloperGuidePage({ slug }: { slug: GuideSlug }) {
  const state = getDeveloperDocsState();
  if (state === 'unavailable') notFound();
  const { t } = await getServerTranslation('developers');
  return (
    <PageShell
      title={t(`guides.${slug}.title`)}
      lead={t(`guides.${slug}.description`)}
      breadcrumb={
        <MuiLink component={LocaleLink} href="/developers" sx={quietLinkSx}>
          {t('guides.labels.home')}
        </MuiLink>
      }
    >
      <PageSection>
        {state === 'invitation' ? <Prose>{t('guides.labels.invitation')}</Prose> : null}
        <Prose>
          <MuiLink href={`/developers/${slug}.md`}>{t('guides.labels.markdown')}</MuiLink>
        </Prose>
        <ProseList>
          {GUIDE_SLUGS.filter((other) => other !== slug).map((other) => (
            <li key={other}>
              <MuiLink component={LocaleLink} href={`/developers/${other}`}>
                {t(`guides.${other}.title`)}
              </MuiLink>
            </li>
          ))}
        </ProseList>
      </PageSection>
      {GUIDE_SECTIONS[slug].map((section) => {
        const code = guideCode(slug, section);
        return (
          <PageSection key={section} title={t(`guides.${slug}.${section}.title`)}>
            {t(`guides.${slug}.${section}.body`)
              .split('\n\n')
              .map((paragraph) => (
                <Prose key={paragraph}>{paragraph}</Prose>
              ))}
            {code ? <DocsCodeBlock label={t(`guides.${slug}.${section}.title`)}>{code}</DocsCodeBlock> : null}
          </PageSection>
        );
      })}
      {slug === 'changelog'
        ? PUBLIC_API_CHANGELOG.map((entry) => (
            <PageSection key={`${entry.date}-${entry.documentSha256}`} title={entry.date}>
              <ProseList>
                {entry.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ProseList>
            </PageSection>
          ))
        : null}
      {slug === 'reference' ? (
        <PartnerApiReference spec={generatePublicApiDocument()} loadingLabel={t('guides.labels.loading')} />
      ) : null}
      <PageSection title={t('guides.labels.related')}>
        <Prose>
          <MuiLink href={OPENAPI_URL}>{t('guides.labels.openapi')}</MuiLink>
        </Prose>
        <Prose>
          <MuiLink href={EXAMPLE_URL}>{t('guides.labels.example')}</MuiLink>
        </Prose>
      </PageSection>
    </PageShell>
  );
}
