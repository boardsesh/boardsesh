import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useChoose } from '../../providers/dialog-provider';
import { openExternalUrl } from '../open-url';
import { trackBluetoothUnavailable } from './bluetooth-unavailable';
import type { BrowserBluetoothGuidance } from './use-browser-bluetooth-guidance';

const WEBBT_SETUP_URL = 'https://github.com/stevennyman/webbt#installation';

/** Web uses the rendered Material dialog: React Native's Alert is a no-op here. */
export function useBrowserBluetoothGuidance(): BrowserBluetoothGuidance {
  const choose = useChoose();
  const { t } = useTranslation('settings');

  return useCallback(
    async (boardName) => {
      trackBluetoothUnavailable('unsupported', 'connect', boardName);
      const action = await choose({
        title: t('ble.browserUnsupported.title'),
        message: t('ble.browserUnsupported.message'),
        options: [
          { value: 'close', label: t('common:actions.close'), cancel: true },
          { value: 'setup', label: t('ble.browserUnsupported.setup') },
        ],
        cancelValue: 'close',
      });
      if (action === 'setup') await openExternalUrl(WEBBT_SETUP_URL, 'browser-bluetooth-guidance');
    },
    [choose, t],
  );
}
