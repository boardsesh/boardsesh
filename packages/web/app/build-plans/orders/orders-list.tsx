import 'server-only';
import type { CncCatalog, CncOrder } from '@boardsesh/shared-schema';
import { getServerTranslation } from '@/app/lib/i18n/server';
import OrdersListContent from './orders-list-content';

/** Legacy rendering stays server-side; selected browsers reuse this view only
 * after an owned client request, without serializing orders into Flight. */
export default async function OrdersList({
  orders,
  catalog,
  locale,
}: {
  orders: readonly CncOrder[];
  catalog: CncCatalog | null;
  locale: string;
}) {
  const { t } = await getServerTranslation('cnc');
  return <OrdersListContent orders={orders} catalog={catalog} locale={locale} t={t} />;
}
