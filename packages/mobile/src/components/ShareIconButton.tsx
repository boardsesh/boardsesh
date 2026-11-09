import { useCallback } from 'react';
import { Platform, Share, type ColorValue } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { GlassIconButton } from './GlassIconButton';
import { useTheme } from '../providers/theme-provider';
import { useToast } from '../providers/toast-provider';
import { hapticSelection } from '../lib/haptics';

type ShareIconButtonProps = {
  url: string;
  message: string;
  accessibilityLabel: string;
  /** Toast after the browser app copies the link because it has no share menu. */
  copiedMessage: string;
  errorMessage: string;
  /** Runs on the tap: the share is tracked as an intent, like `ClimbShared`. */
  onShare: () => void;
  iconColor?: ColorValue;
};

/** Header icon that opens the system share sheet for a public link. */
export function ShareIconButton({
  url,
  message,
  accessibilityLabel,
  copiedMessage,
  errorMessage,
  onShare,
  iconColor,
}: ShareIconButtonProps) {
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  const handlePress = useCallback(() => {
    hapticSelection();
    onShare();

    // On web expo-clipboard resolves `false` rather than rejecting when the copy is blocked.
    const copyLink = () =>
      Clipboard.setStringAsync(url).then(
        (copied) => (copied ? showToast(copiedMessage, 'success') : showToast(errorMessage, 'error')),
        () => showToast(errorMessage, 'error'),
      );

    // A desktop browser has no share menu: copy straight away, while the tap
    // still allows a clipboard write.
    if (Platform.OS === 'web' && (typeof navigator === 'undefined' || typeof navigator.share !== 'function')) {
      void copyLink();
      return;
    }

    // Android's share sheet has no url field, so the link rides in the message.
    Share.share(Platform.OS === 'android' ? { message: `${message}\n${url}` } : { message, url }).catch(
      (error: unknown) => {
        // Backing out of the browser's share menu rejects with AbortError: not a failure.
        if (error instanceof Error && error.name === 'AbortError') return;
        if (Platform.OS === 'web') {
          void copyLink();
          return;
        }
        console.warn('[ShareIconButton] share failed:', error);
        showToast(errorMessage, 'error');
      },
    );
  }, [copiedMessage, errorMessage, message, onShare, showToast, url]);

  return (
    <GlassIconButton
      iconName="share"
      iconColor={iconColor ?? systemColors.label}
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      fallbackColor={systemColors.fill}
    />
  );
}
