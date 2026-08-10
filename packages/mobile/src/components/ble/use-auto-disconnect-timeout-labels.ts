import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Localized labels for every auto-disconnect timeout choice, keyed by seconds.
 * Enumerated as literal keys (not a computed key) so the i18n orphan scanner
 * sees each catalog entry.
 */
export function useAutoDisconnectTimeoutLabels(): Record<number, string> {
  const { t: tSettings } = useTranslation('settings');
  return useMemo(
    () => ({
      10: tSettings('ble.autoDisconnect.timeoutOptions.10'),
      15: tSettings('ble.autoDisconnect.timeoutOptions.15'),
      30: tSettings('ble.autoDisconnect.timeoutOptions.30'),
      45: tSettings('ble.autoDisconnect.timeoutOptions.45'),
      60: tSettings('ble.autoDisconnect.timeoutOptions.60'),
      120: tSettings('ble.autoDisconnect.timeoutOptions.120'),
      300: tSettings('ble.autoDisconnect.timeoutOptions.300'),
      600: tSettings('ble.autoDisconnect.timeoutOptions.600'),
    }),
    [tSettings],
  );
}
