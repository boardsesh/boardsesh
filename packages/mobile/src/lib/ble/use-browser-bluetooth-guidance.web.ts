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
    async (boardName, failure) => {
      if (failure) {
        let title = t('ble.connectionFailedTitle');
        let message: string;
        switch (failure.category) {
          case 'permission_denied':
            title = t('ble.browserBlocked.title');
            message = t('ble.browserBlocked.message');
            trackBluetoothUnavailable('unauthorized', 'connect', boardName);
            break;
          case 'unavailable':
            message = t('ble.browserUnavailable');
            trackBluetoothUnavailable('unknown', 'connect', boardName);
            break;
          case 'board_not_found':
            message = t('common:bluetooth.boardNotFound');
            break;
          case 'service_missing':
            message = t('common:bluetooth.serviceMissing');
            break;
          case 'connect_failed':
            message = failure.afterBoardSwitch
              ? t('common:bluetooth.boardSwitchConnectFailed')
              : t('common:bluetooth.connectFailed');
            break;
          default:
            message = failure.afterBoardSwitch
              ? t('common:bluetooth.boardSwitchConnectFailed')
              : t('common:bluetooth.unknownError');
        }
        await choose({
          title,
          message,
          options: [{ value: 'close', label: t('common:actions.close'), cancel: true }],
          cancelValue: 'close',
        });
        return;
      }

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
