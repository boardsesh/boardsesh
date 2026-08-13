'use client';

import React, { useReducer, useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import LinearProgress from '@mui/material/LinearProgress';
import MuiCheckbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { ResultPage } from '@/app/components/ui/result-page';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { InboxOutlined, SaveOutlined, ClearOutlined, ArrowBackOutlined, LoginOutlined } from '@mui/icons-material';
import { usePathname } from 'next/navigation';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useSession } from 'next-auth/react';
import { parseMultipleScreenshots, deduplicateClimbs, type MoonBoardClimb } from '@boardsesh/moonboard-ocr/browser';
import type { MoonBoardClimbDuplicateMatch } from '@boardsesh/shared-schema';
import MoonBoardImportCard from './moonboard-import-card';
import MoonBoardEditModal from './moonboard-edit-modal';
import { convertOcrHoldsToMap } from '@/app/lib/moonboard-climbs-db';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { uploadOcrTestDataBatch } from '@/app/lib/moonboard-ocr-upload';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY,
  type CheckMoonBoardClimbDuplicatesResponse,
  type CheckMoonBoardClimbDuplicatesVariables,
  SAVE_MOONBOARD_CLIMB_MUTATION,
  type SaveMoonBoardClimbMutationVariables,
  type SaveMoonBoardClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { refreshClimbSearchAfterSave } from '@/app/lib/climb-search-cache';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './moonboard-bulk-import.module.css';

type MoonBoardBulkImportProps = {
  layoutFolder: string;
  layoutName: string;
  layoutId: number;
  holdSetImages: string[];
  angle: number;
};

type ImportWarning = { name: string; error: string };
type DuplicateMatchMap = Record<string, MoonBoardClimbDuplicateMatch>;

// State and action types for the reducer
type ImportState = {
  status: 'idle' | 'processing' | 'complete';
  progress: { current: number; total: number; name: string };
  climbs: MoonBoardClimb[];
  errors: ImportWarning[];
  editingClimb: MoonBoardClimb | null;
};

type ImportAction =
  | { type: 'START_PROCESSING'; total: number }
  | { type: 'UPDATE_PROGRESS'; current: number; total: number; name: string }
  | { type: 'COMPLETE'; climbs: MoonBoardClimb[]; errors: ImportWarning[] }
  | { type: 'REMOVE_CLIMB'; sourceFile: string }
  | { type: 'UPDATE_CLIMB'; sourceFile: string; climb: MoonBoardClimb }
  | { type: 'OPEN_EDIT'; climb: MoonBoardClimb }
  | { type: 'CLOSE_EDIT' }
  | { type: 'RESET' };

const initialState: ImportState = {
  status: 'idle',
  progress: { current: 0, total: 0, name: '' },
  climbs: [],
  errors: [],
  editingClimb: null,
};

const warningAlertSx = {
  borderRadius: 0,
  bgcolor: themeTokens.colors.amber,
  color: themeTokens.neutral[900],
  '& .MuiAlert-icon': {
    color: themeTokens.neutral[900],
  },
  '& .MuiAlert-message': {
    color: themeTokens.neutral[900],
  },
  '& .MuiAlertTitle-root': {
    color: themeTokens.neutral[900],
    fontWeight: 700,
  },
  '& strong': {
    color: themeTokens.neutral[900],
  },
} as const;

function importReducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case 'START_PROCESSING':
      return {
        ...state,
        status: 'processing',
        progress: { current: 0, total: action.total, name: '' },
        climbs: [],
        errors: [],
      };
    case 'UPDATE_PROGRESS':
      return {
        ...state,
        progress: { current: action.current, total: action.total, name: action.name },
      };
    case 'COMPLETE':
      return {
        ...state,
        status: 'complete',
        climbs: action.climbs,
        errors: action.errors,
      };
    case 'REMOVE_CLIMB':
      return {
        ...state,
        climbs: state.climbs.filter((c) => c.sourceFile !== action.sourceFile),
      };
    case 'UPDATE_CLIMB':
      return {
        ...state,
        climbs: state.climbs.map((c) => (c.sourceFile === action.sourceFile ? action.climb : c)),
        editingClimb: null,
      };
    case 'OPEN_EDIT':
      return {
        ...state,
        editingClimb: action.climb,
      };
    case 'CLOSE_EDIT':
      return {
        ...state,
        editingClimb: null,
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

export default function MoonBoardBulkImport({
  layoutFolder,
  layoutName,
  layoutId,
  holdSetImages,
  angle,
}: MoonBoardBulkImportProps) {
  const { t } = useTranslation('climbs');
  const router = useLocaleRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(importReducer, initialState);
  const [isSaving, setIsSaving] = useState(false);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatchMap>({});
  const [contributeImages, setContributeImages] = useState(true);
  const { showMessage } = useSnackbar();

  // Store original files for OCR test data upload
  const filesMapRef = useRef<Map<string, File>>(new Map());
  const duplicateCheckRequestIdRef = useRef(0);

  // File input ref for the drop zone
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Backend URL and auth token for OCR upload
  const backendUrl = getBackendWsUrl();
  const { token: authToken } = useWsAuthToken();
  const listUrl = pathname.replace(/\/import$/, '/list');

  const runDuplicateCheck = useCallback(
    async (climbs: MoonBoardClimb[]): Promise<DuplicateMatchMap> => {
      const requestId = ++duplicateCheckRequestIdRef.current;

      if (climbs.length === 0) {
        setDuplicateMatches({});
        setIsCheckingDuplicates(false);
        return {};
      }

      setIsCheckingDuplicates(true);

      try {
        const client = createGraphQLHttpClient();
        const variables: CheckMoonBoardClimbDuplicatesVariables = {
          input: {
            layoutId,
            angle,
            climbs: climbs.map((climb) => ({
              clientKey: climb.sourceFile,
              holds: climb.holds,
            })),
          },
        };

        const response = await client.request<
          CheckMoonBoardClimbDuplicatesResponse,
          CheckMoonBoardClimbDuplicatesVariables
        >(CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY, variables);

        const matches = Object.fromEntries(
          response.checkMoonBoardClimbDuplicates.map((match) => [match.clientKey, match]),
        ) as DuplicateMatchMap;

        if (requestId === duplicateCheckRequestIdRef.current) {
          setDuplicateMatches(matches);
        }

        return matches;
      } catch (error) {
        console.warn('Failed to check MoonBoard climb duplicates:', error);

        if (requestId === duplicateCheckRequestIdRef.current) {
          setDuplicateMatches({});
        }

        return {};
      } finally {
        if (requestId === duplicateCheckRequestIdRef.current) {
          setIsCheckingDuplicates(false);
        }
      }
    },
    [angle, layoutId],
  );

  useEffect(() => {
    if (state.status !== 'complete') {
      setDuplicateMatches({});
      setIsCheckingDuplicates(false);
      return;
    }

    void runDuplicateCheck(state.climbs);
  }, [runDuplicateCheck, state.climbs, state.status]);

  const duplicateCount = state.climbs.filter((climb) => duplicateMatches[climb.sourceFile]?.exists).length;
  const readyToImportClimbs = state.climbs.filter((climb) => !duplicateMatches[climb.sourceFile]?.exists);

  const handleFilesUpload = useCallback(
    async (fileList: File[]) => {
      if (fileList.length === 0) return;

      // Store files for potential OCR test data upload
      filesMapRef.current = new Map();
      for (const file of fileList) {
        filesMapRef.current.set(file.name, file);
      }

      dispatch({ type: 'START_PROCESSING', total: fileList.length });

      const result = await parseMultipleScreenshots(fileList, (current, total, name) => {
        dispatch({ type: 'UPDATE_PROGRESS', current, total, name });
      });

      // Deduplicate climbs
      const uniqueClimbs = deduplicateClimbs(result.climbs);

      // Filter climbs by angle if needed (or just show warnings)
      const angleMismatchWarnings: Array<{ name: string; error: string }> = [];
      uniqueClimbs.forEach((climb) => {
        if (climb.angle !== angle) {
          angleMismatchWarnings.push({
            name: climb.sourceFile,
            error: `Angle mismatch: screenshot is ${climb.angle}°, current page is ${angle}°`,
          });
        }
      });

      dispatch({
        type: 'COMPLETE',
        climbs: uniqueClimbs,
        errors: [...result.errors, ...angleMismatchWarnings],
      });
    },
    [angle],
  );

  const handleSaveAll = useCallback(async () => {
    if (state.climbs.length === 0) return;

    const userId = session?.user?.id;
    if (!userId || !authToken) {
      showMessage(t('moonboardImport.bulk.loginRequired'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      const latestDuplicateMatches = await runDuplicateCheck(state.climbs);
      const climbsToSave = state.climbs.filter((climb) => !latestDuplicateMatches[climb.sourceFile]?.exists);
      const skippedDuplicateCount = state.climbs.length - climbsToSave.length;

      if (climbsToSave.length === 0) {
        if (skippedDuplicateCount > 0) {
          showMessage(`Skipped ${skippedDuplicateCount} climb(s) that already exist`, 'warning');
        }
        return;
      }

      let savedCount = 0;
      const errors: string[] = [];
      const savedClimbs: MoonBoardClimb[] = [];
      const client = createGraphQLHttpClient(authToken);

      // Save each climb individually to the database
      for (const climb of climbsToSave) {
        try {
          const variables: SaveMoonBoardClimbMutationVariables = {
            input: {
              boardType: 'moonboard',
              layoutId,
              name: climb.name,
              description: `Setter: ${climb.setter}\nGrade: ${climb.userGrade}${climb.isBenchmark ? '\n(Benchmark)' : ''}`,
              holds: climb.holds,
              angle: climb.angle,
              isDraft: false,
              userGrade: climb.userGrade,
              isBenchmark: climb.isBenchmark,
              setter: climb.setter || undefined,
            },
          };

          await client.request<SaveMoonBoardClimbMutationResponse>(SAVE_MOONBOARD_CLIMB_MUTATION, variables);
          savedCount++;
          savedClimbs.push(climb);
        } catch (error) {
          errors.push(`${climb.name}: ${error instanceof Error ? error.message : 'Failed to save'}`);
        }
      }

      if (savedCount > 0) {
        await refreshClimbSearchAfterSave(queryClient, 'moonboard', layoutId);
        showMessage(`Successfully saved ${savedCount} climb(s) to database`, 'success');

        // Fire-and-forget: upload OCR test data if opted in
        if (contributeImages && backendUrl && authToken && savedClimbs.length > 0) {
          // Don't await - fire and forget
          uploadOcrTestDataBatch(backendUrl, filesMapRef.current, savedClimbs, layoutId, angle, authToken).catch(
            (err) => {
              console.warn('[OCR Upload] Background upload failed:', err);
            },
          );
        }
      }
      if (skippedDuplicateCount > 0) {
        showMessage(`Skipped ${skippedDuplicateCount} climb(s) that already exist`, 'warning');
      }
      if (errors.length > 0) {
        showMessage(`Failed to save ${errors.length} climb(s)`, 'warning');
        console.error('Save errors:', errors);
      }

      if (savedCount > 0) {
        dispatch({ type: 'RESET' });
        filesMapRef.current = new Map();
        router.push(listUrl);
      }
    } catch (error) {
      console.error('Failed to save climbs:', error);
      showMessage(t('moonboardImport.bulk.saveFailed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [
    state.climbs,
    layoutId,
    session,
    authToken,
    queryClient,
    router,
    listUrl,
    contributeImages,
    backendUrl,
    showMessage,
    angle,
    runDuplicateCheck,
    t,
  ]);

  const handleRemoveClimb = useCallback((sourceFile: string) => {
    dispatch({ type: 'REMOVE_CLIMB', sourceFile });
  }, []);

  const handleEditClimb = useCallback((climb: MoonBoardClimb) => {
    dispatch({ type: 'OPEN_EDIT', climb });
  }, []);

  const handleSaveEdit = useCallback((updatedClimb: MoonBoardClimb) => {
    dispatch({ type: 'UPDATE_CLIMB', sourceFile: updatedClimb.sourceFile, climb: updatedClimb });
  }, []);

  const handleCloseEdit = useCallback(() => {
    dispatch({ type: 'CLOSE_EDIT' });
  }, []);

  const handleReset = useCallback(() => {
    duplicateCheckRequestIdRef.current += 1;
    setDuplicateMatches({});
    setIsCheckingDuplicates(false);
    dispatch({ type: 'RESET' });
    filesMapRef.current = new Map();
  }, []);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <MuiButton variant="outlined" startIcon={<ArrowBackOutlined />} onClick={handleBack}>
          {t('common:actions.back')}
        </MuiButton>
        <Typography variant="h3" className={styles.title}>
          {t('moonboardImport.bulk.title', { layoutName, angle })}
        </Typography>
      </div>

      {!session?.user && (
        <MuiAlert severity="warning" variant="filled" sx={warningAlertSx} className={styles.warningAlert}>
          <AlertTitle>{t('moonboardImport.bulk.loginRequiredTitle')}</AlertTitle>
          {t('moonboardImport.bulk.loginRequiredBody')}{' '}
          <LocaleLink href="/api/auth/signin">
            <MuiButton variant="text" startIcon={<LoginOutlined />} sx={{ padding: 0, color: 'inherit' }}>
              {t('moonboardImport.bulk.logIn')}
            </MuiButton>
          </LocaleLink>
        </MuiAlert>
      )}

      {/* Upload Section */}
      {state.status === 'idle' && (
        <div className={styles.uploadSection}>
          <Box
            sx={{
              border: '2px dashed',
              borderColor: 'divider',
              borderRadius: 2,
              p: 4,
              textAlign: 'center',
              cursor: 'pointer',
              '&:hover': { borderColor: 'primary.main' },
            }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const files = Array.from(e.dataTransfer.files);
              if (files.length > 0) void handleFilesUpload(files);
            }}
          >
            <input
              type="file"
              ref={fileInputRef}
              accept="image/png,image/jpeg,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) void handleFilesUpload(files);
                e.target.value = '';
              }}
            />
            <InboxOutlined sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
            <Typography variant="body1">{t('moonboardImport.bulk.uploadPrompt')}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('moonboardImport.bulk.uploadHelp')}
            </Typography>
          </Box>
        </div>
      )}

      {/* Processing Section */}
      {state.status === 'processing' && (
        <div className={styles.processingSection}>
          <Typography variant="h4">{t('moonboardImport.bulk.processing')}</Typography>
          <LinearProgress
            variant="determinate"
            value={Math.round((state.progress.current / state.progress.total) * 100)}
          />
          <Typography variant="body2" component="span" color="text.secondary">
            {state.progress.current} / {state.progress.total}: {state.progress.name}
          </Typography>
        </div>
      )}

      {/* Results Section */}
      {state.status === 'complete' && (
        <>
          {/* Errors */}
          {state.errors.length > 0 && (
            <MuiAlert severity="warning" variant="filled" sx={warningAlertSx} className={styles.errorAlert}>
              <AlertTitle>{`${state.errors.length} Warning(s)`}</AlertTitle>
              <ul className={styles.errorList}>
                {state.errors.map((err, i) => (
                  <li key={i}>
                    <strong>{err.name}:</strong> {err.error}
                  </li>
                ))}
              </ul>
            </MuiAlert>
          )}

          {isCheckingDuplicates && state.climbs.length > 0 && (
            <MuiAlert severity="info" className={styles.successAlert}>
              {t('moonboardImport.bulk.checkingDuplicates')}
            </MuiAlert>
          )}

          {/* Success Summary */}
          {readyToImportClimbs.length > 0 && (
            <MuiAlert severity="success" className={styles.successAlert}>
              <AlertTitle>{`${readyToImportClimbs.length} climb(s) ready to import`}</AlertTitle>
              {t('moonboardImport.bulk.reviewBeforeSaving')}
            </MuiAlert>
          )}

          {/* Action Buttons */}
          {state.climbs.length > 0 && (
            <div className={styles.actions}>
              <Stack spacing={2}>
                <Stack direction="row" spacing={1}>
                  <MuiButton
                    variant="contained"
                    startIcon={isSaving ? <CircularProgress size={16} /> : <SaveOutlined />}
                    onClick={handleSaveAll}
                    size="large"
                    disabled={isSaving || isCheckingDuplicates || !session?.user || readyToImportClimbs.length === 0}
                  >
                    {t('moonboardImport.bulk.saveAll', { count: readyToImportClimbs.length })}
                  </MuiButton>
                  <MuiButton variant="outlined" startIcon={<ClearOutlined />} onClick={handleReset}>
                    {t('moonboardImport.bulk.clearAndRestart')}
                  </MuiButton>
                </Stack>
                {backendUrl && (
                  <FormControlLabel
                    control={
                      <MuiCheckbox checked={contributeImages} onChange={(e) => setContributeImages(e.target.checked)} />
                    }
                    label={t('moonboardImport.bulk.contributeImages')}
                  />
                )}
              </Stack>
            </div>
          )}

          {/* Climb Cards Grid */}
          {state.climbs.length > 0 ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }} className={styles.climbGrid}>
              {state.climbs.map((climb) => (
                <Box
                  key={climb.sourceFile}
                  sx={{
                    width: { xs: '100%', sm: '50%', md: '33.33%', lg: '25%' },
                    boxSizing: 'border-box',
                  }}
                >
                  <MoonBoardImportCard
                    climb={climb}
                    duplicateMatch={duplicateMatches[climb.sourceFile] ?? null}
                    layoutFolder={layoutFolder}
                    holdSetImages={holdSetImages}
                    litUpHoldsMap={convertOcrHoldsToMap(climb.holds)}
                    onEdit={() => handleEditClimb(climb)}
                    onRemove={() => handleRemoveClimb(climb.sourceFile)}
                  />
                </Box>
              ))}
            </Box>
          ) : (
            <ResultPage
              status="warning"
              title={duplicateCount > 0 ? 'All imported climbs already exist' : 'No climbs could be imported'}
              subTitle={
                duplicateCount > 0
                  ? 'Edit the duplicate climbs to change their hold selections, or try different screenshots.'
                  : 'Please check the errors above and try again with different screenshots.'
              }
              extra={
                <MuiButton onClick={handleReset} variant="contained">
                  {t('moonboardImport.bulk.tryAgain')}
                </MuiButton>
              }
            />
          )}
        </>
      )}

      {/* Edit Modal */}
      {state.editingClimb && (
        <MoonBoardEditModal
          open={!!state.editingClimb}
          climb={state.editingClimb}
          layoutFolder={layoutFolder}
          holdSetImages={holdSetImages}
          onSave={handleSaveEdit}
          onCancel={handleCloseEdit}
        />
      )}
    </div>
  );
}
