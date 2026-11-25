import { createIdbPersister } from '@/app/lib/react-query-idb-persister';
import { removePreference } from '@/app/lib/user-preferences-db';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/draft-key';
import { PRIVACY_REVOKED_EVENT } from '@/app/lib/privacy-client';
import { clearInitializedMarketingQueries } from './marketing-query-cleanup';

/** The persistent session owner invokes this once per accepted change or retirement. */
export async function clearMarketingViewerState(): Promise<void> {
  const queriesCleared = clearInitializedMarketingQueries();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIVACY_REVOKED_EVENT));
  await Promise.all([
    queriesCleared,
    Promise.resolve(createIdbPersister().removeClient()),
    removePreference(CNC_CONFIGURATOR_DRAFT_KEY),
  ]);
}
