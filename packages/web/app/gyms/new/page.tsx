import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { PageShell } from '@/app/components/ui/page-shell';
import { isGymSetupUuid, loadSetupGym } from './load-setup-gym';
import GymSetup from './gym-setup';

export const dynamic = 'force-dynamic';

type NewGymPageProps = {
  searchParams: Promise<{ gym?: string | string[] }>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('gyms');
  return createNoIndexMetadata({
    title: t('create.title'),
    description: t('create.description'),
    path: '/gyms/new',
    locale,
  });
}

export default async function NewGymPage({ searchParams }: NewGymPageProps) {
  const { gym: gymUuid } = await searchParams;
  if (gymUuid !== undefined && !isGymSetupUuid(gymUuid)) notFound();
  const { t, locale } = await getServerTranslation('gyms');
  const token = await getServerAuthToken();
  if (!token) {
    const returnPath = localeHref(`/gyms/new${gymUuid ? `?gym=${encodeURIComponent(gymUuid)}` : ''}`, locale);
    redirect(`${localeHref('/auth/login', locale)}?callbackUrl=${encodeURIComponent(returnPath)}`);
  }

  const gym = gymUuid ? await loadSetupGym(gymUuid, token) : null;
  if (gymUuid && !gym) notFound();

  return (
    <I18nProvider locale={locale} namespaces={['common', 'gyms', 'boards', 'kiosk']}>
      <PageShell title={t('create.title')} lead={t('create.description')}>
        <GymSetup initialGym={gym} />
      </PageShell>
    </I18nProvider>
  );
}
