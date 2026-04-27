import { track } from '@/app/lib/analytics';

type ShareOptions = {
  /** The full URL to share */
  url: string;
  /** Title for the native share sheet */
  title: string;
  /** Description text for the native share sheet */
  text: string;
  /** Vercel Analytics event name, e.g. 'Profile Shared' */
  trackingEvent: string;
  /** Additional properties for the analytics event */
  trackingProps?: Record<string, string>;
  /** Called after successful clipboard copy */
  onClipboardSuccess?: () => void;
  /** Called when sharing fails entirely */
  onError?: () => void;
};

/**
 * Fallback clipboard copy for non-secure contexts where
 * navigator.clipboard is unavailable.
 */
function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else if (!legacyCopy(text)) {
    throw new Error('Copy failed');
  }
}

export async function shareWithFallback({
  url,
  title,
  text,
  trackingEvent,
  trackingProps = {},
  onClipboardSuccess,
  onError,
}: ShareOptions): Promise<boolean> {
  const shareData = { title, text, url };

  try {
    if (navigator.share && navigator.canShare?.(shareData)) {
      await navigator.share(shareData);
      track(trackingEvent, { ...trackingProps, method: 'native' });
      return true;
    } else {
      await copyToClipboard(url);
      onClipboardSuccess?.();
      track(trackingEvent, { ...trackingProps, method: 'clipboard' });
      return true;
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      try {
        await copyToClipboard(url);
        onClipboardSuccess?.();
        track(trackingEvent, { ...trackingProps, method: 'clipboard' });
        return true;
      } catch {
        onError?.();
        return false;
      }
    }
    return false;
  }
}
