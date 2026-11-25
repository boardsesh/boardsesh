import React from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS } from '@boardsesh/auth-protocol/auth-time';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, PageShell, Prose, ProseList } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { NOINDEX_FOLLOW_ROBOTS, createNoIndexMetadata, createPageMetadata } from '@/app/lib/seo/metadata';
import DocsCodeBlock from '@/app/developers/docs-code-block';
import { GUIDE_SLUGS } from '@/app/developers/guide-documents';
import {
  API_PER_APP,
  API_PER_CLIMBER,
  APPS_PER_DEVELOPER,
  AUTHORIZE_SAMPLE,
  CODE_SECONDS,
  EARLY_ACCESS_LIVE_CLIMBERS,
  EARLY_ACCESS_NEW_PER_DAY,
  ERRORS,
  OPENAPI_URL,
  REDIRECT_URIS_PER_APP,
  REFRESH_PER_CLIMBER,
  REFRESH_TOKEN_DAYS,
  SCOPES,
  SUPPORT_EMAIL,
  SYNC_SAMPLE,
  TOKEN_EXCHANGE_PER_APP_AND_IP,
  TOKEN_RESPONSE_SAMPLE,
  TOKEN_SAMPLE,
} from '@/app/developers/developers-docs-samples';

// The page's state comes from PARTNER_OAUTH_MODE at request time, so it must
// not be prerendered with the mode the build happened to see.
export const dynamic = 'force-dynamic';

const DEVELOPERS_PATH = '/developers';

const CAN_ITEMS = ['read', 'sync', 'profile', 'disconnect', 'notYet'] as const;
const STEP_ITEMS = ['register', 'approve', 'exchange', 'snapshot', 'feed'] as const;
const RULE_ITEMS = [
  'consent',
  'redirect',
  'redirectChange',
  'recentSignIn',
  'notice',
  'pkce',
  'code',
  'tokens',
  'signin',
  'disconnect',
] as const;
const LIMIT_ITEMS = ['api', 'token', 'fullSync', 'page', 'history', 'body', 'caps', 'headers'] as const;
const RELATED = [
  { key: 'docs', href: '/docs' },
  { key: 'privacy', href: '/privacy' },
  { key: 'legal', href: '/legal' },
  { key: 'support', href: '/support' },
] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('developers');
  const state = getDeveloperDocsState();
  // A page that 404s must not hand a crawler a title and description for it.
  if (state === 'unavailable') return { robots: NOINDEX_FOLLOW_ROBOTS };
  const options = {
    title: t('docs.metadata.title'),
    description: t('docs.metadata.description'),
    path: DEVELOPERS_PATH,
    locale,
  };
  // Indexable only once outsiders can act on it; until then it is a utility page.
  return state === 'open' ? createPageMetadata(options) : createNoIndexMetadata(options);
}

/**
 * The public docs for apps that read a climber's logbook (docs/integrations/partner-api.md
 * is the source). Gated by this service's PARTNER_OAUTH_MODE, never by a flag
 * of its own: `off` and `hold` are a 404 (the same as the console at
 * `/developers/apps`), `allowlist` says registration is by invitation and stays
 * noindex, and only `open` is indexable and in the sitemap.
 *
 * Covers only what the API serves today: logbook reading. Workouts and
 * webhooks are described in the contract but not live, so the page does not
 * document them.
 */
