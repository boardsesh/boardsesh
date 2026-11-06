import 'server-only';
import { getAdmittedRawServerToken } from './admitted-session.server';

/** Forward only the exact chunk-aware credential admitted by the backend. */
export async function getServerAuthToken(): Promise<string | undefined> {
  return getAdmittedRawServerToken();
}
