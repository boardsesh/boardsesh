import React from 'react';
import { notFound } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import { PageShell, StatePanel } from '@/app/components/ui/page-shell';
import LocaleLink from '@/app/components/i18n/locale-link';
import I18nProvider from '@/app/components/providers/i18n-provider';
import DirectoryPagination from '@/app/components/directory/directory-pagination';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { createPageMetadata, absoluteUrl } from '@/app/lib/seo/metadata';
import JsonLd from '@/app/lib/seo/json-ld';
import type { DirectorySearchParams } from '@/app/gyms/directory-facets';
import { fetchSprayDirectory } from '@/app/spraywalls/find/directory-data';
import {
  buildSprayDirectoryHref,
  parseSprayDirectoryQuery,
  SPRAY_DIRECTORY_PATH,
  SPRAY_DIRECTORY_PAGE_SIZE,
  SPRAY_DIRECTORY_MAX_PAGE,
} from '@/app/spraywalls/find/directory-model';
import SprayDirectoryExplorer from '@/app/spraywalls/find/spray-directory-explorer';
import SprayDirectoryRows from '@/app/spraywalls/find/spray-directory-rows';
import SprayDirectoryAngleFilters from '@/app/spraywalls/find/spray-directory-angle-filters';

export const dynamic = 'force-dynamic';

type RouteProps = { searchParams: Promise<DirectorySearchParams> };

export async function generateMetadata({ searchParams }: RouteProps) {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({
    title: t('sprayDirectory.title'),
    description: t('sprayDirectory.description'),
    path: SPRAY_DIRECTORY_PATH,
    locale,
    robots: { index: Object.keys(await searchParams).length === 0, follow: true },
  });
}

export default async function SprayWallDirectoryPage({ searchParams }: RouteProps) {
  const query = parseSprayDirectoryQuery(await searchParams);
  if (query.page > SPRAY_DIRECTORY_MAX_PAGE) notFound();
  const [{ t, locale }, { t: gyms }, result] = await Promise.all([
    getServerTranslation('website'),
    getServerTranslation('gyms'),
    fetchSprayDirectory(query),
  ]);
  if (result.ok && query.page > 1 && (query.page - 1) * SPRAY_DIRECTORY_PAGE_SIZE >= result.connection.totalCount)
    notFound();
  const breadcrumbs = [
    { name: gyms('breadcrumb.home'), path: '/' },
    { name: t('sprayLabel'), path: '/spraywalls' },
    { name: t('sprayDirectory.title'), path: SPRAY_DIRECTORY_PATH },
  ];
  return (
    <I18nProvider
      locale={locale}
      namespaces={['website', 'gyms']}
      resourceKeys={{
        website: ['sprayDirectory'],
        gyms: ['places', 'search', 'nearMe', 'map', 'filters.angleHeading'],
      }}
    >
      <PageShell
        width="wide"
        title={t('sprayDirectory.title')}
        lead={t('sprayDirectory.lead')}
        breadcrumb={
          <Box component="nav" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {breadcrumbs.map((crumb, index) =>
              index < breadcrumbs.length - 1 ? (
                <MuiLink key={crumb.path} component={LocaleLink} href={crumb.path}>
                  {crumb.name}
                </MuiLink>
              ) : (
                <Typography key={crumb.path} aria-current="page">
                  {crumb.name}
                </Typography>
              ),
            )}
          </Box>
        }
        headerActions={
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <MuiLink
              component={LocaleLink}
              href="/spraywalls"
              sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
            >
              {t('sprayRoute')}
            </MuiLink>
            <MuiLink
              component={LocaleLink}
              href="/boards"
              sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
            >
              {t('compatibility')}
            </MuiLink>
          </Box>
        }
      >
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: breadcrumbs.map((crumb, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              name: crumb.name,
              item: absoluteUrl(localeHref(crumb.path, locale)),
            })),
          }}
        />
        {!result.ok ? (
          <StatePanel
            tone="warning"
            icon={<WarningAmberOutlined />}
            title={t('sprayDirectory.errorTitle')}
            body={t('sprayDirectory.errorBody')}
            actions={
              <Button variant="contained" href={localeHref(buildSprayDirectoryHref(query, query.page), locale)}>
                {t('sprayDirectory.retry')}
              </Button>
            }
          />
        ) : (
          <SprayDirectoryExplorer
            key={buildSprayDirectoryHref(query, query.page)}
            query={query}
            locale={locale}
            walls={result.connection.boards}
            filters={<SprayDirectoryAngleFilters selectedAngles={query.angles ?? []} />}
          >
            <Typography component="h2" variant="h6" sx={{ mb: 2 }}>
              {t('sprayDirectory.results', { count: result.connection.totalCount })}
            </Typography>
            {result.connection.boards.length ? (
              <SprayDirectoryRows walls={result.connection.boards} locale={locale} />
            ) : (
              <StatePanel
                tone="brand"
                icon={<SearchOutlined />}
                title={t('sprayDirectory.emptyTitle')}
                body={t('sprayDirectory.emptyBody')}
                actions={
                  <Button component={LocaleLink} href={SPRAY_DIRECTORY_PATH}>
                    {t('sprayDirectory.clearSearch')}
                  </Button>
                }
              />
            )}
            <DirectoryPagination
              currentPage={query.page}
              totalCount={result.connection.totalCount}
              pageSize={SPRAY_DIRECTORY_PAGE_SIZE}
              maxPages={SPRAY_DIRECTORY_MAX_PAGE}
              hrefForPage={(page) => buildSprayDirectoryHref(query, page)}
              labels={{
                region: gyms('pagination.label'),
                previous: gyms('pagination.previous'),
                next: gyms('pagination.next'),
                page: (page) => gyms('pagination.page', { page }),
                current: (page) => gyms('pagination.current', { page }),
              }}
            />
          </SprayDirectoryExplorer>
        )}
      </PageShell>
    </I18nProvider>
  );
}
