import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BOARD_DISPLAY_ORDER, type BoardName } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { outlineEditorLayouts, outlineEditorSetIds, outlineEditorSizes } from './board-configs';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';

// Admin-only screen — hardcoded English literals, the tester-screen convention.

type PickerRow = { key: string; id: number; label: string; detail?: string };

/**
 * Board → layout → size, then into the canvas.
 *
 * Plain `.map()` inside a `ScrollView`, deliberately unvirtualized: the three
 * lists are 8 boards, at most ~14 layouts and at most ~10 sizes, all resolved
 * synchronously from bundled constants. A FlashList here would cost more than it
 * saves — see the list rule in docs/react-native-performance.md, which is about
 * unbounded/remote lists.
 *
 * Everything the backend's `holdOutlines` query can answer for is listed,
 * including the boards that ship no traced shard at all (Woods): a config with
 * no shard is exactly the one worth hand-drawing, and the editor draws its
 * placements as "missing" rings rather than hiding them.
 */
export function OutlineEditorPickerScreen() {
  const router = useRouter();
  const { systemColors, brandColors } = useTheme();

  const [boardName, setBoardName] = useState<BoardName | null>(null);
  const [layoutId, setLayoutId] = useState<number | null>(null);
  const [sizeId, setSizeId] = useState<number | null>(null);

  const boardRows = useMemo<PickerRow[]>(
    () =>
      BOARD_DISPLAY_ORDER.map((name) => ({
        key: name,
        id: 0,
        label: boardTypeLabel(name),
        detail: name,
      })),
    [],
  );

  const layoutRows = useMemo<PickerRow[]>(() => {
    if (!boardName) return [];
    return outlineEditorLayouts(boardName).map((layout) => ({
      key: `${boardName}-${layout.id}`,
      id: layout.id,
      label: layout.name,
      detail: `Layout ${layout.id}`,
    }));
  }, [boardName]);

  const sizeRows = useMemo<PickerRow[]>(() => {
    if (!boardName || layoutId == null) return [];
    return outlineEditorSizes(boardName, layoutId).map((size) => ({
      key: `${boardName}-${layoutId}-${size.id}`,
      id: size.id,
      label: size.name,
      detail: size.description || `Size ${size.id}`,
    }));
  }, [boardName, layoutId]);

  const handleSelectBoard = useCallback((name: BoardName) => {
    hapticSelection();
    setBoardName(name);
    setLayoutId(null);
    setSizeId(null);
  }, []);

  const handleSelectLayout = useCallback((nextLayoutId: number) => {
    hapticSelection();
    setLayoutId(nextLayoutId);
    setSizeId(null);
  }, []);

  const handleSelectSize = useCallback((nextSizeId: number) => {
    hapticSelection();
    setSizeId(nextSizeId);
  }, []);

  const handleOpen = useCallback(() => {
    if (!boardName || layoutId == null || sizeId == null) return;
    // Every set of the layout and size, which is how a geometry shard is traced
    // — the board art an override is drawn against has all of them mounted.
    const setIds = outlineEditorSetIds(boardName, layoutId, sizeId);
    router.push({
      pathname: '/(tabs)/profile/outline-canvas',
      params: { boardName, layoutId: String(layoutId), sizeId: String(sizeId), setIds },
    });
  }, [router, boardName, layoutId, sizeId]);

  const renderRows = (rows: PickerRow[], selectedId: number | null, onSelect: (id: number) => void) =>
    rows.map((row) => {
      const isSelected = selectedId === row.id;
      return (
        <Pressable
          key={row.key}
          onPress={() => onSelect(row.id)}
          accessibilityRole="button"
          accessibilityState={{ selected: isSelected }}
          style={[
            styles.row,
            {
              backgroundColor: systemColors.secondaryBackground,
              borderColor: isSelected ? brandColors.primary : 'transparent',
            },
          ]}
        >
          <Text variant="body">{row.label}</Text>
          {row.detail ? (
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {row.detail}
            </Text>
          ) : null}
        </Pressable>
      );
    });

  return (
    <ScrollView style={{ backgroundColor: systemColors.groupedBackground }} contentContainerStyle={styles.content}>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        Best with Apple Pencil on iPad.
      </Text>

      <Text variant="headline" style={styles.heading}>
        Board
      </Text>
      <View style={styles.rowGroup}>
        {boardRows.map((row) => {
          const isSelected = boardName === row.detail;
          return (
            <Pressable
              key={row.key}
              onPress={() => handleSelectBoard(row.key as BoardName)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              style={[
                styles.row,
                {
                  backgroundColor: systemColors.secondaryBackground,
                  borderColor: isSelected ? brandColors.primary : 'transparent',
                },
              ]}
            >
              <Text variant="body">{row.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {boardName ? (
        <>
          <Text variant="headline" style={styles.heading}>
            Layout
          </Text>
          <View style={styles.rowGroup}>{renderRows(layoutRows, layoutId, handleSelectLayout)}</View>
        </>
      ) : null}

      {boardName && layoutId != null ? (
        <>
          <Text variant="headline" style={styles.heading}>
            Size
          </Text>
          <View style={styles.rowGroup}>{renderRows(sizeRows, sizeId, handleSelectSize)}</View>
        </>
      ) : null}

      <Button
        title="Open the editor"
        variant="filled"
        onPress={handleOpen}
        disabled={!boardName || layoutId == null || sizeId == null}
        style={styles.openButton}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing[4],
    gap: spacing[2],
    paddingBottom: spacing[12],
  },
  heading: {
    marginTop: spacing[3],
  },
  rowGroup: {
    gap: spacing[2],
  },
  row: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.md,
    borderWidth: 2,
  },
  openButton: {
    marginTop: spacing[5],
  },
});
