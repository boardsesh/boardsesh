import { getBackendHttpUrl } from './backend-url';
import { isProductionHost } from './production-hosts';
/** Operational display health: no SDK storage, page URLs, referrers, user or session IDs. */
export function captureKioskPageLoad(): void {
  if (typeof window === 'undefined' || !isProductionHost(window.location.hostname)) return;
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const backendUrl = getBackendHttpUrl();
  if (!apiKey || !backendUrl) return;
  void fetch(`${backendUrl}/api/posthog/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({
      api_key: apiKey,
      batch: [
        {
          event: 'Kiosk Page Loaded',
          properties: {
            distinct_id: crypto.randomUUID(),
            $process_person_profile: false,
            $geoip_disable: true,
            kiosk: true,
            environment: 'production',
          },
        },
      ],
    }),
  }).catch(() => {});
}
