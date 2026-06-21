'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Checkbox from '@mui/material/Checkbox';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import type { SelectChangeEvent } from '@mui/material/Select';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlined from '@mui/icons-material/ErrorOutlineOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { extractGraphQLErrorMessage } from '@/app/lib/graphql/extract-error-message';
import LocaleLink from '@/app/components/i18n/locale-link';
import { track } from '@/app/lib/analytics';
import {
  INSTAGRAM_BETA_SCAN,
  ATTACH_BETA_LINK,
  type InstagramBetaScanQueryResponse,
  type AttachBetaLinkMutationResponse,
} from '@boardsesh/graphql/operations';
import type {
  InstagramBetaScanResult,
  InstagramBetaMatch,
  InstagramBetaAmbiguous,
  InstagramScanPostInput,
} from '@boardsesh/shared-schema';
import { INSTAGRAM_SCAN_SCRIPT } from './instagram-scan-script';

type BoardType = 'kilter' | 'tension';

// Per-row attach outcome for the missing[] section. Each item attaches
// independently (private/deleted posts fail) so we surface state per row.
type AttachStatus = 'idle' | 'pending' | 'attached' | 'failed';

const ATTACH_DELAY_MS = 600;

// applyRateLimit (backend) throws a structured RATE_LIMITED error carrying
// retryAfterSeconds. Pull it out of the graphql-request ClientError so a large
// bulk attach can pace itself to the 30/min limit instead of dropping videos.
function rateLimitRetrySeconds(error: unknown): number | null {
  const errors = (error as { response?: { errors?: { extensions?: { code?: string; retryAfterSeconds?: number } }[] } })
    ?.response?.errors;
  const limited = errors?.find((entry) => entry.extensions?.code === 'RATE_LIMITED');
  if (!limited) return null;
  const seconds = limited.extensions?.retryAfterSeconds;
  return typeof seconds === 'number' && seconds > 0 ? Math.min(seconds, 65) : 30;
}

const MAX_RATE_LIMIT_RETRIES = 6;

// Attach one beta link, transparently waiting out the per-user rate limit so a
// big import finishes cleanly. Non-rate errors (private/deleted post, same-climb
// dup) propagate immediately for the caller to record per row.
async function attachBetaLinkWithRetry(
  client: ReturnType<typeof createGraphQLHttpClient>,
  input: { boardType: string; climbUuid: string; link: string; angle?: number },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.request<AttachBetaLinkMutationResponse>(ATTACH_BETA_LINK, { input });
      return;
    } catch (error) {
      const waitSeconds = rateLimitRetrySeconds(error);
      if (waitSeconds === null || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, (waitSeconds + 1) * 1000));
    }
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  // Legacy fallback for non-secure contexts where navigator.clipboard is unavailable.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Parse the JSON the console script copies into a shortcode/caption list. */
function parsePastedPosts(raw: string): InstagramScanPostInput[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('not-array');
  }
  const posts: InstagramScanPostInput[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const shortcode = record.shortcode;
    if (typeof shortcode !== 'string' || shortcode.length === 0) continue;
    if (seen.has(shortcode)) continue; // a profile can surface the same reel twice; one row per shortcode
    seen.add(shortcode);
    posts.push({
      shortcode,
      caption: typeof record.caption === 'string' ? record.caption : '',
      takenAt: typeof record.takenAt === 'string' ? record.takenAt : null,
    });
  }
  return posts;
}

