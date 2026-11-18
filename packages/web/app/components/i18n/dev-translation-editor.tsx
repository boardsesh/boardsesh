'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import EditOutlined from '@mui/icons-material/EditOutlined';
import {
  createTranslationMatcher,
  devEditorHostnames,
  preservesTranslationFormat,
  protectedSyntax,
  type TranslationEntry,
} from '@/app/lib/i18n/dev-editor';
import type { Locale } from '@/app/lib/i18n/config';

type HoveredTranslation = { entries: TranslationEntry[]; rectangle: DOMRect };
const editorSelector = '[data-translation-editor]';
const excludedSelector = `${editorSelector}, script, style, input, textarea, select, [contenteditable="true"]`;

function findTranslation(
  target: EventTarget | null,
  match: ReturnType<typeof createTranslationMatcher>,
): HoveredTranslation | null {
  if (!(target instanceof Element) || target.closest(excludedSelector)) return null;
  let element: Element | null = target;
  for (
    let depth = 0;
    element && depth < 5 && !['BODY', 'HTML'].includes(element.tagName);
    depth++, element = element.parentElement
  ) {
    // Restrict work to small pieces of visible copy, including nested <Trans> tags.
    const text = element.textContent ?? '';
    if (text.length > 2000) break;
    const entries = match(text);
    if (entries.length) return { entries, rectangle: element.getBoundingClientRect() };
  }
  return null;
}

