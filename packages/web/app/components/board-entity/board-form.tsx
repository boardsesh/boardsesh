'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import MuiTypography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import ListItemText from '@mui/material/ListItemText';
import Check from '@mui/icons-material/Check';
import MuiSelect, { type SelectChangeEvent } from '@mui/material/Select';
import { FormShell, FormSection, FormField, FormActions, FormSwitchRow } from '@/app/components/form';
import MapLocationPicker from './map-location-picker';
import type { BoardEditPermissions } from './board-edit-input';

/** Submit-affordance state the form reports up so a drawer header can host the action. */
export type BoardFormSubmitState = {
  submitLabel: React.ReactNode;
  submitting: boolean;
  canSubmit: boolean;
};

export type BoardFormFieldValues = {
  name: string;
  slug?: string;
  description: string;
  locationName: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  isOwned: boolean;
  angle?: number;
  isAngleAdjustable?: boolean;
  hasLeds?: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  serialNumber?: string;
};

type BoardFormProps = {
  /** Surface title. Pass an empty string when the host chrome already titles the surface. */
  title: string;
  /** Submit button label */
  submitLabel: string;
  /** Initial field values */
  initialValues: BoardFormFieldValues;
  /** Whether to show the slug field (edit mode only) */
  showSlugField?: boolean;
  /** Slug helper text prefix */
  slugHelperPrefix?: string;
  /** Placeholder for the name field */
  namePlaceholder?: string;
  /** Placeholder for the description field */
  descriptionPlaceholder?: string;
  /** Placeholder for the location field */
  locationPlaceholder?: string;
  /** Available angles for this board type */
  availableAngles?: number[];
  /** Config editing: show layout/size/set selectors */
  configEditable?: {
    boardType: string;
    layouts: { id: number; name: string }[];
    sizes: Record<string, { id: number; name: string; description: string }[]>;
    sets: Record<string, { id: number; name: string }[]>;
  };
  /** Called with form values on submit. Should throw on failure. */
  onSubmit: (values: BoardFormFieldValues) => Promise<void>;
  /** Optional cancel handler */
  onCancel?: () => void;
  /**
   * When hosted in a drawer, the id wired onto the `<form>` so a header-hosted
   * submit button can target it via `form={formId}`.
   */
  formId?: string;
  /**
   * When provided, the form reports its submit affordance here (for a header
   * action bar) instead of rendering the inline submit/cancel buttons. Bottom
   * drawers carry actions in the header because the iOS keyboard buries a
   * footer — see docs/mobile-sheets-vs-routes.md.
   *
   * Must be referentially stable (a setState or `useCallback`) — it sits in the
   * report effect's deps, so a per-render identity re-fires the effect every render.
   */
  onSubmitStateChange?: (state: BoardFormSubmitState) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  /** Editing requires an actual change; creation keeps its existing submit behaviour. */
  requireChanges?: boolean;
  permissions?: BoardEditPermissions;
  saving?: boolean;
};

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const SERIAL_MAX_LENGTH = 100;

/**
 * Shared form component for creating and editing boards.
 * Consolidates the duplicated form structure between CreateBoardForm and EditBoardForm.
 */
