import HomePage, { getHomePageMetadata } from '@/app/components/home/home-page';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';

// Facet counts refresh every fifteen minutes; community totals keep their own six-hour cache.
export const revalidate = 900;
export function generateMetadata() {
  return getHomePageMetadata(DEFAULT_LOCALE);
}
export default function Home() {
  return <HomePage locale={DEFAULT_LOCALE} />;
}
