import 'server-only';
import { getAdmittedRawServerToken } from './admitted-session.server';

/** Forward only an admitted legacy credential or a backend-issued selected
 * browser lease. An opaque source token is never forwarded or read from a SID. */
export async function getServerAuthToken(): Promise<string | undefined> {
  return getAdmittedRawServerToken();
}
