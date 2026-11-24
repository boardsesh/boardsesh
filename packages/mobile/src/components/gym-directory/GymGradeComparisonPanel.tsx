import { memo, useCallback, useState, type ComponentType } from 'react';
import { StyleSheet, View, type FlatListProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useGymGradeCollectionPicker, useGymGradeComparison, type GymGradeRequest } from '@boardsesh/board-react';
import { buildGymGradeComparisonRows, formatGymReportingTime, hasGraphqlErrorCode } from '@boardsesh/graphql';
import type { GymGradeCollectionPage, GymStatsPeriod } from '@boardsesh/shared-schema';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getHttpClient } from '../../lib/graphql/client';
import { requestForGymViewer } from '../../lib/graphql/hooks/use-gym-reporting';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Text } from '../Text';
import { ModalSheet } from '../ModalSheet';
import { BottomSheetFlatList } from '../sheet-presentation';
import { AccessibleBottomSheetTextInput } from '../AccessibleBottomSheetTextInput';

type Collection = GymGradeCollectionPage['collections'][number];
const CollectionList = BottomSheetFlatList as ComponentType<FlatListProps<Collection>>;

const collectionKey = (collection: Collection) => collection.uuid;
const CollectionRow = memo(function CollectionRow({
  collection,
  save,
  disabled,
}: {
  collection: Collection;
  save: (uuid: string | null) => void;
  disabled: boolean;
}) {
  const choose = useCallback(() => save(collection.uuid), [save, collection.uuid]);
  return <Button title={collection.name} variant="outlined" disabled={disabled} onPress={choose} />;
});

function CollectionPicker({
  request,
  viewerId,
  gymUuid,
  overviewGymUuid,
  boardUuid,
  canClear,
  close,
}: {
  request: GymGradeRequest;
  viewerId: string;
  gymUuid: string;
  overviewGymUuid: string;
  boardUuid: string;
  canClear: boolean;
  close: () => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const picker = useGymGradeCollectionPicker({ viewerId, gymUuid, overviewGymUuid, request }, boardUuid);
  const saveSelection = picker.save;
  const choose = useCallback(
    (uuid: string | null) => {
      void saveSelection(uuid).then(close, () => {});
    },
    [saveSelection, close],
  );
  const saving = picker.saving;
  const renderCollection = useCallback(
    ({ item }: { item: Collection }) => <CollectionRow collection={item} save={choose} disabled={saving} />,
    [choose, saving],
  );
  const header = (
    <View style={styles.picker}>
      <Text accessibilityRole="header" variant="title2">
        {t('gymGradeComparison.choose')}
      </Text>
      <AccessibleBottomSheetTextInput
        accessibilityLabel={t('gymGradeComparison.search')}
        placeholder={t('gymGradeComparison.search')}
        placeholderTextColor={systemColors.secondaryLabel}
        style={[styles.search, { color: systemColors.label, borderColor: systemColors.separator }]}
        value={picker.search}
        onChangeText={picker.setSearch}
        onSubmitEditing={picker.searchNow}
        returnKeyType="search"
        maxLength={100}
      />
      <Button variant="outlined" title={t('gymGradeComparison.search')} onPress={picker.searchNow} />
      {picker.state === 'loading' && <ActivityIndicator size="small" />}
      {picker.state === 'offline' && <Text accessibilityRole="alert">{t('gymReporting.offline')}</Text>}
      {(picker.state === 'denied' || picker.state === 'error') && (
        <>
          <Text accessibilityRole="alert">{t('gymGradeComparison.loadError')}</Text>
          <Button variant="outlined" title={t('gymReporting.retry')} onPress={picker.retry} />
        </>
      )}
      {picker.saveError != null && (
        <Text accessibilityRole="alert">
          {hasGraphqlErrorCode(picker.saveError, 'COLLECTION_UNAVAILABLE')
            ? t('gymGradeComparison.incompatible')
            : t('gymGradeComparison.saveError')}
        </Text>
      )}
      {picker.data && picker.data.collections.length === 0 && <Text>{t('gymGradeComparison.noMatches')}</Text>}
      <View style={styles.actions}>
        {picker.canGoBack && (
          <Button variant="outlined" title={t('gymGradeComparison.previous')} onPress={picker.goBack} />
        )}
        {picker.goNext && <Button variant="outlined" title={t('gymGradeComparison.next')} onPress={picker.goNext} />}
        {canClear && (
          <Button
            variant="outlined"
            title={t('gymGradeComparison.clear')}
            disabled={saving || picker.state !== 'ready'}
            onPress={() => choose(null)}
          />
        )}
        <Button variant="outlined" title={t('gymReporting.cancel')} onPress={close} />
      </View>
    </View>
  );
  return (
    <ModalSheet
      visible
      accessibilityLabel={t('gymGradeComparison.choose')}
      onClose={close}
      surfaceSize="list"
      header={header}
    >
      <CollectionList
        data={picker.data?.collections}
        keyExtractor={collectionKey}
        renderItem={renderCollection}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.items}
      />
    </ModalSheet>
  );
}

type PanelProps = {
  viewerId: string;
  gymUuid: string;
  overviewGymUuid: string;
  boardUuid: string | null;
  period: GymStatsPeriod;
};

