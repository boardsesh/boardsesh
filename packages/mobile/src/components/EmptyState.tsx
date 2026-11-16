import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { Text, type TextVariant } from './Text';
import type { IconName } from './icon-map';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

type EmptyStateCommonProps = {
  title: string;
  /**
   * `screen` and `section`: buttons centred under the text (a `Button`, or two).
   * `quiet`: one trailing `TextAction` ("Retry").
   */
  actions?: ReactNode;
  testID?: string;
};

export type EmptyStateProps =
  | (EmptyStateCommonProps & {
      /**
       * `screen` fills and centres in the space it is given (a tab with nothing
       * in it, an iPad pane); `section` centres inside a section of a longer
       * page, with 32pt above and below.
       */
      size: 'screen' | 'section';
      /** One or two sentences under the title: what to do about it. */
      body?: string;
      /** A glyph above the title, in tertiary label. */
      icon?: IconName;
      /**
       * Extra layout on the placard's root: the safe-area padding a top-of-shell
       * pane owns, or the extra top inset of a list's `ListEmptyComponent`.
       */
      style?: StyleProp<ViewStyle>;
      /** Caps the width of the title and body, so a wide pane keeps a readable line. */
      maxContentWidth?: number;
      /** Title type size; defaults to `headline`. */
      titleVariant?: TextVariant;
    })
  | (EmptyStateCommonProps & {
      /**
       * One footnote line at the gutter, for a shelf or list that came back
       * empty and doesn't deserve a placard ("No sessions this week"). No body,
       * no icon, no minimum height.
       */
      size: 'quiet';
      body?: never;
      icon?: never;
      style?: never;
      maxContentWidth?: never;
      titleVariant?: never;
    });

/**
 * "Nothing here yet", at one of three weights. The title is the label colour and
 * the body steps down to secondary label through `tone`, never through opacity,
 * so both hold their contrast in dark mode and with Increase Contrast.
 */
export function EmptyState(props: EmptyStateProps) {
  const { systemColors } = useTheme();
  const { title, actions, testID } = props;

  if (props.size === 'quiet') {
    return (
      <View style={styles.quiet} testID={testID}>
        <Text variant="footnote" tone="secondary" style={styles.quietText}>
          {title}
        </Text>
        {actions}
      </View>
    );
  }

  const { size, body, icon, style, maxContentWidth, titleVariant = 'headline' } = props;
  const widthCap = maxContentWidth == null ? undefined : { maxWidth: maxContentWidth };
  return (
    <View style={[size === 'screen' ? styles.screen : styles.section, style]} testID={testID}>
      {icon ? <Icon name={icon} size={size === 'screen' ? 40 : 32} color={systemColors.tertiaryLabel} /> : null}
      <Text
        variant={titleVariant}
        style={
          widthCap
            ? [icon ? styles.titleAfterIcon : styles.centred, widthCap]
            : icon
              ? styles.titleAfterIcon
              : styles.centred
        }
      >
        {title}
      </Text>
      {body ? (
        <Text variant="subheadline" tone="secondary" style={widthCap ? [styles.centred, widthCap] : styles.centred}>
          {body}
        </Text>
      ) : null}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[6],
    gap: spacing[2],
  },
  section: {
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
    gap: spacing[2],
  },
  centred: {
    textAlign: 'center',
  },
  titleAfterIcon: {
    marginTop: spacing[2],
    textAlign: 'center',
  },
  actions: {
    marginTop: spacing[3],
    alignItems: 'center',
    gap: spacing[2],
  },
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
  },
  quietText: {
    flex: 1,
    minWidth: 0,
  },
});
