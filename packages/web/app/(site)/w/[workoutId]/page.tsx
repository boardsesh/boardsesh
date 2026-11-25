import React from 'react';
import { notFound } from 'next/navigation';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import { WorkoutSourceName } from '@/app/w/[workoutId]/workout-source-name';
import Typography from '@mui/material/Typography';
import { getServerTranslation } from '@/app/lib/i18n/server';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { PageSection, PageShell } from '@/app/components/ui/page-shell';

type Props = { params: Promise<{ workoutId: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Props) {
  const { workoutId } = await params;
  const { t, locale } = await getServerTranslation('session');
  return createNoIndexMetadata({
    title: t('partnerWorkouts.webTitle'),
    description: t('partnerWorkouts.webDescription'),
    path: `/w/${encodeURIComponent(workoutId)}`,
    locale,
  });
}

export default async function WorkoutLaunchPage({ params }: Props) {
  const { workoutId } = await params;
  if (!/^wk_[A-Za-z0-9_-]{1,128}$/.test(workoutId)) notFound();
  const { t, locale } = await getServerTranslation('session');
  return (
    <PageShell title={t('partnerWorkouts.webTitle')}>
      <PageSection>
        <Stack spacing={3}>
          <I18nProvider locale={locale} namespaces={['session']}>
            <WorkoutSourceName workoutId={workoutId} />
          </I18nProvider>
          <Typography>{t('partnerWorkouts.webDescription')}</Typography>
          <Button component="a" href={`com.boardsesh.app://w/${encodeURIComponent(workoutId)}`} variant="contained">
            {t('partnerWorkouts.openApp')}
          </Button>
          <Button component="a" href={IOS_APP_STORE_URL}>
            {t('partnerWorkouts.downloadIos')}
          </Button>
          <Button component="a" href={ANDROID_PLAY_STORE_URL}>
            {t('partnerWorkouts.downloadAndroid')}
          </Button>
        </Stack>
      </PageSection>
    </PageShell>
  );
}