export default function DevTranslationEditor({
  locale,
  allowedHostnames = devEditorHostnames(),
}: {
  locale: Locale;
  allowedHostnames?: string[];
}) {
  const { t } = useTranslation('devTools');
  const [entries, setEntries] = useState<TranslationEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hovered, setHovered] = useState<HoveredTranslation | null>(null);
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<TranslationEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TranslationEntry | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<'conflict' | 'request' | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const local = mounted && allowedHostnames.includes(window.location.hostname);
  const match = useMemo(() => createTranslationMatcher(entries), [entries]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (candidates ?? entries).filter((entry) =>
      `${entry.namespace}:${entry.key} ${entry.text}`.toLocaleLowerCase().includes(query),
    );
  }, [entries, candidates, search]);

  useEffect(() => {
    if (!enabled || !local) return;
    const controller = new AbortController();
    setLoaded(false);
    setLoadError(false);
    void fetch(`/api/internal/dev-translations?locale=${locale}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Catalog request failed');
        const result = (await response.json()) as { entries: TranslationEntry[] };
        setEntries(result.entries);
        setLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [enabled, locale, local]);

  useEffect(() => {
    if (!enabled || !loaded || open) return;
    const inspect = (event: PointerEvent) => {
      const found = findTranslation(event.target, match);
      if (found) setHovered(found);
    };
    const select = (event: MouseEvent) => {
      const found = findTranslation(event.target, match);
      if (!found) return;
      event.preventDefault();
      event.stopPropagation();
      setCandidates(found.entries);
      setSearch('');
      setSelected(found.entries.length === 1 ? found.entries[0] : null);
      setDraft(found.entries.length === 1 ? found.entries[0].text : '');
      setSaveError(null);
      setOpen(true);
      setHovered(null);
    };
    const clear = () => setHovered(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEnabled(false);
        clear();
      }
    };
    document.addEventListener('pointerover', inspect, true);
    document.addEventListener('click', select, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('pointerover', inspect, true);
      document.removeEventListener('click', select, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, [enabled, loaded, open, match]);

  // This component only mounts in development on explicitly allowed hosts.
  if (!local) return null;
  const valid = selected ? preservesTranslationFormat(selected.text, draft) : false;
  const close = () => {
    if (!saving) {
      setOpen(false);
      setSelected(null);
      setSaveError(null);
    }
  };
  const choose = (entry: TranslationEntry) => {
    setSelected(entry);
    setDraft(entry.text);
    setSaveError(null);
  };
  const browse = () => {
    setCandidates(null);
    setSearch('');
    setSelected(null);
    setSaveError(null);
    setOpen(true);
    setHovered(null);
  };
  const save = async () => {
    if (!selected || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/internal/dev-translations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locale,
          namespace: selected.namespace,
          key: selected.key,
          previous: selected.text,
          replacement: draft,
        }),
      });
      if (!response.ok) {
        setSaveError(response.status === 409 ? 'conflict' : 'request');
        return;
      }
      // Recreate the browser singleton as well as the server-rendered copy.
      // router.refresh alone leaves already-loaded client bundles unchanged.
      setReloadRequired(true);
      window.location.reload();
    } catch {
      setSaveError('request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Paper
        data-translation-editor
        elevation={6}
        sx={{
          position: 'fixed',
          bottom: (theme) => theme.spacing(1),
          right: (theme) => theme.spacing(2),
          zIndex: 'drawer',
          p: 1,
          maxWidth: 'calc(100vw - 32px)',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="small"
            startIcon={<EditOutlined />}
            onClick={() => {
              setEnabled(!enabled);
              setHovered(null);
            }}
          >
            {enabled ? t('stopEditing') : t('editTranslations')}
          </Button>
          {enabled && loaded && (
            <Button size="small" onClick={browse}>
              {t('search')}
            </Button>
          )}
          {enabled && !loaded && !loadError && <CircularProgress size={16} aria-label={t('loading')} />}
        </Stack>
        {enabled && <Typography variant="caption">{t('inspectHint')}</Typography>}
        {loadError && <Alert severity="error">{t('requestError')}</Alert>}
      </Paper>
      {enabled && !open && hovered && (
        <Box data-translation-editor sx={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 'tooltip' }}>
          <Box
            sx={{
              position: 'absolute',
              top: hovered.rectangle.top,
              left: hovered.rectangle.left,
              width: hovered.rectangle.width,
              height: hovered.rectangle.height,
              outline: '2px solid',
              outlineColor: 'primary.main',
              borderRadius: 1,
            }}
          />
          <Button
            variant="contained"
            size="small"
            startIcon={<EditOutlined />}
            sx={{
              position: 'absolute',
              pointerEvents: 'auto',
              top: Math.min(Math.max(hovered.rectangle.bottom, 0), window.innerHeight - 48),
              left: Math.min(Math.max(hovered.rectangle.left, 0), window.innerWidth - 140),
            }}
            onClick={() => {
              setCandidates(hovered.entries);
              setSearch('');
              setSaveError(null);
              if (hovered.entries.length === 1) choose(hovered.entries[0]);
              else setSelected(null);
              setOpen(true);
              setHovered(null);
            }}
          >
            {t('edit')}
          </Button>
        </Box>
      )}
      <Dialog data-translation-editor open={open} onClose={close} fullWidth maxWidth="md">
        <DialogTitle>{t('title', { locale })}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info">{t('sharedCatalogWarning')}</Alert>
            {selected ? (
              <>
                <Typography component="code" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {selected.namespace}:{selected.key}
                </Typography>
                <TextField
                  label={t('original')}
                  value={selected.text}
                  multiline
                  fullWidth
                  slotProps={{ input: { readOnly: true } }}
                />
                <TextField
                  label={t('replacement')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={saving || reloadRequired}
                  multiline
                  minRows={3}
                  maxRows={12}
                  fullWidth
                  autoFocus
                  helperText={t('lengthHint', { original: selected.text.length, replacement: draft.length })}
                />
                {!!protectedSyntax(selected.text).length && (
                  <Box>
                    <Typography variant="caption">{t('protectedTokens')}</Typography>
                    <Stack direction="row" useFlexGap flexWrap="wrap" gap={1}>
                      {protectedSyntax(selected.text).map((token, index) => (
                        <Chip key={`${index}:${token}`} label={JSON.stringify(token)} size="small" />
                      ))}
                    </Stack>
                  </Box>
                )}
                {!valid && <Alert severity="warning">{t('formatError')}</Alert>}
                <Typography variant="body2">{t('formatHint')}</Typography>
              </>
            ) : (
              <>
                {candidates && <Alert severity="warning">{t('ambiguous')}</Alert>}
                <TextField
                  label={t('searchLabel')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  fullWidth
                  autoFocus
                />
                <Typography variant="caption">{t('results', { count: filtered.length })}</Typography>
                <List sx={{ maxHeight: '45vh', overflow: 'auto' }}>
                  {filtered.slice(0, 50).map((entry) => (
                    <ListItemButton key={`${entry.namespace}:${entry.key}`} onClick={() => choose(entry)}>
                      <ListItemText
                        primary={`${entry.namespace}:${entry.key}`}
                        secondary={entry.text}
                        slotProps={{
                          primary: { sx: { overflowWrap: 'anywhere' } },
                          secondary: { sx: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } },
                        }}
                      />
                    </ListItemButton>
                  ))}
                </List>
                {filtered.length > 50 && <Typography variant="caption">{t('narrowSearch')}</Typography>}
              </>
            )}
            {saveError && (
              <Alert severity="error">{saveError === 'conflict' ? t('conflict') : t('requestError')}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {selected && (
            <Button disabled={saving || reloadRequired} onClick={() => setSelected(null)}>
              {t('back')}
            </Button>
          )}
          <Button onClick={close} disabled={saving || reloadRequired}>
            {t('close')}
          </Button>
          {saveError === 'conflict' && <Button onClick={() => window.location.reload()}>{t('reload')}</Button>}
          {selected && (
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={!valid || draft === selected.text || saving || reloadRequired}
            >
              {saving ? t('saving') : t('saveAndReload')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