export default function ImportBetaContent() {
  const { t } = useTranslation('feed');
  const { token, isAuthenticated, isLoading: isAuthLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();

  const [boardType, setBoardType] = useState<BoardType>('kilter');
  const [pastedJson, setPastedJson] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<InstagramBetaScanResult | null>(null);

  const heading = (
    <Box component="header" sx={{ mb: 3 }}>
      <Typography variant="h4" component="h1" sx={{ mb: 1 }}>
        {t('importBeta.title')}
      </Typography>
      <Typography variant="body1" color="text.secondary">
        {t('importBeta.intro')}
      </Typography>
    </Box>
  );

  const pageShell = (children: React.ReactNode) => (
    <Box
      sx={{
        minHeight: '100vh',
        paddingTop: 'var(--global-header-height)',
        background: 'var(--semantic-background)',
      }}
    >
      <Box
        component="main"
        sx={{
          padding: 3,
          paddingBottom: 'var(--bottom-bar-height)',
          maxWidth: 720,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {children}
      </Box>
    </Box>
  );

  // Auth gate. The first server HTML still renders the h1 + intro (the page is
  // noindex but should never be a bare spinner), then we show a sign-in prompt
  // once the auth status resolves.
  if (!isAuthenticated) {
    return pageShell(
      <>
        {heading}
        <Card>
          <CardContent>
            {isAuthLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={28} />
              </Box>
            ) : (
              <Stack spacing={2} alignItems="flex-start">
                <Typography variant="body1">{t('importBeta.signInPrompt')}</Typography>
                <Button component={LocaleLink} href="/auth" variant="contained">
                  {t('importBeta.signInCta')}
                </Button>
              </Stack>
            )}
          </CardContent>
        </Card>
      </>,
    );
  }

  const handleCopyScript = async () => {
    const copied = await copyTextToClipboard(INSTAGRAM_SCAN_SCRIPT);
    if (copied) {
      track('Import Beta Script Copied', { boardType });
      showMessage(t('importBeta.scriptCopied'), 'success');
    } else {
      showMessage(t('importBeta.scriptCopyFailed'), 'error');
    }
  };

  const handleScan = async () => {
    if (!token) {
      showMessage(t('importBeta.authUnavailable'), 'error');
      return;
    }
    const raw = pastedJson.trim();
    if (!raw) {
      showMessage(t('importBeta.pasteEmpty'), 'error');
      return;
    }

    let posts: InstagramScanPostInput[];
    try {
      posts = parsePastedPosts(raw);
    } catch {
      showMessage(t('importBeta.parseError'), 'error');
      return;
    }
    if (posts.length === 0) {
      showMessage(t('importBeta.noPosts'), 'error');
      return;
    }

    setIsScanning(true);
    setResult(null);
    try {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<InstagramBetaScanQueryResponse>(INSTAGRAM_BETA_SCAN, {
        input: { boardType, posts },
      });
      setResult(response.instagramBetaScan);
      track('Import Beta Scanned', {
        boardType,
        scanned: String(response.instagramBetaScan.scanned),
        missing: String(response.instagramBetaScan.missing.length),
      });
    } catch (error) {
      const serverMessage = extractGraphQLErrorMessage(error);
      showMessage(serverMessage ?? t('importBeta.scanError'), 'error');
    } finally {
      setIsScanning(false);
    }
  };

  return pageShell(
    <>
      {heading}
      <Stack spacing={3}>
        <BoardSelector value={boardType} onChange={setBoardType} />
        <ScanStep onCopyScript={handleCopyScript} />
        <PasteStep value={pastedJson} onChange={setPastedJson} onSubmit={handleScan} isScanning={isScanning} />
        {result && <ReviewStep result={result} token={token} showMessage={showMessage} />}
      </Stack>
    </>,
  );
}

type BoardSelectorProps = {
  value: BoardType;
  onChange: (board: BoardType) => void;
};

function BoardSelector({ value, onChange }: BoardSelectorProps) {
  const { t } = useTranslation('feed');
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          {t('importBeta.board.label')}
        </Typography>
        <ToggleButtonGroup
          value={value}
          exclusive
          onChange={(_event, next) => {
            if (next !== null) onChange(next as BoardType);
          }}
          size="small"
          fullWidth
        >
          <ToggleButton value="kilter">{t('importBeta.board.kilter')}</ToggleButton>
          <ToggleButton value="tension">{t('importBeta.board.tension')}</ToggleButton>
        </ToggleButtonGroup>
      </CardContent>
    </Card>
  );
}

type ScanStepProps = {
  onCopyScript: () => void;
};

function ScanStep({ onCopyScript }: ScanStepProps) {
  const { t } = useTranslation('feed');
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          {t('importBeta.scan.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('importBeta.scan.subtitle')}
        </Typography>
        <Stack component="ol" spacing={1} sx={{ pl: 2.5, m: 0, mb: 2 }}>
          <Typography component="li" variant="body2">
            {t('importBeta.scan.step1')}
          </Typography>
          <Typography component="li" variant="body2">
            {t('importBeta.scan.step2')}
          </Typography>
          <Typography component="li" variant="body2">
            {t('importBeta.scan.step3')}
          </Typography>
        </Stack>
        <Box sx={{ position: 'relative' }}>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              pr: 6,
              borderRadius: 1,
              bgcolor: 'action.hover',
              border: '1px solid',
              borderColor: 'divider',
              overflowX: 'auto',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              lineHeight: 1.5,
              maxHeight: 220,
              whiteSpace: 'pre',
            }}
          >
            {INSTAGRAM_SCAN_SCRIPT}
          </Box>
          <IconButton
            aria-label={t('importBeta.scan.copyScript')}
            onClick={onCopyScript}
            size="small"
            sx={{ position: 'absolute', top: 8, right: 8, bgcolor: 'background.paper' }}
          >
            <ContentCopyOutlined fontSize="small" />
          </IconButton>
        </Box>
        <Button
          onClick={onCopyScript}
          startIcon={<ContentCopyOutlined />}
          variant="outlined"
          size="small"
          sx={{ mt: 2 }}
        >
          {t('importBeta.scan.copyScript')}
        </Button>
      </CardContent>
    </Card>
  );
}

