import HomePage, { getHomePageMetadata } from '@/app/components/home/home-page';
import { getLocale } from '@/app/lib/i18n/get-locale';

export async function generateMetadata() {
  return getHomePageMetadata(await getLocale());
}

export default async function Home() {
  return <HomePage locale={await getLocale()} />;
}
