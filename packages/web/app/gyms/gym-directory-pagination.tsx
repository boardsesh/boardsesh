import { DirectoryPagination } from '@/app/components/directory/directory-pagination';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { DIRECTORY_PAGE_SIZE, buildDirectoryHref, type DirectoryFacet, type DirectoryQuery } from './directory-facets';

type GymDirectoryPaginationProps = {
  facet: DirectoryFacet;
  query: DirectoryQuery;
  totalCount: number;
};

export default async function GymDirectoryPagination({ facet, query, totalCount }: GymDirectoryPaginationProps) {
  const { t } = await getServerTranslation('gyms');
  return DirectoryPagination({
    currentPage: query.page,
    totalCount,
    pageSize: DIRECTORY_PAGE_SIZE,
    hrefForPage: (page) => buildDirectoryHref(facet, query, page),
    labels: {
      region: t('pagination.label'),
      previous: t('pagination.previous'),
      next: t('pagination.next'),
      page: (page) => t('pagination.page', { page }),
      current: (page) => t('pagination.current', { page }),
    },
  });
}