export default async function DevelopersPage() {
  const state = getDeveloperDocsState();
  if (state === 'unavailable') notFound();
  const { t, locale } = await getServerTranslation('developers');
  const number = new Intl.NumberFormat(locale);
  // The figures the rules and limits state, interpolated so one constant feeds
  // the page, every locale and the drift test against the backend.
  const figures = {
    live: EARLY_ACCESS_LIVE_CLIMBERS,
    perDay: EARLY_ACCESS_NEW_PER_DAY,
    apps: APPS_PER_DEVELOPER,
    max: REDIRECT_URIS_PER_APP,
    seconds: CODE_SECONDS,
    days: REFRESH_TOKEN_DAYS,
    climber: API_PER_CLIMBER,
    app: number.format(API_PER_APP),
    refresh: REFRESH_PER_CLIMBER,
    exchange: TOKEN_EXCHANGE_PER_APP_AND_IP,
    minutes: PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS / 60,
  };

  return (
    <PageShell eyebrow={t('page.eyebrow')} title={t('docs.title')} lead={t('docs.lead')}>
      <PageSection title={t(state === 'open' ? 'docs.access.open.title' : 'docs.access.invitation.title')}>
        {state === 'open' ? (
          <>
            <Prose>{t('docs.access.open.body')}</Prose>
            <Prose>
              <MuiLink component={LocaleLink} href="/developers/apps">
                {t('docs.access.open.action')}
              </MuiLink>
            </Prose>
          </>
        ) : (
          <Prose>
            {t('docs.access.invitation.body', { live: EARLY_ACCESS_LIVE_CLIMBERS, perDay: EARLY_ACCESS_NEW_PER_DAY })}{' '}
            <MuiLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</MuiLink>
          </Prose>
        )}
      </PageSection>

      <PageSection title={t('docs.can.title')}>
        <ProseList>
          {CAN_ITEMS.map((item) => (
            <li key={item}>{t(`docs.can.items.${item}`)}</li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.steps.title')}>
        <ProseList ordered>
          {STEP_ITEMS.map((item) => (
            <li key={item}>{t(`docs.steps.items.${item}`)}</li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.scopes.title')} lead={t('docs.scopes.lead')}>
        <ProseList>
          {SCOPES.map(({ scope, key }) => (
            <li key={scope}>
              <code>{scope}</code>
              {': '}
              {t(`docs.scopes.items.${key}`)}
            </li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.rules.title')}>
        <ProseList>
          {RULE_ITEMS.map((item) => (
            <li key={item}>{t(`docs.rules.items.${item}`, figures)}</li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.requests.title')} lead={t('docs.requests.lead')}>
        <Prose>{t('docs.requests.authorize')}</Prose>
        <DocsCodeBlock label={t('docs.requests.authorizeLabel')}>{AUTHORIZE_SAMPLE}</DocsCodeBlock>
        <Prose>{t('docs.requests.exchange')}</Prose>
        <DocsCodeBlock label={t('docs.requests.exchangeLabel')}>{TOKEN_SAMPLE}</DocsCodeBlock>
        <DocsCodeBlock label={t('docs.requests.exchangeResponseLabel')}>{TOKEN_RESPONSE_SAMPLE}</DocsCodeBlock>
        <Prose>{t('docs.requests.confidential')}</Prose>
        <Prose>{t('docs.requests.sync')}</Prose>
        <DocsCodeBlock label={t('docs.requests.syncLabel')}>{SYNC_SAMPLE}</DocsCodeBlock>
      </PageSection>

      <PageSection title={t('docs.limits.title')}>
        <ProseList>
          {LIMIT_ITEMS.map((item) => (
            <li key={item}>{t(`docs.limits.items.${item}`, figures)}</li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.errors.title')} lead={t('docs.errors.lead')}>
        <ProseList>
          {ERRORS.map(({ status, code, key }) => (
            <li key={key}>
              <code>{code ? `${status} ${code}` : status}</code>
              {': '}
              {t(`docs.errors.items.${key}`)}
            </li>
          ))}
        </ProseList>
      </PageSection>

      <PageSection title={t('docs.versioning.title')}>
        <Prose>{t('docs.versioning.body')}</Prose>
        <Prose>
          {t('docs.versioning.openapi')}{' '}
          <MuiLink href={OPENAPI_URL} rel="noopener">
            {OPENAPI_URL}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('docs.related.title')}>
        <ProseList>
          {GUIDE_SLUGS.map((slug) => (
            <li key={slug}>
              <MuiLink component={LocaleLink} href={`/developers/${slug}`}>
                {t(`guides.${slug}.title`)}
              </MuiLink>
            </li>
          ))}
          {RELATED.map(({ key, href }) => (
            <li key={key}>
              <MuiLink component={LocaleLink} href={href}>
                {t(`docs.related.items.${key}`)}
              </MuiLink>
            </li>
          ))}
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
