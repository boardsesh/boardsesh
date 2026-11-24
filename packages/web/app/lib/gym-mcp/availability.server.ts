import 'server-only';
import { GYM_MCP_ENDPOINT } from './endpoint';

/** The backend owns rollout state; the web service need not mirror its environment. */
export async function getGymMcpAvailability(): Promise<{ enabled: boolean; invitationRequired: boolean }> {
  try {
    const response = await fetch(`${GYM_MCP_ENDPOINT}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { enabled: false, invitationRequired: false };
    const status: unknown = await response.json();
    const enabled = typeof status === 'object' && status !== null && 'enabled' in status && status.enabled === true;
    return {
      enabled,
      invitationRequired:
        enabled &&
        typeof status === 'object' &&
        status !== null &&
        'invitationRequired' in status &&
        status.invitationRequired === true,
    };
  } catch {
    // An unavailable connector must not prevent someone managing their gym.
    return { enabled: false, invitationRequired: false };
  }
}