export default function BoardForm({
  title,
  submitLabel,
  initialValues,
  showSlugField = false,
  slugHelperPrefix = 'boardsesh.com/b/',
  namePlaceholder,
  descriptionPlaceholder,
  locationPlaceholder,
  availableAngles,
  configEditable,
  onSubmit,
  onCancel,
  formId,
  onSubmitStateChange,
  onDirtyChange,
  requireChanges = false,
  permissions,
  saving = false,
}: BoardFormProps) {
  const { t } = useTranslation('boards');
  const resolvedDescriptionPlaceholder = descriptionPlaceholder ?? t('boardForm.placeholders.description');
  const [name, setName] = useState(initialValues.name);
  const [slug, setSlug] = useState(initialValues.slug ?? '');
  const [description, setDescription] = useState(initialValues.description);
  const [locationName, setLocationName] = useState(initialValues.locationName);
  const [latitude, setLatitude] = useState<number | null>(initialValues.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(initialValues.longitude ?? null);
  const [isPublic, setIsPublic] = useState(initialValues.isPublic);
  const [isUnlisted, setIsUnlisted] = useState(initialValues.isUnlisted);
  const [hideLocation, setHideLocation] = useState(initialValues.hideLocation);
  const [isOwned, setIsOwned] = useState(initialValues.isOwned);
  const [angle, setAngle] = useState(initialValues.angle ?? 40);
  const [isAngleAdjustable, setIsAngleAdjustable] = useState(initialValues.isAngleAdjustable ?? true);
  // Optional on the wire on purpose: a board fetched without the field must read
  // as "has LEDs", never as off.
  const [hasLeds, setHasLeds] = useState(initialValues.hasLeds ?? true);
  const [serialNumber, setSerialNumber] = useState(initialValues.serialNumber ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isBusy = isSubmitting || saving;
  const submittingRef = useRef(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);

  // Config editing state
  const [layoutId, setLayoutId] = useState(initialValues.layoutId);
  const [sizeId, setSizeId] = useState(initialValues.sizeId);
  const [selectedSets, setSelectedSets] = useState<number[]>(
    initialValues.setIds ? initialValues.setIds.split(',').map(Number) : [],
  );

  const availableSizes =
    configEditable && layoutId ? (configEditable.sizes[`${configEditable.boardType}-${layoutId}`] ?? []) : [];
  const availableSets =
    configEditable && layoutId && sizeId
      ? (configEditable.sets[`${configEditable.boardType}-${layoutId}-${sizeId}`] ?? [])
      : [];

  const normalizedSelectedSets = [...selectedSets].sort((first, second) => first - second).join(',');
  const initialSets = (initialValues.setIds ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number)
    .sort((first, second) => first - second)
    .join(',');
  const isDirty =
    name !== initialValues.name ||
    slug !== (initialValues.slug ?? '') ||
    description !== initialValues.description ||
    locationName !== initialValues.locationName ||
    latitude !== (initialValues.latitude ?? null) ||
    longitude !== (initialValues.longitude ?? null) ||
    isPublic !== initialValues.isPublic ||
    isUnlisted !== initialValues.isUnlisted ||
    hideLocation !== initialValues.hideLocation ||
    isOwned !== initialValues.isOwned ||
    angle !== (initialValues.angle ?? 40) ||
    isAngleAdjustable !== (initialValues.isAngleAdjustable ?? true) ||
    hasLeds !== (initialValues.hasLeds ?? true) ||
    serialNumber !== (initialValues.serialNumber ?? '') ||
    layoutId !== initialValues.layoutId ||
    sizeId !== initialValues.sizeId ||
    normalizedSelectedSets !== initialSets;
  const configComplete = !configEditable || Boolean(layoutId && sizeId && selectedSets.length > 0);
  const canSubmit = Boolean(name.trim()) && configComplete && (!requireChanges || isDirty);
  const hostsActionsExternally = onSubmitStateChange != null;

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!requireChanges || (!isDirty && !isBusy)) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [requireChanges, isDirty, isBusy]);

  const handleCancel = () => {
    if (submittingRef.current || saving) return;
    if (requireChanges && isDirty) setDiscardDialogOpen(true);
    else onCancel?.();
  };

  // Report the submit affordance to a header-hosted action bar. Fires only when
  // the label / saving / enabled state actually changes.
  useEffect(() => {
    if (!onSubmitStateChange) return;
    onSubmitStateChange({ submitLabel, submitting: isBusy, canSubmit });
  }, [onSubmitStateChange, submitLabel, isBusy, canSubmit]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || saving || !canSubmit) return;
    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        locationName: locationName.trim(),
        latitude,
        longitude,
        isPublic,
        isUnlisted,
        hideLocation,
        isOwned,
        angle,
        isAngleAdjustable,
        hasLeds,
        ...(configEditable
          ? {
              layoutId,
              sizeId,
              setIds: selectedSets.length > 0 ? normalizedSelectedSets : undefined,
            }
          : {}),
        serialNumber: serialNumber.trim() || undefined,
      });
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <FormShell id={formId} onSubmit={handleSubmit} maxWidth={640}>
        <Box
          component="fieldset"
          disabled={isBusy}
          inert={isBusy ? true : undefined}
          sx={{ border: 0, p: 0, m: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
        >
          {title ? (
            <MuiTypography variant="h6" component="h2">
              {title}
            </MuiTypography>
          ) : null}

          <FormSection title={t('boardForm.sections.details')}>
            <FormField
              label={t('boardForm.fields.name')}
              required
              counter={{ value: name.length, max: NAME_MAX_LENGTH }}
            >
              {(field) => (
                <TextField
                  id={field.id}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  fullWidth
                  size="small"
                  placeholder={namePlaceholder}
                  error={Boolean(field.error)}
                  slotProps={{ htmlInput: { maxLength: NAME_MAX_LENGTH, 'aria-describedby': field.describedBy } }}
                />
              )}
            </FormField>

            {showSlugField && (
              <FormField label={t('boardForm.fields.slug')} helper={`${slugHelperPrefix}${slug || '...'}`}>
                {(field) => (
                  <TextField
                    id={field.id}
                    value={slug}
                    onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    fullWidth
                    size="small"
                    slotProps={{ htmlInput: { 'aria-describedby': field.describedBy } }}
                  />
                )}
              </FormField>
            )}

            <FormField
              label={t('boardForm.fields.description')}
              counter={{ value: description.length, max: DESCRIPTION_MAX_LENGTH }}
            >
              {(field) => (
                <TextField
                  id={field.id}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  fullWidth
                  size="small"
                  multiline
                  minRows={2}
                  maxRows={4}
                  placeholder={resolvedDescriptionPlaceholder}
                  slotProps={{
                    htmlInput: { maxLength: DESCRIPTION_MAX_LENGTH, 'aria-describedby': field.describedBy },
                  }}
                />
              )}
            </FormField>
          </FormSection>

          <FormSection title={t('boardForm.sections.location')}>
            <FormField label={t('boardForm.fields.location')}>
              {(field) => (
                <TextField
                  id={field.id}
                  value={locationName}
                  onChange={(event) => setLocationName(event.target.value)}
                  fullWidth
                  size="small"
                  placeholder={locationPlaceholder}
                  slotProps={{ htmlInput: { 'aria-describedby': field.describedBy } }}
                />
              )}
            </FormField>

            <MapLocationPicker
              latitude={latitude}
              longitude={longitude}
              onChange={(lat, lng) => {
                setLatitude(lat);
                setLongitude(lng);
              }}
            />
          </FormSection>

          <FormSection title={t('boardForm.sections.setup')}>
            {permissions?.setup === false && <Alert severity="info">{t('mobile.edit.configLockedHintSpray')}</Alert>}
            {configEditable && (
              <>
                <Alert severity="info">{t('boardForm.alerts.configEditable')}</Alert>

                <FormField label={t('boardForm.fields.layout')}>
                  {(field) => (
                    <MuiSelect
                      labelId={field.labelId}
                      id={field.id}
                      value={layoutId ?? ''}
                      displayEmpty
                      fullWidth
                      size="small"
                      error={Boolean(field.error)}
                      onChange={(event: SelectChangeEvent<number | string>) => {
                        const newLayout = event.target.value as number;
                        setLayoutId(newLayout);
                        // Reset dependent fields
                        const newSizes = configEditable.sizes[`${configEditable.boardType}-${newLayout}`] ?? [];
                        setSizeId(newSizes.length > 0 ? newSizes[0].id : undefined);
                        setSelectedSets([]);
                      }}
                    >
                      <MenuItem value="" disabled>
                        {t('boardForm.placeholders.select')}
                      </MenuItem>
                      {configEditable.layouts.map(({ id, name: layoutName }) => (
                        <MenuItem key={id} value={id}>
                          {layoutName}
                        </MenuItem>
                      ))}
                    </MuiSelect>
                  )}
                </FormField>

                {availableSizes.length > 0 && (
                  <FormField label={t('boardForm.fields.size')}>
                    {(field) => (
                      <MuiSelect
                        labelId={field.labelId}
                        id={field.id}
                        value={sizeId ?? ''}
                        displayEmpty
                        fullWidth
                        size="small"
                        error={Boolean(field.error)}
                        onChange={(event: SelectChangeEvent<number | string>) => {
                          setSizeId(event.target.value as number);
                          setSelectedSets([]);
                        }}
                      >
                        <MenuItem value="" disabled>
                          {t('boardForm.placeholders.select')}
                        </MenuItem>
                        {availableSizes.map(({ id, name: sizeName, description: sizeDesc }) => (
                          <MenuItem key={id} value={id}>{`${sizeName} ${sizeDesc}`}</MenuItem>
                        ))}
                      </MuiSelect>
                    )}
                  </FormField>
                )}

                {availableSets.length > 0 && (
                  <FormField label={t('boardForm.fields.holdSets')}>
                    {(field) => (
                      <MuiSelect
                        labelId={field.labelId}
                        id={field.id}
                        multiple
                        value={selectedSets}
                        fullWidth
                        size="small"
                        error={Boolean(field.error)}
                        onChange={(event) => {
                          const selected = event.target.value as unknown as number[];
                          setSelectedSets(selected);
                        }}
                        renderValue={() =>
                          availableSets
                            .filter((set) => selectedSets.includes(set.id))
                            .map((set) => set.name)
                            .join(', ')
                        }
                      >
                        {availableSets.map(({ id, name: setName }) => (
                          <MenuItem
                            key={id}
                            value={id}
                            sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}
                          >
                            <ListItemText
                              primary={setName}
                              primaryTypographyProps={{
                                color: selectedSets.includes(id) ? 'text.primary' : 'text.secondary',
                              }}
                            />
                            {selectedSets.includes(id) && (
                              <Check fontSize="small" sx={{ color: 'primary.main', flexShrink: 0 }} />
                            )}
                          </MenuItem>
                        ))}
                      </MuiSelect>
                    )}
                  </FormField>
                )}
              </>
            )}

            {/* Above the serial, in Setup rather than Visibility: both rows describe
            the LED hardware on the wall, and mobile reads in this same order. */}
            <FormSwitchRow
              label={t('boardForm.fields.hasLeds')}
              description={t('boardForm.helperText.hasLeds')}
              checked={hasLeds}
              onChange={setHasLeds}
              disabled={permissions?.setup === false}
            />

            {permissions?.credentials === false ? (
              permissions.setup !== false ? (
                <MuiTypography variant="body2" color="text.secondary">
                  {t('boardForm.helperText.ownerOnlyCredentials')}
                </MuiTypography>
              ) : null
            ) : (
              <FormField label={t('boardForm.fields.serialNumber')}>
                {(field) => (
                  <TextField
                    id={field.id}
                    value={serialNumber}
                    onChange={(event) => setSerialNumber(event.target.value)}
                    fullWidth
                    size="small"
                    placeholder={t('boardForm.placeholders.serialNumber')}
                    slotProps={{ htmlInput: { maxLength: SERIAL_MAX_LENGTH, 'aria-describedby': field.describedBy } }}
                  />
                )}
              </FormField>
            )}

            {availableAngles && availableAngles.length > 0 && (
              <FormField label={t('boardForm.fields.defaultAngle')}>
                {(field) => (
                  <MuiSelect
                    labelId={field.labelId}
                    id={field.id}
                    value={angle}
                    fullWidth
                    size="small"
                    error={Boolean(field.error)}
                    disabled={permissions?.angle === false}
                    onChange={(event: SelectChangeEvent<number | string>) => setAngle(Number(event.target.value))}
                  >
                    {availableAngles.map((availableAngle) => (
                      <MenuItem key={availableAngle} value={availableAngle}>
                        {availableAngle}°
                      </MenuItem>
                    ))}
                  </MuiSelect>
                )}
              </FormField>
            )}

            <FormSwitchRow
              label={t('boardForm.fields.angleAdjustable')}
              checked={isAngleAdjustable}
              onChange={setIsAngleAdjustable}
              disabled={permissions?.setup === false}
            />
          </FormSection>

          <FormSection title={t('boardForm.sections.visibility')}>
            {permissions?.privacy === false && permissions.setup !== false && (
              <MuiTypography variant="body2" color="text.secondary">
                {t('boardForm.helperText.ownerOnlyPrivacy')}
              </MuiTypography>
            )}
            <FormSwitchRow
              label={t('boardForm.fields.isPublic')}
              checked={isPublic}
              onChange={setIsPublic}
              disabled={permissions?.privacy === false}
            />
            <FormSwitchRow
              label={t('boardForm.fields.unlisted')}
              description={t('boardForm.helperText.unlisted')}
              checked={isUnlisted}
              onChange={setIsUnlisted}
              disabled={permissions?.privacy === false}
            />
            <FormSwitchRow
              label={t('boardForm.fields.hideLocation')}
              description={t('boardForm.helperText.hideLocation')}
              checked={hideLocation}
              onChange={setHideLocation}
              disabled={permissions?.privacy === false}
            />
            <FormSwitchRow label={t('boardForm.fields.isOwned')} checked={isOwned} onChange={setIsOwned} />
          </FormSection>

          {!hostsActionsExternally && (
            <FormActions
              submitLabel={submitLabel}
              submitting={isBusy}
              disabled={!canSubmit}
              onCancel={onCancel ? handleCancel : undefined}
              layout="inline"
            />
          )}
        </Box>
      </FormShell>
      <Dialog open={discardDialogOpen} onClose={() => setDiscardDialogOpen(false)}>
        <DialogTitle>{t('boardForm.edit.discardTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('boardForm.edit.discardBody')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardDialogOpen(false)}>{t('boardForm.edit.keepEditing')}</Button>
          <Button
            onClick={() => {
              setDiscardDialogOpen(false);
              onCancel?.();
            }}
            color="error"
          >
            {t('boardForm.edit.discard')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
