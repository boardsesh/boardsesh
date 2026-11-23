// The short explanation a directory notice opens when there is nothing left to
// show: a board staff deleted, a gym claim we couldn't confirm. A native alert
// with one OK, worded in the `notifications` namespace.

import { Alert } from 'react-native';
import type { DirectoryNoticeRoute } from './directory-notice-route';

type TFn = (key: string, options?: Record<string, unknown>) => string;

export function explainDirectoryNotice(route: Extract<DirectoryNoticeRoute, { kind: 'explain' }>, t: TFn): void {
  if (route.explanation === 'board_deleted') {
    Alert.alert(
      route.name ? t('explain.boardDeletedTitle', { board: route.name }) : t('items.boardDeletedByStaffGeneric'),
      t('explain.boardDeletedBody'),
      [{ text: t('explain.ok') }],
    );
    return;
  }
  Alert.alert(
    t('explain.claimDeniedTitle'),
    route.name ? t('explain.claimDeniedBody', { gym: route.name }) : t('items.gymClaimDeniedGeneric'),
    [{ text: t('explain.ok') }],
  );
}
