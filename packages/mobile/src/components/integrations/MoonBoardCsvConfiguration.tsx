import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MOONBOARD_LAYOUTS } from '@boardsesh/board-config';
import {
  inspectMoonBoardExportCsv,
  parseMoonBoardCollectionCsv,
  parseMoonBoardExportCsv,
  type MoonBoardColumnIndexes,
  type MoonBoardExportColumn,
  type MoonBoardCsvParseOptions,
  type ParsedMoonBoardExportResult,
} from '@boardsesh/shared-schema/moonboard-import';
import type { MoonBoardCollectionPreview, MoonBoardCollectionImportResult } from '@boardsesh/shared-schema';
import { AppMenu } from '../AppMenu';
import { AccessibleBottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { SheetTopBar } from '../SheetTopBar';
import { ModalSheet } from '../ModalSheet';
import { useTheme } from '../../providers/theme-provider';
import { invalidateOwnDataAfterImport } from '../../lib/integrations/board-import-completion';
import {
  importMoonBoardCollection,
  previewMoonBoardCollection,
  getMoonBoardCollectionDestinations,
} from '../../lib/integrations/moonboard-collection';
import { spacing } from '../../theme/tokens';

type Props = {
  csv: string;
  initialOptions?: MoonBoardCsvParseOptions;
  onParsed: (parsed: ParsedMoonBoardExportResult, options: MoonBoardCsvParseOptions) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
};

const LAYOUTS = Object.values(MOONBOARD_LAYOUTS);
const LOG_FIELDS: MoonBoardExportColumn[] = [
  'problemId',
  'name',
  'grade',
  'tries',
  'date',
  'setter',
  'attempts',
  'rating',
  'setup',
  'configuration',
  'benchmark',
  'comment',
];
const COLLECTION_FIELDS: MoonBoardExportColumn[] = ['name', 'grade', 'setter', 'active', 'deleted'];

/** A form inside the import sheet; it never opens another sheet. */
export function MoonBoardCsvConfiguration({ csv, initialOptions, onParsed, onClose, onBusyChange }: Props) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const queryClient = useQueryClient();
  const initial = useMemo(() => inspectMoonBoardExportCsv(csv, initialOptions?.headerRowIndex), [csv, initialOptions]);
  const [mode, setMode] = useState<'logbook' | 'collection'>(initial.kind === 'collection' ? 'collection' : 'logbook');
  const [headerRow, setHeaderRow] = useState(String(initial.headerRowIndex + 1));
  const [columns, setColumns] = useState<MoonBoardColumnIndexes>(initialOptions?.columns ?? initial.columns);
  const [layoutId, setLayoutId] = useState<number | null>(null);
  const [angle, setAngle] = useState(40);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [confirmedClimbs, setConfirmedClimbs] = useState(false);
  const [playlistName, setPlaylistName] = useState(t('aurora.moonboard.recovery.defaultPlaylistName'));
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [playlistUuid] = useState(randomUUID);
  const [preview, setPreview] = useState<MoonBoardCollectionPreview | null>(null);
  const [result, setResult] = useState<MoonBoardCollectionImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const inspection = useMemo(() => {
    try {
      return inspectMoonBoardExportCsv(csv, Number(headerRow) - 1);
    } catch {
      return null;
    }
  }, [csv, headerRow]);
  const options = useMemo(() => ({ headerRowIndex: Number(headerRow) - 1, columns }), [headerRow, columns]);
  const collection = useMemo(() => {
    if (mode !== 'collection') return null;
    try {
      return { parsed: parseMoonBoardCollectionCsv(csv, options, includeInactive), error: null };
    } catch (cause) {
      return { parsed: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [csv, options, includeInactive, mode]);
  const logbook = useMemo(() => {
    if (mode !== 'logbook') return null;
    try {
      return { parsed: parseMoonBoardExportCsv(csv, options), error: null };
    } catch (cause) {
      return { parsed: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [csv, options, mode]);

  const playlistQuery = useQuery({
    queryKey: ['moonBoardImportDestinations', layoutId],
    enabled: mode === 'collection' && layoutId != null,
    queryFn: () => getMoonBoardCollectionDestinations(layoutId!),
  });
  const destinations = Array.isArray(playlistQuery.data) ? playlistQuery.data : [];
  const destination = destinations.find((playlist) => playlist.id === destinationId);
  const fieldLabels: Record<MoonBoardExportColumn, string> = {
    problemId: t('aurora.moonboard.recovery.fields.problemId'),
    name: t('aurora.moonboard.recovery.fields.name'),
    grade: t('aurora.moonboard.recovery.fields.grade'),
    tries: t('aurora.moonboard.recovery.fields.tries'),
    date: t('aurora.moonboard.recovery.fields.date'),
    setter: t('aurora.moonboard.recovery.fields.setter'),
    attempts: t('aurora.moonboard.recovery.fields.attempts'),
    rating: t('aurora.moonboard.recovery.fields.rating'),
    setup: t('aurora.moonboard.recovery.fields.setup'),
    configuration: t('aurora.moonboard.recovery.fields.configuration'),
    benchmark: t('aurora.moonboard.recovery.fields.benchmark'),
    comment: t('aurora.moonboard.recovery.fields.comment'),
    active: t('aurora.moonboard.recovery.fields.active'),
    deleted: t('aurora.moonboard.recovery.fields.deleted'),
  };
  const resetPreview = useCallback(() => {
    setPreview(null);
    setError(null);
    setCopied(false);
  }, []);
  const changeColumn = useCallback(
    (field: MoonBoardExportColumn, index: number | undefined) => {
      resetPreview();
      setColumns((previous) => {
        const next = { ...previous };
        if (index == null) delete next[field];
        else next[field] = index;
        return next;
      });
    },
    [resetPreview],
  );
  const updateBusy = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
    onBusyChange(next);
  };
  const handlePreview = async () => {
    if (busyRef.current) return;
    if (mode === 'logbook') {
      if (logbook?.parsed) onParsed(logbook.parsed, options);
      return;
    }
    if (layoutId == null || !collection?.parsed || !confirmedClimbs) return;
    updateBusy(true);
    setError(null);
    try {
      const matched = await previewMoonBoardCollection({ layoutId, angle, rows: collection.parsed.rows });
      if (alive.current) setPreview(matched);
    } catch {
      if (alive.current) setError(t('aurora.moonboard.recovery.failed'));
    } finally {
      if (alive.current) updateBusy(false);
    }
  };
  const handleImport = async () => {
    if (busyRef.current || layoutId == null || !collection?.parsed || !preview?.matched) return;
    if (destinationId != null && !destination) return;
    updateBusy(true);
    setError(null);
    try {
      const imported = await importMoonBoardCollection({
        layoutId,
        angle,
        rows: collection.parsed.rows,
        playlistUuid: destination?.uuid ?? playlistUuid,
        playlistName: destination?.name ?? playlistName.trim(),
        ...(destination ? { playlistId: destination.id } : {}),
      });
      invalidateOwnDataAfterImport(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['moonBoardImportDestinations'] });
      void queryClient.invalidateQueries({ queryKey: ['playlist', imported.playlistUuid] });
      if (alive.current) {
        setResult(imported);
        setPreview(imported.preview);
      }
    } catch {
      if (alive.current) setError(t('aurora.moonboard.recovery.failed'));
    } finally {
      if (alive.current) updateBusy(false);
    }
  };
  const unresolved = preview?.rows.filter((row) => row.status === 'missing' || row.status === 'ambiguous') ?? [];
  const copyUnresolved = async () => {
    try {
      await Clipboard.setStringAsync(unresolved.map((row) => `${row.name} (${row.grade})`).join('\n'));
      if (alive.current) setCopied(true);
    } catch {
      if (alive.current) setError(t('aurora.moonboard.recovery.failed'));
    }
  };
  const validationError = mode === 'logbook' ? logbook?.error : collection?.error;
  const validationMessage = (() => {
    if (!validationError) return null;
    if (validationError === 'invalid_header_row') return t('aurora.moonboard.recovery.invalidHeaderRow');
    if (validationError === 'missing_moonboard_log_header') return t('aurora.moonboard.recovery.missingColumns');
    const columnError = validationError.match(/^(missing|invalid|duplicate)_(\w+)_column$/);
    const rowError = validationError.match(/^(?:missing|invalid)_(\w+)_line_(\d+)$/);
    const fieldKey = (columnError?.[2] ?? rowError?.[1] ?? '')
      .replace('problem_id', 'problemId')
      .replace(/^angle$/, 'configuration');
    const field = fieldLabels[fieldKey as MoonBoardExportColumn] ?? fieldLabels.name;
    if (columnError?.[1] === 'missing') return t('aurora.moonboard.recovery.missingField', { field });
    if (columnError?.[1] === 'duplicate') return t('aurora.moonboard.recovery.duplicateColumn', { field });
    if (columnError) return t('aurora.moonboard.recovery.invalidField', { field });
    if (rowError) return t('aurora.moonboard.recovery.invalidRow', { field, line: rowError[2] });
    const triesError = validationError.match(/^unsupported_tries_line_(\d+)$/);
    if (triesError) return t('aurora.moonboard.recovery.unsupportedTries', { line: triesError[1] });
    return t('aurora.moonboard.recovery.mappingRequired');
  })();
  const tooMany = (collection?.parsed?.rows.length ?? 0) > 1000;
  const noRows = mode === 'logbook' ? !logbook?.parsed?.data.logs.length : !collection?.parsed?.rows.length;

  if (initial.kind === 'profile')
    return (
      <ModalSheet
        visible
        onClose={onClose}
        scrollable
        header={
          <SheetTopBar title={t('aurora.moonboard.recovery.title')} leading={{ kind: 'close', onPress: onClose }} />
        }
      >
        <View style={styles.form}>
          <Text>{t('aurora.moonboard.recovery.profileUnsupported')}</Text>
          <Text>{t('aurora.moonboard.recovery.chooseLogbook')}</Text>
        </View>
      </ModalSheet>
    );

  return (
    <ModalSheet
      visible
      onClose={onClose}
      enablePanDownToClose={!busy}
      scrollable
      header={
        <SheetTopBar
          title={t('aurora.moonboard.recovery.title')}
          leading={{ kind: 'cancel', onPress: onClose, disabled: busy }}
          trailing={
            result
              ? { label: tCommon('actions.done'), onPress: onClose }
              : preview
                ? {
                    label: t('aurora.moonboard.recovery.importMatched', { count: preview.matched }),
                    onPress: () => {
                      void handleImport();
                    },
                    loading: busy,
                    disabled: !preview.matched || (!destination && (!playlistName.trim() || destinationId != null)),
                  }
                : {
                    label: t('aurora.moonboard.recovery.previewMatches'),
                    onPress: () => {
                      void handlePreview();
                    },
                    loading: busy,
                    disabled:
                      Boolean(validationError) ||
                      noRows ||
                      tooMany ||
                      (mode === 'collection' && (layoutId == null || !confirmedClimbs)),
                  }
          }
        />
      }
    >
      <View style={styles.form}>
        {error ? <Text color={brandColors.error}>{error}</Text> : null}
        {result ? <Text>{t('aurora.moonboard.recovery.collectionComplete', { count: result.imported })}</Text> : null}
        {busy ? <ActivityIndicator /> : null}
        {!preview && !result ? (
          <>
            <AppMenu
              label={
                mode === 'logbook' ? t('aurora.moonboard.recovery.logbook') : t('aurora.moonboard.recovery.collection')
              }
              actions={[
                { label: t('aurora.moonboard.recovery.logbook'), selected: mode === 'logbook', disabled: busy },
                { label: t('aurora.moonboard.recovery.collection'), selected: mode === 'collection', disabled: busy },
              ]}
              onSelectIndex={(index) => {
                setMode(index === 0 ? 'logbook' : 'collection');
                resetPreview();
              }}
            />
            <Text>{t('aurora.moonboard.recovery.headerRow')}</Text>
            <AccessibleBottomSheetTextInput
              accessibilityLabel={t('aurora.moonboard.recovery.headerRow')}
              keyboardType="number-pad"
              value={headerRow}
              editable={!busy}
              onChangeText={(next) => {
                setHeaderRow(next);
                resetPreview();
                try {
                  setColumns(inspectMoonBoardExportCsv(csv, Number(next) - 1).columns);
                } catch {
                  setColumns({});
                }
              }}
            />
            {(mode === 'logbook' ? LOG_FIELDS : COLLECTION_FIELDS).map((field) => (
              <ColumnMapping
                key={field}
                field={field}
                label={fieldLabels[field]}
                headers={inspection?.headers ?? []}
                selectedIndex={columns[field]}
                disabled={busy}
                onChange={changeColumn}
              />
            ))}
            {validationMessage ? (
              <Text color={brandColors.error}>{validationMessage}</Text>
            ) : noRows ? (
              <Text>{t('aurora.moonboard.recovery.noRows')}</Text>
            ) : null}
            <Text variant="headline">{t('aurora.moonboard.recovery.sampleRows')}</Text>
            {/* Five bounded samples; the complete export is never rendered as a list. */}
            {inspection?.sampleRows.map((row, index) => (
              <Text key={index} variant="footnote" numberOfLines={3}>
                {row.join(' · ')}
              </Text>
            ))}
            {mode === 'collection' ? (
              <>
                <Text>{t('aurora.moonboard.recovery.collectionExplain')}</Text>
                <SwitchRow
                  label={t('aurora.moonboard.recovery.confirmClimbRows')}
                  value={confirmedClimbs}
                  disabled={busy}
                  onValueChange={setConfirmedClimbs}
                />
                <AppMenu
                  label={
                    LAYOUTS.find((layout) => layout.id === layoutId)?.name ?? t('aurora.moonboard.recovery.layout')
                  }
                  accessibilityLabel={t('aurora.moonboard.recovery.layout')}
                  actions={LAYOUTS.map((layout) => ({
                    label: layout.name,
                    selected: layoutId === layout.id,
                    disabled: busy,
                  }))}
                  onSelectIndex={(index) => {
                    setLayoutId(LAYOUTS[index].id);
                    setDestinationId(null);
                    if (LAYOUTS[index].id === 1 || LAYOUTS[index].id >= 6) setAngle(40);
                    resetPreview();
                  }}
                />
                <AppMenu
                  label={`${angle}°`}
                  accessibilityLabel={t('aurora.moonboard.recovery.angle')}
                  actions={[25, 40].map((degrees) => ({
                    label: `${degrees}°`,
                    selected: angle === degrees,
                    disabled: busy || (degrees === 25 && (layoutId === 1 || (layoutId != null && layoutId >= 6))),
                  }))}
                  onSelectIndex={(index) => {
                    setAngle(index === 0 ? 25 : 40);
                    resetPreview();
                  }}
                />
                <SwitchRow
                  label={t('aurora.moonboard.recovery.includeInactive')}
                  value={includeInactive}
                  disabled={busy}
                  onValueChange={(next) => {
                    setIncludeInactive(next);
                    resetPreview();
                  }}
                />
                <Text>{t('aurora.moonboard.recovery.excludedRows', { count: collection?.parsed?.excluded ?? 0 })}</Text>
                {tooMany ? <Text color={brandColors.error}>{t('aurora.moonboard.recovery.tooManyRows')}</Text> : null}
              </>
            ) : null}
          </>
        ) : null}
        {preview ? (
          <>
            <Text>{t('aurora.moonboard.recovery.matched', { count: preview.matched })}</Text>
            <Text>{t('aurora.moonboard.recovery.missing', { count: preview.missing })}</Text>
            <Text>{t('aurora.moonboard.recovery.ambiguous', { count: preview.ambiguous })}</Text>
            <Text>{t('aurora.moonboard.recovery.duplicates', { count: preview.duplicates })}</Text>
            <Text color={systemColors.secondaryLabel}>{t('aurora.moonboard.recovery.missingNote')}</Text>
            {preview.rows.slice(0, 5).map((row) => (
              <MatchSample key={row.lineNumber} name={row.name} grade={row.grade} status={row.status} />
            ))}
            {preview.matched === 0 ? <Text>{t('aurora.moonboard.recovery.noMatches')}</Text> : null}
            {unresolved.length ? (
              <Button
                title={copied ? t('aurora.moonboard.recovery.copied') : t('aurora.moonboard.recovery.copyUnresolved')}
                variant="text"
                onPress={() => {
                  void copyUnresolved();
                }}
              />
            ) : null}
            {!result ? (
              <>
                <Text>{t('aurora.moonboard.recovery.destination')}</Text>
                <AppMenu
                  label={destination?.name ?? t('aurora.moonboard.recovery.newPlaylist')}
                  actions={[
                    {
                      label: t('aurora.moonboard.recovery.newPlaylist'),
                      selected: destinationId == null,
                      disabled: busy,
                    },
                    ...destinations.map((playlist) => ({
                      label: playlist.name,
                      selected: playlist.id === destinationId,
                      disabled: busy,
                    })),
                  ]}
                  onSelectIndex={(index) => setDestinationId(index === 0 ? null : destinations[index - 1].id)}
                />
                {destinationId == null ? (
                  <AccessibleBottomSheetTextInput
                    accessibilityLabel={t('aurora.moonboard.recovery.playlistName')}
                    placeholder={t('aurora.moonboard.recovery.playlistName')}
                    value={playlistName}
                    onChangeText={setPlaylistName}
                    maxLength={100}
                    editable={!busy}
                  />
                ) : null}
                {playlistQuery.isError ? (
                  <Text color={brandColors.error}>{t('aurora.moonboard.recovery.failed')}</Text>
                ) : null}
                <Button
                  title={t('aurora.moonboard.recovery.editColumns')}
                  variant="text"
                  disabled={busy}
                  onPress={resetPreview}
                />
              </>
            ) : null}
          </>
        ) : null}
      </View>
    </ModalSheet>
  );
}

const ColumnMapping = memo(function ColumnMapping({
  field,
  label,
  headers,
  selectedIndex,
  disabled,
  onChange,
}: {
  field: MoonBoardExportColumn;
  label: string;
  headers: string[];
  selectedIndex: number | undefined;
  disabled: boolean;
  onChange: (field: MoonBoardExportColumn, index: number | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const actions = useMemo(
    () => [
      { label: t('aurora.moonboard.recovery.unmapped'), selected: selectedIndex == null, disabled },
      ...headers.map((header, index) => ({
        label: `${index + 1}. ${header}`,
        selected: index === selectedIndex,
        disabled,
      })),
    ],
    [headers, selectedIndex, disabled, t],
  );
  return (
    <View>
      <Text variant="footnote">{label}</Text>
      <AppMenu
        accessibilityLabel={label}
        label={
          selectedIndex == null
            ? t('aurora.moonboard.recovery.unmapped')
            : `${selectedIndex + 1}. ${headers[selectedIndex] ?? ''}`
        }
        actions={actions}
        onSelectIndex={(index) => onChange(field, index === 0 ? undefined : index - 1)}
      />
    </View>
  );
});

const MatchSample = memo(function MatchSample({
  name,
  grade,
  status,
}: {
  name: string;
  grade: string;
  status: string;
}) {
  const { t } = useTranslation('settings');
  const labels: Record<string, string> = {
    matched: t('aurora.moonboard.recovery.status.matched'),
    missing: t('aurora.moonboard.recovery.status.missing'),
    ambiguous: t('aurora.moonboard.recovery.status.ambiguous'),
    duplicate: t('aurora.moonboard.recovery.status.duplicate'),
  };
  return <Text variant="footnote">{`${name} (${grade}) · ${labels[status] ?? status}`}</Text>;
});

const styles = StyleSheet.create({ form: { padding: spacing[4], gap: spacing[4] } });
