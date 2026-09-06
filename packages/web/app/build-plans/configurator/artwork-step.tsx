'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CncArtworkKind, CncArtworkMode, CncArtworkRules } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';
import styles from '../build-plans.module.css';
import { CNC_ARTWORK_MODES, artworkIssues, isArtworkReady, type CncArtworkDraft } from './configurator-state';
import { CNC_FALLBACK_KEEPOUT, type CncLayoutModel } from './layout-model';
import type { CncLayoutPanel } from './layout-summary';
import type { HoleMm, PanelRectMm, SeamLineMm } from './placement-editor/geometry';
import PlacementEditor from './placement-editor/placement-editor';
import type { CncArtworkCollision } from './use-cnc-artwork-validation';
import {
  artworkKindForMime,
  uploadAcceptAttribute,
  useCncArtworkUpload,
  type CncArtUploadErrorKey,
} from './use-cnc-artwork-upload';

/**
 * Frozen empties for a layout that has not arrived.
 *
 * Module constants rather than `?? []` at the call site: the editor rebuilds
 * its collision context whenever one of these changes identity, and a fresh
 * array every render would rebuild it every render, forever.
 */
const EMPTY_PANEL_RECTS: readonly PanelRectMm[] = [];
const EMPTY_HOLES: readonly HoleMm[] = [];
const EMPTY_HOLE_PANELS: readonly number[] = [];
const EMPTY_SEAMS: readonly SeamLineMm[] = [];

/**
 * Custom artwork: type a label, or upload a logo, then put it somewhere.
 *
 * Two verdicts run side by side and they are not interchangeable. The local one
 * (`artworkIssues`) answers "is this field filled in sensibly" instantly, from
 * the catalogue's published bounds. The generator's one answers "will this
 * actually cut" — the only question that matters — and it is what gates Buy.
 * The local check exists so somebody typing a 2000 mm width does not need a
 * round trip to learn it is too wide; it never stands in for the other.
 *
 * The preview of an upload is an object URL made from the buyer's own File, and
 * it lives here rather than in the draft on purpose: an object URL is dead the
 * moment the tab reloads, so persisting one would restore a draft full of
 * broken images. A restored upload shows its name and its placement instead,
 * which is all the buyer needs to move it — the bytes are already in the
 * bucket.
 *
 * Where the artwork goes is the placement editor's job: width, rotation and
 * position are all set on a drawing of the buyer's own wall, so this step keeps
 * only the questions a picture cannot answer — what it says, in what face, cut
 * which way.
 */

/** What the buyer sees under an upload while its object URL is alive. */
type ArtworkPreview = { url: string; fileName: string };

