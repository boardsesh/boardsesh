import React from 'react';
import { notFound } from 'next/navigation';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
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

/** This unauthenticated page deliberately requests only the public app name. */
async function publicSourceName(workoutId: string): Promise<string | null> {
  const backend = getBackendHttpUrl();
  if (!backend) return null;
  try {
    const response = await fetch(`${backend}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        query: 'query PublicAppWorkoutLaunch($id: ID!) { publicAppWorkoutLaunch(id: $id) { sourceAppName } }',
        variables: { id: workoutId },
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { publicAppWorkoutLaunch?: { sourceAppName?: unknown } | null } };
    const name = body.data?.publicAppWorkoutLaunch?.sourceAppName;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

export default async function WorkoutLaunchPage({ params }: Props) {
  const { workoutId } = await params;
  if (!/^wk_[A-Za-z0-9_-]{1,128}$/.test(workoutId)) notFound();
  const { t } = await getServerTranslation('session');
  const sourceName = await publicSourceName(workoutId);
  return (
    <PageShell title={t('partnerWorkouts.webTitle')}>
      <PageSection>
        <Stack spacing={3}>
          {sourceName ? <Typography>{t('partnerWorkouts.from', { app: sourceName })}</Typography> : null}
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
