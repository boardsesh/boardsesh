import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';

export type ShareLinkResult = 'shared' | 'copied' | 'cancelled';

export type ShareLinkOptions = {
  url: string;
  message: string;
};

/** Shares a link during the tap, with a clipboard fallback in browsers. */
export async function shareLink({ url, message }: ShareLinkOptions): Promise<ShareLinkResult> {
  const copyLink = async (): Promise<ShareLinkResult> => {
    if (!(await Clipboard.setStringAsync(url))) throw new Error('The link could not be copied.');
    return 'copied';
  };

  if (Platform.OS === 'web' && (typeof navigator === 'undefined' || typeof navigator.share !== 'function')) {
    return copyLink();
  }

  try {
    const result = await Share.share(
      Platform.OS === 'android' ? { message: message === url ? url : `${message}\n${url}` } : { message, url },
    );
    // React Native Web forwards navigator.share(), whose success result is void.
    if (Platform.OS === 'web') return 'shared';
    return result.action === Share.dismissedAction ? 'cancelled' : 'shared';
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
      return 'cancelled';
    }
    if (Platform.OS === 'web') return copyLink();
    throw error;
  }
}
