import { useCallback, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { NativeLargeContentViewer } from '../../modules/accessibility-ui/src/index';

type LargeContentViewerProps = {
  /** What the viewer shows: the words the capped label is showing. */
  title: string;
  /** An SF Symbol name shown above the title. */
  systemImage?: string;
  /** Runs when the finger lifts on the bar while the viewer is up, like a UIKit bar item. */
  onActivate?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
};

/**
 * Shows `title` in the iOS Large Content Viewer when the climber long-presses
 * this area at an accessibility text size (HIG Accessibility > Large Content
 * Viewer).
 *
 * For persistent chrome whose label is capped at `CHROME_LABEL_MAX_FONT_SCALE`:
 * the bar cannot grow, so the viewer is how the words still reach someone who
 * needs them larger. At every other text size, and on Android, on the web and
 * on a binary without `modules/accessibility-ui`, this is a plain `View`.
 *
 * Put it around the LABEL only, never around a control with its own long press
 * (the lightbulb): the viewer's long press would take that gesture.
 */
export function LargeContentViewer({
  title,
  systemImage,
  onActivate,
  style,
  testID,
  children,
}: LargeContentViewerProps) {
  const handleActivate = useCallback(() => {
    onActivate?.();
  }, [onActivate]);

  // The module is iOS-only (expo-module.config.json), so this is null on
  // Android as well as on the web and on older binaries.
  if (!NativeLargeContentViewer) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <NativeLargeContentViewer
      title={title}
      systemImage={systemImage}
      onLargeContentViewerActivate={onActivate ? handleActivate : undefined}
      style={style}
      testID={testID}
    >
      {children}
    </NativeLargeContentViewer>
  );
}
