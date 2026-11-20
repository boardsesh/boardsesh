import type { ColorValue } from 'react-native';
import { GlassIconButton } from './GlassIconButton';
import { ChromeIconButton } from './ChromeIconButton';
import { useTheme } from '../providers/theme-provider';
import { useShareLinkAction } from '../hooks/use-share-link-action';

type ShareIconButtonProps = {
  url: string;
  message: string;
  accessibilityLabel: string;
  /** Toast after the browser app copies the link because it has no share menu. */
  copiedMessage: string;
  errorMessage: string;
  /** Runs on the tap: the share is tracked as an intent, like `ClimbShared`. */
  onShare?: () => void;
  /** Native headers already supply the button's background. */
  appearance?: 'floating' | 'nativeHeader';
  /**
   * The backend share card behind `url`, warmed before the sheet opens so a chat
   * app's unfurler finds it rendered. Omit for a link with no card.
   */
  prewarmOgImageUrl?: string;
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
  appearance = 'floating',
  prewarmOgImageUrl,
  iconColor,
}: ShareIconButtonProps) {
  const { systemColors } = useTheme();
  const handlePress = useShareLinkAction({
    url,
    message,
    copiedMessage,
    errorMessage,
    onShare,
    prewarmOgImageUrl,
  });

  if (appearance === 'nativeHeader') {
    return (
      <ChromeIconButton
        icon="share"
        role="action"
        appearance="bare"
        color={iconColor}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

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