type PasteStepProps = {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  isScanning: boolean;
};

function PasteStep({ value, onChange, onSubmit, isScanning }: PasteStepProps) {
  const { t } = useTranslation('feed');
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          {t('importBeta.paste.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('importBeta.paste.subtitle')}
        </Typography>
        <TextField
          fullWidth
          multiline
          minRows={4}
          maxRows={10}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('importBeta.paste.placeholder')}
          label={t('importBeta.paste.label')}
          disabled={isScanning}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
          <Button
            variant="contained"
            onClick={onSubmit}
            disabled={isScanning || value.trim().length === 0}
            startIcon={isScanning ? <CircularProgress size={16} /> : undefined}
          >
            {t('importBeta.paste.submit')}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}

type ReviewStepProps = {
  result: InstagramBetaScanResult;
  token: string | null;
  showMessage: (text: string, severity: 'success' | 'error' | 'info' | 'warning') => void;
};

function ReviewStep({ result, token, showMessage }: ReviewStepProps) {
  const { t } = useTranslation('feed');
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          {t('importBeta.review.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('importBeta.review.summary', {
            scanned: result.scanned,
            parsed: result.parsed,
            found: result.missing.length,
            already: result.alreadyLinked.length,
            ambiguous: result.ambiguous.length,
            skipped: result.unmatched.length,
          })}
        </Typography>

        <MissingSection items={result.missing} token={token} showMessage={showMessage} />

        {result.ambiguous.length > 0 && (
          <>
            <MuiDivider sx={{ my: 3 }} />
            <AmbiguousSection items={result.ambiguous} token={token} showMessage={showMessage} />
          </>
        )}

        {(result.alreadyLinked.length > 0 || result.unmatched.length > 0) && (
          <Box sx={{ mt: 3 }}>
            {result.alreadyLinked.length > 0 && (
              <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent' }}>
                <AccordionSummary expandIcon={<ExpandMoreOutlined />} sx={{ px: 0 }}>
                  <Typography variant="body2" color="text.secondary">
                    {t('importBeta.alreadyLinked.heading', { count: result.alreadyLinked.length })}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0 }}>
                  <Stack spacing={1}>
                    {result.alreadyLinked.map((item) => (
                      <Stack
                        key={item.shortcode}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Typography variant="body2">
                          {item.climbName}
                          {item.angle != null && ` · ${t('importBeta.angle', { angle: item.angle })}`}
                        </Typography>
                        <Link
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('importBeta.openOnInstagram')}
                        >
                          <OpenInNewOutlined fontSize="small" />
                        </Link>
                      </Stack>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            )}

            {result.unmatched.length > 0 && (
              <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent' }}>
                <AccordionSummary expandIcon={<ExpandMoreOutlined />} sx={{ px: 0 }}>
                  <Typography variant="body2" color="text.secondary">
                    {t('importBeta.unmatched.heading', { count: result.unmatched.length })}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0 }}>
                  <Stack spacing={1}>
                    {result.unmatched.map((item) => (
                      <Stack
                        key={item.shortcode}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Typography variant="body2" color="text.secondary">
                          {item.parsedName ?? t('importBeta.unmatched.noName')}
                        </Typography>
                        <Link
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('importBeta.openOnInstagram')}
                        >
                          <OpenInNewOutlined fontSize="small" />
                        </Link>
                      </Stack>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

type MissingSectionProps = {
  items: InstagramBetaMatch[];
  token: string | null;
  showMessage: ReviewStepProps['showMessage'];
};

function MissingSection({ items, token, showMessage }: MissingSectionProps) {
  const { t } = useTranslation('feed');
  // Default every found-but-unlinked match to selected.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((item) => item.shortcode)));
  const [statuses, setStatuses] = useState<Record<string, AttachStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isAttaching, setIsAttaching] = useState(false);

  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t('importBeta.missing.empty')}
      </Typography>
    );
  }

  const toggle = (shortcode: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(shortcode)) {
        next.delete(shortcode);
      } else {
        next.add(shortcode);
      }
      return next;
    });
  };

  const handleAttachSelected = async () => {
    if (!token) {
      showMessage(t('importBeta.authUnavailable'), 'error');
      return;
    }
    const queue = items.filter((item) => selected.has(item.shortcode) && statuses[item.shortcode] !== 'attached');
    if (queue.length === 0) return;

    setIsAttaching(true);
    const client = createGraphQLHttpClient(token);
    let attachedCount = 0;
    let failedCount = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      setStatuses((prev) => ({ ...prev, [item.shortcode]: 'pending' }));
      try {
        await attachBetaLinkWithRetry(client, {
          boardType: item.boardType,
          climbUuid: item.climbUuid,
          link: item.link,
          angle: item.angle ?? undefined,
        });
        attachedCount += 1;
        setStatuses((prev) => ({ ...prev, [item.shortcode]: 'attached' }));
      } catch (error) {
        failedCount += 1;
        const serverMessage = extractGraphQLErrorMessage(error);
        setStatuses((prev) => ({ ...prev, [item.shortcode]: 'failed' }));
        setErrors((prev) => ({
          ...prev,
          [item.shortcode]: serverMessage ?? t('importBeta.missing.attachFailedGeneric'),
        }));
      }
      // Space out calls so we don't hammer the resolver / Instagram thumbnail fetch.
      if (index < queue.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, ATTACH_DELAY_MS));
      }
    }

    setIsAttaching(false);
    track('Import Beta Attached', { attached: String(attachedCount), failed: String(failedCount) });
    if (failedCount === 0) {
      showMessage(t('importBeta.missing.attachAllDone', { count: attachedCount }), 'success');
    } else {
      showMessage(
        t('importBeta.missing.attachSomeFailed', { attached: attachedCount, failed: failedCount }),
        'warning',
      );
    }
  };

  const selectedCount = items.filter(
    (item) => selected.has(item.shortcode) && statuses[item.shortcode] !== 'attached',
  ).length;

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
        {t('importBeta.missing.heading', { count: items.length })}
      </Typography>
      <Stack spacing={1}>
        {items.map((item) => {
          const status = statuses[item.shortcode] ?? 'idle';
          return (
            <Box
              key={item.shortcode}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                p: 1,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Checkbox
                checked={selected.has(item.shortcode)}
                onChange={() => toggle(item.shortcode)}
                disabled={isAttaching || status === 'attached'}
                size="small"
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {item.climbName}
                  {item.angle != null && ` · ${t('importBeta.angle', { angle: item.angle })}`}
                </Typography>
                {status === 'failed' && errors[item.shortcode] && (
                  <Typography variant="caption" color="error">
                    {errors[item.shortcode]}
                  </Typography>
                )}
              </Box>
              <StatusBadge status={status} />
              <Link
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('importBeta.openOnInstagram')}
                sx={{ display: 'inline-flex' }}
              >
                <OpenInNewOutlined fontSize="small" />
              </Link>
            </Box>
          );
        })}
      </Stack>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
        <Button
          variant="contained"
          onClick={handleAttachSelected}
          disabled={isAttaching || selectedCount === 0}
          startIcon={isAttaching ? <CircularProgress size={16} /> : undefined}
        >
          {t('importBeta.missing.attachSelected', { count: selectedCount })}
        </Button>
      </Box>
    </Box>
  );
}

