import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { TextAction } from './TextAction';
import { spacing } from '../theme/tokens';

/** From a shelf's header to its content. */
export const SHELF_HEADER_CONTENT_GAP = spacing[2];
/** From the end of one shelf's content to the next shelf's title. */
export const SHELF_SECTION_GAP = 28;
/** The least of the row a shelf title keeps before its action wraps under it. */
const TITLE_MIN_SHARE = '70%';

export type ShelfHeaderAction = {
  label: string;
  onPress: () => void;
  /** Defaults to `label`. "See all" alone doesn't say what it opens. */
  accessibilityLabel?: string;
};

export type ShelfHeaderProps = {
  title: string;
  /** One line under the title, in secondary label. */
  caption?: string;
  /** "See all": accent text and a chevron at the trailing gutter. */
  action?: ShelfHeaderAction;
  /** Anything else at the trailing edge (a menu button), after the action. */
  trailing?: ReactNode;
  testID?: string;
};

/**
 * The heading of a shelf: a run of content under a bold title, the way Apple
 * Music and the App Store head a row ("Recently played", "See all"). Title 3 at
 * the emphasized weight, a VoiceOver heading.
 *
 * It owns the 16pt gutter and no vertical space: there is no 44pt minimum height,
 * so the title sits 8pt above its content instead of floating in a tall bar. The
 * action reaches its tap target (44pt, 48dp on Material) with its own padded box, and
 * drops under the title at large text sizes. Use `ShelfSection` for the spacing
 * between shelves.
 */
export function ShelfHeader({ title, caption, action, trailing, testID }: ShelfHeaderProps) {
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.titleRow}>
        <Text variant="title3" emphasized accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {action ? (
          <TextAction
            label={action.label}
            onPress={action.onPress}
            accessibilityLabel={action.accessibilityLabel}
            chevron
            // Its content is 8pt below: the target leans up, away from it.
            reach="up"
          />
        ) : null}
        {trailing}
      </View>
      {caption ? (
        <Text variant="subheadline" tone="secondary" style={styles.caption}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

export type ShelfSectionProps = Omit<ShelfHeaderProps, 'testID'> & {
  children: ReactNode;
  testID?: string;
};

/**
 * A shelf: its header, 8pt, then its content, and 28pt before the next shelf.
 * The content draws its own gutter, so a carousel can run edge to edge and a
 * card can inset itself 16pt.
 */
export function ShelfSection({ children, testID, ...header }: ShelfSectionProps) {
  return (
    <View style={styles.section} testID={testID}>
      <ShelfHeader {...header} />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing[4],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // The action and trailing node drop under the title when keeping them beside
    // it would leave the title less than `TITLE_MIN_SHARE` of the row (an
    // accessibility text size on a phone), rather than squeezing it.
    flexWrap: 'wrap',
    columnGap: spacing[3],
    rowGap: spacing[1],
  },
  title: {
    flexGrow: 1,
    flexShrink: 1,
    // A zero basis clamped to the minimum share: Yoga breaks the line on that
    // clamped size, so the action stays beside the title at default sizes and
    // wraps only when the title would fall under the share.
    flexBasis: 0,
    minWidth: TITLE_MIN_SHARE,
  },
  caption: {
    marginTop: 2,
  },
  section: {
    paddingBottom: SHELF_SECTION_GAP,
  },
  content: {
    paddingTop: SHELF_HEADER_CONTENT_GAP,
  },
});
