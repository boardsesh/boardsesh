'use server';

import { revalidateTag } from 'next/cache';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { loadSetupGym } from './load-setup-gym';

/** Cache work stays on www; gym writes and permission checks stay on GraphQL. */
export async function refreshGymDirectory(gymUuid: string): Promise<boolean> {
  try {
    const token = await getServerAuthToken();
    if (!token || !(await loadSetupGym(gymUuid, token))) return false;
    revalidateTag('gym-directory', { expire: 0 });
    revalidateTag('gym-directory-facet-counts', { expire: 0 });
    return true;
  } catch {
    // The mutation has already succeeded. Let the UI retry cache work without
    // submitting a second create or moving a board a second time.
    return false;
  }
}