function StatusBadge({ status }: { status: AttachStatus }) {
  const { t } = useTranslation('feed');
  if (status === 'pending') {
    return <CircularProgress size={16} />;
  }
  if (status === 'attached') {
    return (
      <Chip
        size="small"
        color="success"
        variant="outlined"
        icon={<CheckCircleOutlined fontSize="small" />}
        label={t('importBeta.status.attached')}
      />
    );
  }
  if (status === 'failed') {
    return (
      <Chip
        size="small"
        color="error"
        variant="outlined"
        icon={<ErrorOutlineOutlined fontSize="small" />}
        label={t('importBeta.status.failed')}
      />
    );
  }
  return null;
}

type AmbiguousSectionProps = {
  items: InstagramBetaAmbiguous[];
  token: string | null;
  showMessage: ReviewStepProps['showMessage'];
};

function AmbiguousSection({ items, token, showMessage }: AmbiguousSectionProps) {
  const { t } = useTranslation('feed');
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ mb: 0.5, fontWeight: 600 }}>
        {t('importBeta.ambiguous.heading', { count: items.length })}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('importBeta.ambiguous.subtitle')}
      </Typography>
      <Stack spacing={2}>
        {items.map((item) => (
          <AmbiguousRow key={item.shortcode} item={item} token={token} showMessage={showMessage} />
        ))}
      </Stack>
    </Box>
  );
}

