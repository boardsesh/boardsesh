import { useCallback } from 'react';
import { hapticSelection } from '../lib/haptics';
import { shareLink } from '../lib/share-link';
import { prewarmShareCaches } from '../lib/share-prewarm';
import { useToast } from '../providers/toast-provider';

export type ShareLinkActionOptions = {
  /** A loading or unavailable link cannot be shared. */
  url: string | null;
  message: string;
  copiedMessage: string;
  errorMessage: string;
  /** A share is tracked as an intent, before the recipient is chosen. */
  onShare?: () => void;
  prewarmOgImageUrl?: string | null;
};

/** The same share action for native bar items, icon buttons and sheet buttons. */
export function useShareLinkAction({
  url,
  message,
  copiedMessage,
  errorMessage,
  onShare,
  prewarmOgImageUrl,
}: ShareLinkActionOptions): () => void {
  const { showToast } = useToast();
  return useCallback(() => {
    if (!url) return;
    hapticSelection();
    onShare?.();
    // Start the render without delaying the share sheet or the browser's tap permission.
    if (prewarmOgImageUrl) void prewarmShareCaches(url, prewarmOgImageUrl);
    void shareLink({ url, message }).then(
      (result) => {
        if (result === 'copied') showToast(copiedMessage, 'success');
      },
      () => showToast(errorMessage, 'error'),
    );
  }, [url, message, copiedMessage, errorMessage, onShare, prewarmOgImageUrl, showToast]);
}