export type ArtworkStepProps = {
  artwork: readonly CncArtworkDraft[];
  rules: CncArtworkRules;
  /** Typeface keys from the catalogue, default first. */
  fonts: readonly string[];
  panels: readonly CncLayoutPanel[];
  /** The wall the editor draws. Null until the layout lands. */
  layout: CncLayoutModel | null;
  /** The generator's verdict, or null when there is no answer — see `useCncArtworkValidation`. */
  validationOk: boolean | null;
  collisions: readonly CncArtworkCollision[];
  isChecking: boolean;
  /** False when nobody is signed in, so the generator has not been asked at all. */
  canValidate: boolean;
  /** Session token for the upload route. Null when signed out, which hides the picker. */
  authToken: string | null;
  onAdd: () => void;
  onAddAsset: (asset: { assetId: string; kind: CncArtworkKind }) => void;
  onChange: (id: string, patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
  onRemove: (id: string) => void;
  /** One item's local verdict, so Buy can stay shut while artwork sits on a hole. */
  onLocalCollisions: (id: string, hasCollisions: boolean) => void;
};

export default function ArtworkStep({
  artwork,
  rules,
  fonts,
  panels,
  layout,
  validationOk,
  collisions,
  isChecking,
  canValidate,
  authToken,
  onAdd,
  onAddAsset,
  onChange,
  onRemove,
  onLocalCollisions,
}: ArtworkStepProps) {
  const { t } = useTranslation('cnc');
  const isFull = artwork.length >= rules.maxItems;

  const { upload, isUploading, errorKey: uploadErrorKey, errorDetail, clearError } = useCncArtworkUpload(authToken);
  // A file that got past the picker's `accept` — "All files" is one click away —
  // and turned out to be a kind the catalogue does not sell yet. Its own state
  // because it never reached the route, so the route has no opinion on it.
  const [localErrorKey, setLocalErrorKey] = useState<CncArtUploadErrorKey | null>(null);

  const [previews, setPreviews] = useState<Record<string, ArtworkPreview>>({});
  const previewsRef = useRef(previews);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);
  // Every object URL pins its blob until it is revoked. Four logos is not a
  // leak worth losing sleep over; leaving them pinned for the life of the tab
  // while somebody reconfigures a wall a dozen times is.
  useEffect(
    () => () => {
      for (const preview of Object.values(previewsRef.current)) URL.revokeObjectURL(preview.url);
    },
    [],
  );

  const uploadableKinds = rules.allowedKinds.filter((kind) => kind !== 'text');
  const canUpload = uploadableKinds.length > 0;
  const errorKey = uploadErrorKey ?? localErrorKey;

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Let the same file be picked again after a failure.
    event.target.value = '';
    if (!file) return;

    setLocalErrorKey(null);
    clearError();

    const result = await upload(file);
    if (!result) return;

    // The kind comes from the mime the SERVER sniffed, never from the file's
    // name or the type the browser guessed.
    const kind = artworkKindForMime(result.mime);
    if (!kind || !rules.allowedKinds.includes(kind)) {
      setLocalErrorKey('unsupportedType');
      return;
    }

    setPreviews((current) => ({
      ...current,
      [result.assetId]: { url: URL.createObjectURL(file), fileName: file.name },
    }));
    onAddAsset({ assetId: result.assetId, kind });
  };

  const handleRemove = (item: CncArtworkDraft) => {
    const assetId = item.assetId;
    if (assetId) {
      const preview = previews[assetId];
      if (preview) {
        URL.revokeObjectURL(preview.url);
        setPreviews((current) => {
          const remaining = { ...current };
          delete remaining[assetId];
          return remaining;
        });
      }
    }
    onRemove(item.id);
  };

  return (
    <Box>
      <Typography variant="subtitle1" className={styles.stepHeading}>
        {t('configurator.artwork.heading')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('configurator.artwork.help', { count: rules.maxItems })}
      </Typography>

      <Stack spacing={2} sx={{ mt: 2 }}>
        {artwork.map((item, index) => (
          <ArtworkItemFields
            key={item.id}
            item={item}
            // The index the generator reports collisions against: it is the
            // position in the SUBMITTED list, and an item that is not finished
            // is not submitted. Counting only the ready items above this one is
            // what keeps a half-typed label from shifting somebody else's
            // collision onto the wrong card.
            submittedIndex={artwork.slice(0, index).filter(isArtworkReady).length}
            // The card's own position, for numbering an unfilled card — every
            // empty card would otherwise read `submittedIndex` as 0 and show
            // "Artwork #1" no matter how many empty cards sit above it.
            displayIndex={index}
            isSubmitted={isArtworkReady(item)}
            preview={item.assetId ? (previews[item.assetId] ?? null) : null}
            rules={rules}
            fonts={fonts}
            panels={panels}
            layout={layout}
            collisions={collisions}
            onChange={(patch) => onChange(item.id, patch)}
            onRemove={() => handleRemove(item)}
            onLocalCollisions={(hasCollisions) => onLocalCollisions(item.id, hasCollisions)}
          />
        ))}

        <Box>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Button variant="outlined" onClick={onAdd} disabled={isFull} sx={{ textTransform: 'none' }}>
              {t('configurator.artwork.add')}
            </Button>

            {canUpload && (
              <Button
                variant="outlined"
                component="label"
                disabled={isFull || isUploading || !authToken}
                startIcon={isUploading ? <CircularProgress size={16} /> : undefined}
                sx={{ textTransform: 'none' }}
              >
                {isUploading ? t('configurator.artwork.upload.busy') : t('configurator.artwork.upload.button')}
                <input
                  type="file"
                  className={styles.visuallyHiddenInput}
                  accept={uploadAcceptAttribute(uploadableKinds)}
                  onChange={(event) => void handleFileSelected(event)}
                />
              </Button>
            )}
          </Stack>

          <FormHelperText>
            {isFull
              ? t('configurator.artwork.full', { count: rules.maxItems })
              : t('configurator.artwork.remaining', { count: rules.maxItems - artwork.length })}
          </FormHelperText>

          {canUpload && (
            <FormHelperText>
              {authToken ? t('configurator.artwork.upload.help') : t('configurator.artwork.upload.signIn')}
            </FormHelperText>
          )}
        </Box>

        {errorKey && (
          <Alert
            severity="error"
            onClose={() => {
              setLocalErrorKey(null);
              clearError();
            }}
          >
            {/* i18n-keep cnc:configurator.artwork.upload.errors.unsafeDrawing */}
            {t(`configurator.artwork.upload.errors.${errorKey}`)}
            {errorDetail ? ` (${errorDetail})` : ''}
          </Alert>
        )}

        {artwork.length > 0 && (
          <ArtworkVerdict
            validationOk={validationOk}
            isChecking={isChecking}
            canValidate={canValidate}
            hasCollisions={collisions.length > 0}
          />
        )}
      </Stack>
    </Box>
  );
}

