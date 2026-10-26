import { Fragment, memo, useCallback, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type FlatListProps, type LayoutChangeEvent } from 'react-native';
import { Surface } from 'react-native-paper';
import {
  SectionLayoutList,
  type PlacedSectionLayoutRow,
  type SectionLayoutRowModel,
  type SectionMoveHandler,
} from './SectionLayoutList';
import { spacing } from '../../theme/tokens';

const NO_SEPARATORS = { highlight: () => {}, unhighlight: () => {}, updateProps: () => {} };

/**
 * Every row at once, with no scroller of its own: the Settings form around it
 * scrolls. A dozen rows at most, so there is nothing to virtualise.
 */
function StaticRowList<Id extends string>({
  data,
  renderItem,
  keyExtractor,
}: FlatListProps<PlacedSectionLayoutRow<Id>>) {
  // `data` is only `ArrayLike` here, so map it in `Array.from` itself: no copy first.
  return (
    <View>
      {Array.from(data ?? [], (item, index) => (
        <Fragment key={keyExtractor ? keyExtractor(item, index) : item.id}>
          {renderItem?.({ item, index, separators: NO_SEPARATORS })}
        </Fragment>
      ))}
    </View>
  );
}

type SectionLayoutFormListProps<Id extends string> = {
  /** The rows that move, in the climber's order. */
  rows: readonly SectionLayoutRowModel<Id>[];
  /** Greys every switch and arrow out, such as while the saved order still loads. */
  disabled?: boolean;
  onVisibleChange: (sectionId: Id, visible: boolean) => void;
  onMove: SectionMoveHandler<Id>;
  /** The list's drawn height, for the form row that hosts it (Dynamic Type grows it). */
  onHeightChange: (height: number) => void;
  testID?: string;
};

/**
 * A Settings page's reorderable rows (Marco's ask on #6546, Settings › Home and
 * Settings › Climbs & grades › Quick filters): the sheet's switch-and-arrows
 * rows, hosted in the native Settings form as its one React Native row, since
 * the form has no reorderable row of its own. The rows sit on the form's card
 * on iOS and Android. The browser's full-bleed row has no card and bleeds to the
 * screen edge, so there they draw the browser form's own card (Paper `Surface`,
 * as `MoreForm.web` does) inset back to the others.
 */
function SectionLayoutFormListBase<Id extends string>({
  rows,
  disabled,
  onVisibleChange,
  onMove,
  onHeightChange,
  testID,
}: SectionLayoutFormListProps<Id>) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const drawnHeight = Math.ceil(event.nativeEvent.layout.height);
      // A host that has not been laid out yet reports nothing; keep the guess.
      if (drawnHeight > 0) onHeightChange(drawnHeight);
    },
    [onHeightChange],
  );
  return (
    <View onLayout={handleLayout} testID={testID}>
      <BrowserCard>
        <SectionLayoutList
          ListComponent={StaticRowList}
          rows={rows}
          disabled={disabled}
          rowBackgroundColor="transparent"
          onVisibleChange={onVisibleChange}
          onMove={onMove}
        />
      </BrowserCard>
    </View>
  );
}

export const SectionLayoutFormList = memo(SectionLayoutFormListBase) as typeof SectionLayoutFormListBase;

/** The browser form's card, inset to cancel the full-bleed row's margin. Native forms draw their own. */
function BrowserCard({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return children;
  return (
    <Surface style={styles.browserCard} elevation={1}>
      {children}
    </Surface>
  );
}

const styles = StyleSheet.create({
  // MoreForm.web's `card`, plus the `spacing[4]` its `fullBleed` takes away.
  browserCard: { marginHorizontal: spacing[4], borderRadius: 12, overflow: 'hidden' },
});