type AmbiguousRowProps = {
  item: InstagramBetaAmbiguous;
  token: string | null;
  showMessage: ReviewStepProps['showMessage'];
};

function AmbiguousRow({ item, token, showMessage }: AmbiguousRowProps) {
  const { t } = useTranslation('feed');
  const [chosenUuid, setChosenUuid] = useState('');
  const [status, setStatus] = useState<AttachStatus>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);

  const candidateLabel = useMemo(
    () => (climbUuid: string) => {
      const candidate = item.candidates.find((entry) => entry.climbUuid === climbUuid);
      if (!candidate) return '';
      const setter = candidate.setterUsername ?? t('importBeta.ambiguous.unknownSetter');
      return t('importBeta.ambiguous.candidateLabel', { setter, layoutId: candidate.layoutId });
    },
    [item.candidates, t],
  );

  const handleAttach = async () => {
    if (!token) {
      showMessage(t('importBeta.authUnavailable'), 'error');
      return;
    }
    if (!chosenUuid) return;
    setStatus('pending');
    setErrorText(null);
    try {
      const client = createGraphQLHttpClient(token);
      await attachBetaLinkWithRetry(client, {
        boardType: item.boardType,
        climbUuid: chosenUuid,
        link: item.link,
        angle: item.angle ?? undefined,
      });
      setStatus('attached');
      track('Import Beta Attached', { attached: '1', failed: '0', source: 'ambiguous' });
      showMessage(t('importBeta.ambiguous.attachedToast'), 'success');
    } catch (error) {
      setStatus('failed');
      const serverMessage = extractGraphQLErrorMessage(error);
      setErrorText(serverMessage ?? t('importBeta.missing.attachFailedGeneric'));
    }
  };

  return (
    <Box sx={{ p: 1.5, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="body2" fontWeight={600}>
          {item.parsedName}
        </Typography>
        <Link
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('importBeta.openOnInstagram')}
          sx={{ display: 'inline-flex' }}
        >
          <OpenInNewOutlined fontSize="small" />
        </Link>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <Select
          value={chosenUuid}
          onChange={(event: SelectChangeEvent) => setChosenUuid(event.target.value)}
          displayEmpty
          size="small"
          fullWidth
          disabled={status === 'pending' || status === 'attached'}
          renderValue={(value) => (value ? candidateLabel(value) : t('importBeta.ambiguous.selectPlaceholder'))}
        >
          <MenuItem value="" disabled>
            {t('importBeta.ambiguous.selectPlaceholder')}
          </MenuItem>
          {item.candidates.map((candidate) => (
            <MenuItem key={candidate.climbUuid} value={candidate.climbUuid}>
              {t('importBeta.ambiguous.candidateLabel', {
                setter: candidate.setterUsername ?? t('importBeta.ambiguous.unknownSetter'),
                layoutId: candidate.layoutId,
              })}
            </MenuItem>
          ))}
        </Select>
        <Button
          variant="outlined"
          onClick={handleAttach}
          disabled={!chosenUuid || status === 'pending' || status === 'attached'}
          startIcon={status === 'pending' ? <CircularProgress size={16} /> : undefined}
          sx={{ flexShrink: 0 }}
        >
          {t('importBeta.ambiguous.attach')}
        </Button>
        <StatusBadge status={status} />
      </Stack>
      {status === 'failed' && errorText && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
          {errorText}
        </Typography>
      )}
    </Box>
  );
}