/**
 * One line saying whether the wall will actually take this artwork.
 *
 * "Not checked yet" is its own state rather than being folded into a pass. A
 * signed-out buyer has had nothing verified, and saying so is what makes the
 * sign-in prompt on Buy make sense when they get there.
 */
function ArtworkVerdict({
  validationOk,
  isChecking,
  canValidate,
  hasCollisions,
}: {
  validationOk: boolean | null;
  isChecking: boolean;
  canValidate: boolean;
  hasCollisions: boolean;
}) {
  const { t } = useTranslation('cnc');

  if (isChecking) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          {t('configurator.artwork.checking')}
        </Typography>
      </Stack>
    );
  }

  if (!canValidate) {
    return <Alert severity="info">{t('configurator.artwork.signInToCheck')}</Alert>;
  }

  if (validationOk === true) return <Alert severity="success">{t('configurator.artwork.fits')}</Alert>;
  if (validationOk === false && hasCollisions) return null; // Each card already says what is wrong.
  if (validationOk === false) return <Alert severity="error">{t('configurator.artwork.doesNotFit')}</Alert>;
  return null;
}

function ArtworkItemFields({
  item,
  submittedIndex,
  displayIndex,
  isSubmitted,
  preview,
  rules,
  fonts,
  panels,
  layout,
  collisions,
  onChange,
  onRemove,
  onLocalCollisions,
}: {
  item: CncArtworkDraft;
  submittedIndex: number;
  /** This card's position in the full list, for numbering it while it has no text yet. */
  displayIndex: number;
  isSubmitted: boolean;
  preview: ArtworkPreview | null;
  rules: CncArtworkRules;
  fonts: readonly string[];
  panels: readonly CncLayoutPanel[];
  layout: CncLayoutModel | null;
  collisions: readonly CncArtworkCollision[];
  onChange: (patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
  onRemove: () => void;
  onLocalCollisions: (hasCollisions: boolean) => void;
}) {
  const { t } = useTranslation('cnc');
  const issues = artworkIssues(item, rules);
  const itemCollisions = isSubmitted ? collisions.filter((collision) => collision.artworkIndex === submittedIndex) : [];
  // `submittedIndex` only advances for cards that are ready, so every empty card
  // above the first submitted one would otherwise number itself "1" — the
  // display index is what a buyer actually sees as they add cards.
  const displayNumber = isSubmitted ? submittedIndex + 1 : displayIndex + 1;
  const isUpload = item.kind !== 'text';

  return (
    <Box className={styles.artworkItem}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" className={styles.artworkItemHeader}>
        <Typography variant="body2" fontWeight={themeTokens.typography.fontWeight.semibold}>
          {t('configurator.artwork.itemLabel', { number: displayNumber })}
        </Typography>
        <Button size="small" color="error" onClick={onRemove} sx={{ textTransform: 'none' }}>
          {t('configurator.artwork.remove')}
        </Button>
      </Stack>

      <Stack spacing={2} sx={{ mt: 1 }}>
        {isUpload ? (
          <Stack direction="row" alignItems="center" className={styles.artworkPreviewRow}>
            {preview ? (
              <Box
                component="img"
                src={preview.url}
                alt={t('configurator.artwork.upload.previewAlt')}
                className={styles.artworkPreview}
              />
            ) : null}
            <Typography variant="body2" color="text.secondary">
              {preview ? preview.fileName : t('configurator.artwork.upload.stored')}
            </Typography>
          </Stack>
        ) : (
          <TextField
            label={t('configurator.artwork.text')}
            helperText={t('configurator.artwork.textHelp', { max: rules.maxTextChars })}
            value={item.text}
            onChange={(event) => onChange({ text: event.target.value })}
            error={issues.includes('textTooLong')}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { maxLength: rules.maxTextChars } }}
          />
        )}

        <Box className={styles.optionGrid}>
          {!isUpload && (
            <FormControl fullWidth size="small">
              <InputLabel id={`cnc-artwork-font-${item.id}`}>{t('configurator.artwork.font')}</InputLabel>
              <Select
                labelId={`cnc-artwork-font-${item.id}`}
                label={t('configurator.artwork.font')}
                value={item.font}
                onChange={(event) => onChange({ font: event.target.value })}
              >
                {fonts.map((font) => (
                  <MenuItem key={font} value={font}>
                    {/* i18n-keep cnc:configurator.artwork.fonts.liberation-sans */}
                    {t(`configurator.artwork.fonts.${font}`, { defaultValue: font })}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>{t('configurator.artwork.fontHelp')}</FormHelperText>
            </FormControl>
          )}

          <FormControl fullWidth size="small">
            <InputLabel id={`cnc-artwork-mode-${item.id}`}>{t('configurator.artwork.mode')}</InputLabel>
            <Select
              labelId={`cnc-artwork-mode-${item.id}`}
              label={t('configurator.artwork.mode')}
              value={item.mode}
              onChange={(event) => onChange({ mode: event.target.value as CncArtworkMode })}
            >
              {CNC_ARTWORK_MODES.map((mode) => (
                <MenuItem key={mode} value={mode}>
                  {/* i18n-keep cnc:configurator.artwork.modes.engrave */}
                  {t(`configurator.artwork.modes.${mode}.label`)}
                </MenuItem>
              ))}
            </Select>
            {/* i18n-keep cnc:configurator.artwork.modes.cut_through.help */}
            <FormHelperText>{t(`configurator.artwork.modes.${item.mode}.help`)}</FormHelperText>
          </FormControl>
        </Box>

        <PlacementEditor
          item={item}
          panels={panels}
          panelRects={layout?.panelRects ?? EMPTY_PANEL_RECTS}
          holes={layout?.holes ?? EMPTY_HOLES}
          holePanelIndex={layout?.holePanelIndex ?? EMPTY_HOLE_PANELS}
          seams={layout?.seams ?? EMPTY_SEAMS}
          keepout={layout?.keepout ?? CNC_FALLBACK_KEEPOUT}
          wall={layout?.wall ?? null}
          rules={rules}
          previewUrl={preview?.url ?? null}
          onChange={onChange}
          onLocalCollisions={onLocalCollisions}
        />

        {issues.map((issue) => (
          // i18n-keep cnc:configurator.artwork.issues.textTooLong
          <Alert key={issue} severity="warning">
            {t(`configurator.artwork.issues.${issue}`, {
              min: rules.minWidthMm,
              max: rules.maxWidthMm,
              chars: rules.maxTextChars,
            })}
          </Alert>
        ))}

        {itemCollisions.map((collision, index) => (
          <Alert key={`${collision.kind}-${String(index)}`} severity="error">
            {/* i18n-keep cnc:configurator.artwork.collisions.off_panel */}
            {t(`configurator.artwork.collisions.${collision.kind}`, {
              defaultValue: t('configurator.artwork.collisions.unknown'),
            })}
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}
