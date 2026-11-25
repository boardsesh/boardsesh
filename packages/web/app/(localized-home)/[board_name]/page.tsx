import HomePage, { getHomePageMetadata } from '@/app/components/home/home-page';
import { LOCALIZED_HOME_LOCALES, localizedHomeLocale } from '@/app/lib/i18n/localized-home';

type PageProps = { params: Promise<{ board_name: string }> };
export const dynamicParams = false;
export const revalidate = 900;
export function generateStaticParams() {
  return LOCALIZED_HOME_LOCALES.map((locale) => ({ board_name: locale }));
}
export async function generateMetadata({ params }: PageProps) {
  return getHomePageMetadata(localizedHomeLocale((await params).board_name));
}
export default async function LocalizedHome({ params }: PageProps) {
  return <HomePage locale={localizedHomeLocale((await params).board_name)} />;
}
