'use client';

import React, { useState, useCallback, useRef } from 'react';
import Papa from 'papaparse';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Chip from '@mui/material/Chip';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  IMPORT_TICKS_BATCH,
  ImportTicksBatchInput,
  ImportTicksBatchResult,
  ImportTickRow,
} from '@/app/lib/graphql/operations/imports';
import styles from './csv-import-section.module.css';

type BoardType = 'kilter' | 'tension';

interface CsvRow {
  board: string;
  angle: number;
  climb_name: string;
  date: string;
  logged_grade: string;
  displayed_grade: string;
  is_benchmark: boolean;
  tries: number;
  is_mirror: boolean;
  is_ascent: boolean;
  comment: string;
  sessions_count: number;
  tries_total: number;
  is_repeat: boolean;
  climb_uuid: string | null;
}

interface ImportResults {
  imported: number;
  skipped: number;
  duplicates: number;
  errors: string[];
}

function parseBool(value: string): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function parseIntSafe(value: string): number {
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

function parseRawRow(raw: Record<string, string>): CsvRow {
  return {
    board: raw.board ?? '',
    angle: parseIntSafe(raw.angle),
    climb_name: raw.climb_name ?? '',
    date: raw.date ?? '',
    logged_grade: raw.logged_grade ?? '',
    displayed_grade: raw.displayed_grade ?? '',
    is_benchmark: parseBool(raw.is_benchmark),
    tries: parseIntSafe(raw.tries),
    is_mirror: parseBool(raw.is_mirror),
    is_ascent: parseBool(raw.is_ascent),
    comment: raw.comment ?? '',
    sessions_count: parseIntSafe(raw.sessions_count),
    tries_total: parseIntSafe(raw.tries_total),
    is_repeat: parseBool(raw.is_repeat),
    climb_uuid: raw.climb_uuid?.trim() || null,
  };
}

const PREVIEW_LIMIT = 20;

const BATCH_SIZE = 50;

export default function CsvImportSection() {
  const { showMessage } = useSnackbar();
  const { token: authToken } = useWsAuthToken();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [boardType, setBoardType] = useState<BoardType>('kilter');
  const [parsedRows, setParsedRows] = useState<CsvRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [importResults, setImportResults] = useState<ImportResults | null>(null);

  const totalRows = parsedRows.length;
  const ascents = parsedRows.filter((r) => r.is_ascent).length;
  const attempts = totalRows - ascents;

  const previewRows = [...parsedRows]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, PREVIEW_LIMIT);

  const handleBoardTypeChange = useCallback(
    (_: React.MouseEvent<HTMLElement>, value: BoardType | null) => {
      if (value) setBoardType(value);
    },
    [],
  );

  const handleFileSelect = useCallback((file: File) => {
    setParseError(null);
    setImportResults(null);
    setFileName(file.name);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          const errorMessages = results.errors
            .slice(0, 3)
            .map((e) => e.message)
            .join('; ');
          setParseError(`CSV parsing errors: ${errorMessages}`);
          setParsedRows([]);
          return;
        }

        if (!results.data.length) {
          setParseError('CSV file contains no data rows.');
          setParsedRows([]);
          return;
        }

        const requiredColumns = ['climb_name', 'date', 'is_ascent', 'tries'];
        const headers = Object.keys(results.data[0]);
        const missing = requiredColumns.filter((col) => !headers.includes(col));
        if (missing.length > 0) {
          setParseError(
            `CSV is missing required columns: ${missing.join(', ')}. Is this a BoardLib export?`,
          );
          setParsedRows([]);
          return;
        }

        try {
          const rows = results.data.map(parseRawRow);
          setParsedRows(rows);
        } catch {
          setParseError('Failed to parse CSV rows. Check that the file format is correct.');
          setParsedRows([]);
        }
      },
      error: (error: Error) => {
        setParseError(`Failed to read file: ${error.message}`);
        setParsedRows([]);
      },
    });
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) {
        if (!file.name.endsWith('.csv')) {
          setParseError('Please drop a .csv file.');
          return;
        }
        handleFileSelect(file);
      }
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImport = useCallback(async () => {
    if (!parsedRows.length || !authToken) return;

    setImporting(true);
    setImportProgress(0);

    const client = createGraphQLHttpClient(authToken);

    // Convert parsed CSV rows to GraphQL input format
    const importRows: ImportTickRow[] = parsedRows.map((row) => ({
      climbUuid: row.climb_uuid || null,
      climbName: row.climb_name,
      angle: row.angle,
      date: row.date,
      loggedGrade: row.logged_grade || null,
      displayedGrade: row.displayed_grade || null,
      isBenchmark: row.is_benchmark,
      tries: row.tries,
      isMirror: row.is_mirror,
      isAscent: row.is_ascent,
      comment: row.comment || null,
    }));

    const numBatches = Math.ceil(importRows.length / BATCH_SIZE);
    setTotalBatches(numBatches);
    let totalImported = 0;
    let totalSkipped = 0;
    let totalDuplicates = 0;
    const allErrors: string[] = [];

    try {
      for (let i = 0; i < numBatches; i++) {
        setCurrentBatch(i + 1);
        const batch = importRows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const isLastBatch = i === numBatches - 1;

        const variables: { input: ImportTicksBatchInput } = {
          input: {
            boardType,
            rows: batch,
            buildSessions: isLastBatch,
          },
        };

        const result = await client.request<ImportTicksBatchResult>(
          IMPORT_TICKS_BATCH,
          variables,
        );

        const batchResult = result.importTicksBatch;
        totalImported += batchResult.imported;
        totalSkipped += batchResult.skipped;
        totalDuplicates += batchResult.duplicates;
        // Offset error row numbers for this batch
        const batchOffset = i * BATCH_SIZE;
        allErrors.push(
          ...batchResult.errors.map((err) => {
            // Adjust row numbers: "Row 5: ..." -> "Row 255: ..."
            return err.replace(/^Row (\d+):/, (_, num) => `Row ${parseInt(num) + batchOffset}:`);
          }),
        );

        setImportProgress(Math.round(((i + 1) / numBatches) * 100));
      }

      setImportResults({
        imported: totalImported,
        skipped: totalSkipped,
        duplicates: totalDuplicates,
        errors: allErrors,
      });

      const errorCount = allErrors.length;
      showMessage(
        `Import complete: ${totalImported} imported, ${totalDuplicates} duplicates, ${totalSkipped} skipped` +
          (errorCount > 0 ? `, ${errorCount} errors` : ''),
        errorCount > 0 ? 'warning' : 'success',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Import failed';
      showMessage(message, 'error');
    } finally {
      setImporting(false);
      setCurrentBatch(0);
      setTotalBatches(0);
    }
  }, [parsedRows, boardType, authToken, showMessage]);

  const handleReset = useCallback(() => {
    setParsedRows([]);
    setParseError(null);
    setFileName(null);
    setImportResults(null);
    setImportProgress(0);
    setCurrentBatch(0);
    setTotalBatches(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Import Logbook from CSV
        </Typography>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Import your climbing logbook from a BoardLib CSV export. If you had a Kilter account and
          exported your data before the Aurora app shut down, you can import it here. Also works for
          Tension CSV exports.
        </Typography>

        {/* Board Type Selector */}
        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Board Type
          </Typography>
          <ToggleButtonGroup
            value={boardType}
            exclusive
            onChange={handleBoardTypeChange}
            size="small"
          >
            <ToggleButton value="kilter">Kilter</ToggleButton>
            <ToggleButton value="tension">Tension</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        {/* File Upload */}
        {!importResults && (
          <Box sx={{ mb: 3 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileInputChange}
              hidden
            />
            <div
              className={styles.dropZone}
              onClick={handleDropZoneClick}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleDropZoneClick();
              }}
            >
              <UploadFileOutlined sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
              <Typography variant="body1" color="text.secondary">
                {fileName ? fileName : 'Drop a CSV file here or click to select'}
              </Typography>
              {fileName && parsedRows.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  {totalRows} rows parsed
                </Typography>
              )}
            </div>
          </Box>
        )}

        {/* Parse Error */}
        {parseError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            <AlertTitle>CSV Error</AlertTitle>
            {parseError}
          </Alert>
        )}

        {/* Summary Stats */}
        {parsedRows.length > 0 && !importResults && (
          <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
            <Chip label={`${totalRows} total entries`} variant="outlined" />
            <Chip
              label={`${ascents} ascents`}
              color="success"
              variant="outlined"
              icon={<CheckCircleOutlined />}
            />
            <Chip
              label={`${attempts} attempts`}
              color="warning"
              variant="outlined"
              icon={<WarningAmberOutlined />}
            />
          </Stack>
        )}

        {/* Preview Table */}
        {parsedRows.length > 0 && !importResults && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Preview {totalRows > PREVIEW_LIMIT ? `(showing ${PREVIEW_LIMIT} of ${totalRows})` : `(${totalRows} rows)`}
            </Typography>
            <TableContainer className={styles.previewContainer}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Climb Name</TableCell>
                    <TableCell>Grade</TableCell>
                    <TableCell>Tries</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {previewRows.map((row, idx) => (
                    <TableRow key={`${row.date}-${row.climb_name}-${idx}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {row.date}
                      </TableCell>
                      <TableCell>{row.climb_name}</TableCell>
                      <TableCell>{row.displayed_grade || row.logged_grade}</TableCell>
                      <TableCell>{row.tries}</TableCell>
                      <TableCell>
                        {row.is_ascent ? (
                          <Chip label="Ascent" color="success" size="small" />
                        ) : (
                          <Chip label="Attempt" color="warning" size="small" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Import Progress */}
        {importing && (
          <Box sx={{ mb: 3 }}>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">
                {totalBatches > 1
                  ? `Importing batch ${currentBatch} of ${totalBatches}...`
                  : 'Importing entries...'}
              </Typography>
            </Stack>
            <LinearProgress variant="determinate" value={importProgress} />
          </Box>
        )}

        {/* Import Results */}
        {importResults && (
          <Alert
            severity={importResults.errors.length > 0 ? 'warning' : 'success'}
            sx={{ mb: 3 }}
            icon={importResults.errors.length > 0 ? <WarningAmberOutlined /> : <CheckCircleOutlined />}
          >
            <AlertTitle>Import Complete</AlertTitle>
            <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
              <Chip
                label={`${importResults.imported} imported`}
                color="success"
                size="small"
              />
              {importResults.duplicates > 0 && (
                <Chip
                  label={`${importResults.duplicates} duplicates`}
                  variant="outlined"
                  size="small"
                />
              )}
              {importResults.skipped > 0 && (
                <Chip
                  label={`${importResults.skipped} skipped`}
                  variant="outlined"
                  size="small"
                />
              )}
              {importResults.errors.length > 0 && (
                <Chip
                  label={`${importResults.errors.length} errors`}
                  color="error"
                  size="small"
                />
              )}
            </Stack>
            {importResults.errors.length > 0 && (
              <Box sx={{ mt: 2, maxHeight: 150, overflow: 'auto' }}>
                {importResults.errors.slice(0, 10).map((err, i) => (
                  <Typography key={i} variant="caption" color="text.secondary" display="block">
                    {err}
                  </Typography>
                ))}
                {importResults.errors.length > 10 && (
                  <Typography variant="caption" color="text.secondary">
                    ...and {importResults.errors.length - 10} more
                  </Typography>
                )}
              </Box>
            )}
          </Alert>
        )}

        {/* Action Buttons */}
        <Stack direction="row" spacing={2}>
          {parsedRows.length > 0 && !importResults && (
            <Button
              variant="contained"
              onClick={handleImport}
              disabled={importing || !authToken}
            >
              Import {totalRows} entries
            </Button>
          )}
          {(parsedRows.length > 0 || importResults) && (
            <Button variant="outlined" onClick={handleReset} disabled={importing}>
              Reset
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