export function GymGradeComparisonPanel({ viewerId, gymUuid, overviewGymUuid, boardUuid, period }: PanelProps) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const [picker, setPicker] = useState<{ boardUuid: string; canClear: boolean } | null>(null);
  const closePicker = useCallback(() => setPicker(null), []);
  const request: GymGradeRequest = useCallback(
    (document, variables, signal) =>
      requestForGymViewer(viewerId, () => getHttpClient().request({ document, variables, signal })),
    [viewerId],
  );
  const comparison = useGymGradeComparison({ viewerId, gymUuid, overviewGymUuid, request }, boardUuid, period);
  const report = comparison.data;
  const locale = i18n.language || 'en-US';
  const number = new Intl.NumberFormat(locale);
  const statuses = {
    READY: '',
    OWNER_ONLY: t('gymGradeComparison.ownerOnly'),
    WALL_UNAVAILABLE: t('gymGradeComparison.wallUnavailable'),
    CHOOSE_COLLECTION: t('gymGradeComparison.collectionMissing'),
    COLLECTION_UNAVAILABLE: t('gymGradeComparison.collectionUnavailable'),
    COLLECTION_EMPTY: t('gymGradeComparison.collectionEmpty'),
  };
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" variant="title2">
        {t('gymGradeComparison.title')}
      </Text>
      {comparison.state === 'loading' && <ActivityIndicator size="small" />}
      {comparison.state === 'offline' && <Text accessibilityRole="alert">{t('gymReporting.offline')}</Text>}
      {(comparison.state === 'error' || comparison.state === 'denied') && (
        <>
          <Text accessibilityRole="alert">
            {hasGraphqlErrorCode(comparison.error, 'SCOPE_TOO_LARGE')
              ? t('gymGradeComparison.tooLarge')
              : t('gymGradeComparison.loadError')}
          </Text>
          <Button variant="outlined" title={t('gymReporting.retry')} onPress={comparison.retry} />
        </>
      )}
      {report && (
        <>
          <Text variant="subheadline">{t('gymGradeComparison.description')}</Text>
          <Text variant="footnote">
            {t('gymGradeComparison.window', {
              start: formatGymReportingTime(report.startAt, report.timeZone, locale),
              end: formatGymReportingTime(report.asOf, report.timeZone, locale),
            })}
          </Text>
          <Text variant="subheadline">
            {t('gymGradeComparison.availableTotal', { countText: number.format(report.availableCount) })}
          </Text>
          <Text variant="subheadline">
            {t('gymGradeComparison.sendTotal', { countText: number.format(report.sendCount) })}
          </Text>
          {report.availableCount === 0 ? (
            <Text>{t('gymGradeComparison.noInventory')}</Text>
          ) : (
            <View style={styles.section}>
              {report.sendCount === 0 && <Text>{t('gymGradeComparison.noSends')}</Text>}
              {buildGymGradeComparisonRows(report, locale, formatGradeByDifficultyId).map((row) => (
                <View key={row.label ?? 'unknown'} style={styles.details}>
                  <Text accessibilityRole="header" variant="headline">
                    {row.label ?? t('gymGradeComparison.unknown')}
                  </Text>
                  {[
                    {
                      key: 'available',
                      title: t('gymGradeComparison.available'),
                      point: row.available,
                      color: systemColors.accent,
                    },
                    {
                      key: 'sends',
                      title: t('gymGradeComparison.sends'),
                      point: row.sends,
                      color: systemColors.secondaryLabel,
                    },
                  ].map(({ key, title, point, color }) => (
                    <View key={key} style={styles.details}>
                      <Text variant="footnote">
                        {t('gymGradeComparison.point', {
                          series: title,
                          countText: point.countText,
                          share: point.shareText,
                        })}
                      </Text>
                      <View
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={[styles.track, { backgroundColor: systemColors.separator }]}
                      >
                        <View style={[styles.fill, { backgroundColor: color, width: `${point.width * 100}%` }]} />
                      </View>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          )}
          <Text accessibilityRole="header" variant="headline">
            {t('gymGradeComparison.scopes')}
          </Text>
          {report.boards.map((board) => {
            const root = report.boards.find((candidate) => candidate.boardUuid === board.physicalBoardUuid);
            return (
              <View key={board.boardUuid} style={styles.details}>
                <Text variant="headline">
                  {root && root !== board
                    ? t('gymGradeComparison.boardGroup', { board: board.boardName, physical: root.boardName })
                    : board.boardName}
                </Text>
                <Text variant="footnote" color={systemColors.secondaryLabel}>
                  {board.kind === 'SPRAY_WALL' ? t('gymGradeComparison.spray') : t('gymGradeComparison.led')}
                  {board.collectionName ? ` · ${board.collectionName}` : ''}
                </Text>
                <Text variant="subheadline">
                  {board.included
                    ? t('gymGradeComparison.included', { countText: number.format(board.variantCount) })
                    : statuses[board.status]}
                </Text>
                {board.kind === 'LED_COLLECTION' && (
                  <Button
                    variant="outlined"
                    title={
                      board.status === 'CHOOSE_COLLECTION'
                        ? t('gymGradeComparison.choose')
                        : t('gymGradeComparison.change')
                    }
                    onPress={() =>
                      setPicker({ boardUuid: board.boardUuid, canClear: board.status !== 'CHOOSE_COLLECTION' })
                    }
                  />
                )}
              </View>
            );
          })}
        </>
      )}
      {picker && comparison.state !== 'denied' && comparison.state !== 'offline' && (
        <CollectionPicker
          key={picker.boardUuid}
          request={request}
          viewerId={viewerId}
          gymUuid={gymUuid}
          overviewGymUuid={overviewGymUuid}
          boardUuid={picker.boardUuid}
          canClear={picker.canClear}
          close={closePicker}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[3] },
  details: { gap: spacing[1] },
  track: { height: 6, borderRadius: borderRadius.sm, overflow: 'hidden' },
  fill: { height: '100%' },
  picker: { padding: spacing[4], gap: spacing[3] },
  search: { borderWidth: StyleSheet.hairlineWidth, borderRadius: borderRadius.sm, padding: spacing[3] },
  items: { gap: spacing[2], padding: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
