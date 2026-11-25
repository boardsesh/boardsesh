// Set up's checklist for a Layout or Size row with more than eight options
// (`setupRowControl`): a pushed list of the catalogue's layouts or sizes, each
// with its art, the current one ticked. A tap hands the pick back to the form
// that pushed it (setup-option-handoff.ts) and goes back. Built from the
// catalogue, not from the form. Opened with nothing to list or nobody to hand
// the pick to (a bare link), it goes back, or to the wizard's step 1 when
// there is nothing to go back to.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { ArtRow } from '../../../src/components/ArtRow';
import { InsetGroupedList } from '../../../src/components/InsetGroupedList';
import { BoardThumbnail } from '../../../src/components/boards/BoardThumbnail';
import { emitSetupOptionPick, type SetupOptionField } from '../../../src/lib/boards/setup-option-handoff';
import { readSetupOptionNumber, setupOptionRows, type SetupOptionRow } from '../../../src/lib/boards/setup-option-rows';
import { hapticSelection } from '../../../src/lib/haptics';
import { useBottomChromeMetrics } from '../../../src/hooks/use-bottom-chrome-metrics';
import { spacing } from '../../../src/theme/tokens';

export default function SetupOptionList() {
  const params = useLocalSearchParams<{
    field?: string;
    boardType?: string;
    layoutId?: string;
    selected?: string;
    handoffId?: string;
  }>();
  const { t } = useTranslation('boards');
  const router = useRouter();
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();
  const field: SetupOptionField = params.field === 'size' ? 'size' : 'layout';
  const boardName = toBoardName(params.boardType);
  const layoutId = readSetupOptionNumber(params.layoutId);
  const selected = readSetupOptionNumber(params.selected);
  const handoffId = params.handoffId ?? '';

  useLayoutEffect(() => {
    navigation.setOptions({ title: field === 'size' ? t('mobile.custom.size') : t('mobile.custom.layout') });
  }, [navigation, field, t]);

  const rows = useMemo(
    () => (boardName ? setupOptionRows(field, boardName, layoutId) : []),
    [field, boardName, layoutId],
  );

  const unusable = rows.length === 0 || handoffId === '';
  useEffect(() => {
    if (!unusable) return;
    if (router.canGoBack()) router.back();
    else router.replace('/boards/add');
    // Once, at mount: the params cannot change while it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPick = useCallback(
    (value: number) => {
      hapticSelection();
      emitSetupOptionPick(handoffId, { field, value });
      router.back();
    },
    [handoffId, field, router],
  );

  if (unusable) return null;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, { paddingBottom: bottomChrome.scrollBottomPadding }]}
      testID="setup-option-list"
    >
      <View style={styles.gutter}>
        <InsetGroupedList separatorInset="compact">
          {rows.map((row) => (
            <SetupOptionArtRow key={row.value} row={row} selected={row.value === selected} onPick={onPick} />
          ))}
        </InsetGroupedList>
      </View>
    </ScrollView>
  );
}

const SetupOptionArtRow = memo(function SetupOptionArtRow({
  row,
  selected,
  onPick,
}: {
  row: SetupOptionRow;
  selected: boolean;
  onPick: (value: number) => void;
}) {
  const handlePress = useCallback(() => onPick(row.value), [onPick, row.value]);
  const art = useMemo(() => (row.art ? <BoardThumbnail board={row.art} size="compact" /> : null), [row.art]);
  return (
    <ArtRow
      art={art}
      artSize="compact"
      title={row.label}
      titleVariant="body"
      accessory="checkmark"
      selected={selected}
      onPress={handlePress}
      testID={`setup-option-${row.value}`}
    />
  );
});

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[4],
  },
  gutter: {
    paddingHorizontal: spacing[4],
  },
});
