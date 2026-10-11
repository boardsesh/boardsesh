import { useSyncExternalStore } from 'react';
import { useKeepAwakeWhile } from '../hooks/use-keep-awake-while';
import { isDownloadKeepAwakeActive, subscribeDownloadKeepAwake } from '../offline/download-keep-awake-store';

// Its own tag, so the play drawer's and the wall kiosk's locks are untouched.
const KEEP_AWAKE_TAG = 'offline-download';

const getServerSnapshot = (): boolean => false;

/**
 * Holds the screen awake while a board download the person started is running
 * (issue #4310). A Kilter download takes 20–60 s; with a 30 s auto-lock the
 * phone used to lock in the middle of it, which suspends the app and cuts the
 * transfer off.
 *
 * Renders nothing, and subscribes to one boolean that flips a handful of times
 * per download, so the progress frames behind it never re-render the root. On
 * Expo web no sync engine runs, the boolean stays false, and this is inert.
 */
export function OfflineDownloadKeepAwake(): null {
  const active = useSyncExternalStore(subscribeDownloadKeepAwake, isDownloadKeepAwakeActive, getServerSnapshot);
  useKeepAwakeWhile(active, KEEP_AWAKE_TAG);
  return null;
}
