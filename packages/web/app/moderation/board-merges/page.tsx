import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import BoardMergesPanel from '@/app/components/board-merges/board-merges-panel';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('boards');
  return createNoIndexMetadata({
    title: t('merge.title'),
    description: t('merge.description'),
    path: '/moderation/board-merges',
    locale,
  });
}
export default async function BoardMergesPage({
  searchParams,
}: {
  searchParams: Promise<{ boardUuid?: string; gymUuid?: string }>;
}) {
  const { t, locale } = await getServerTranslation('boards');
  const params = await searchParams;
  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards']}>
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Typography component="h1" variant="h4">
          {t('merge.title')}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
          {t('merge.description')}
        </Typography>
        <BoardMergesPanel initialBoardUuid={params.boardUuid} initialGymUuid={params.gymUuid} />
      </Container>
    </I18nProvider>
  );
}
