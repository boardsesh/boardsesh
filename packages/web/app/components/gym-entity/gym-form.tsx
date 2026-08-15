'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MuiTypography from '@mui/material/Typography';
import MapLocationPicker from '@/app/components/board-entity/map-location-picker';

export type GymFormFieldValues = {
  name: string;
  slug?: string;
  description: string;
  /**
   * Free-text opening hours. Optional because the create flow's CreateGymInput
   * has no hours field — only the edit flow renders it (showHoursField).
   */
  hours?: string;
  address: string;
  website: string;
  contactEmail: string;
  contactPhone: string;
  isPublic: boolean;
  latitude: number | null;
  longitude: number | null;
};

export type GymFormLocationValues = {
  name: string;
  latitude: number | null;
  longitude: number | null;
};

type GymFormProps = {
  title: string;
  submitLabel: string;
  initialValues: GymFormFieldValues;
  showSlugField?: boolean;
  /** Opening hours are edit-only — createGym has no hours field to send them to. */
  showHoursField?: boolean;
  onSubmit: (values: GymFormFieldValues) => Promise<void>;
  onCancel?: () => void;
  /**
   * Optional slot rendered just above the action buttons, fed the live name +
   * coordinates. The create flow uses it to surface "this gym might already
   * exist" dedup suggestions.
   */
  renderSuggestions?: (values: GymFormLocationValues) => React.ReactNode;
  /** Reports whether any field diverges from its initial value. */
  onDirtyChange?: (isDirty: boolean) => void;
};

export default function GymForm({
  title,
  submitLabel,
  initialValues,
  showSlugField = false,
  showHoursField = false,
  onSubmit,
  onCancel,
  renderSuggestions,
  onDirtyChange,
}: GymFormProps) {
  const { t } = useTranslation('boards');
  const [name, setName] = useState(initialValues.name);
  const [slug, setSlug] = useState(initialValues.slug ?? '');
  const [description, setDescription] = useState(initialValues.description);
  const [hours, setHours] = useState(initialValues.hours ?? '');
  const [address, setAddress] = useState(initialValues.address);
  const [website, setWebsite] = useState(initialValues.website);
  const [contactEmail, setContactEmail] = useState(initialValues.contactEmail);
  const [contactPhone, setContactPhone] = useState(initialValues.contactPhone);
  const [isPublic, setIsPublic] = useState(initialValues.isPublic);
  const [latitude, setLatitude] = useState<number | null>(initialValues.latitude);
  const [longitude, setLongitude] = useState<number | null>(initialValues.longitude);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Report unsaved edits so a host (the manage console's Profile tab) can guard
  // tab switches behind a discard confirmation. Report clean on unmount so a
  // confirmed navigation doesn't leave a stale dirty flag.
  const isDirty =
    name !== initialValues.name ||
    slug !== (initialValues.slug ?? '') ||
    description !== initialValues.description ||
    hours !== (initialValues.hours ?? '') ||
    address !== initialValues.address ||
    website !== initialValues.website ||
    contactEmail !== initialValues.contactEmail ||
    contactPhone !== initialValues.contactPhone ||
    isPublic !== initialValues.isPublic ||
    latitude !== initialValues.latitude ||
    longitude !== initialValues.longitude;

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        hours: hours.trim(),
        address: address.trim(),
        website: website.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim(),
        isPublic,
        latitude,
        longitude,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <MuiTypography variant="h6">{title}</MuiTypography>

      <TextField
        label={t('gymForm.fields.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        fullWidth
        size="small"
        placeholder={t('gymForm.placeholders.name')}
        inputProps={{ maxLength: 100 }}
      />

      {showSlugField && (
        <TextField
          label={t('gymForm.fields.slug')}
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          fullWidth
          size="small"
          helperText={`boardsesh.com/gym/${slug || '...'}`}
        />
      )}

      <TextField
        label={t('gymForm.fields.description')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        fullWidth
        size="small"
        multiline
        minRows={2}
        maxRows={4}
        placeholder={t('gymForm.placeholders.description')}
      />

      {showHoursField && (
        <TextField
          label={t('gymForm.fields.hours')}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={6}
          placeholder={t('gymForm.placeholders.hours')}
          helperText={t('gymForm.helpers.hours')}
          // Mirrors GYM_HOURS_MAX_LENGTH on the backend, which is the real gate.
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />
      )}

      <TextField
        label={t('gymForm.fields.address')}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        fullWidth
        size="small"
        placeholder={t('gymForm.placeholders.address')}
      />

      <MapLocationPicker
        latitude={latitude}
        longitude={longitude}
        onChange={(lat, lng) => {
          setLatitude(lat);
          setLongitude(lng);
        }}
      />

      <TextField
        label={t('gymForm.fields.website')}
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        fullWidth
        size="small"
        type="url"
        placeholder={t('gymForm.placeholders.website')}
        helperText={t('gymForm.helpers.website')}
        slotProps={{ htmlInput: { maxLength: 500 } }}
      />

      <TextField
        label={t('gymForm.fields.contactEmail')}
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
        fullWidth
        size="small"
        type="email"
        placeholder={t('gymForm.placeholders.contactEmail')}
      />

      <TextField
        label={t('gymForm.fields.contactPhone')}
        value={contactPhone}
        onChange={(e) => setContactPhone(e.target.value)}
        fullWidth
        size="small"
        placeholder={t('gymForm.placeholders.contactPhone')}
      />

      <FormControlLabel
        control={<Switch checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />}
        label={t('gymForm.fields.isPublic')}
      />

      {renderSuggestions?.({ name: name.trim(), latitude, longitude })}

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 1 }}>
        {onCancel && (
          <MuiButton variant="text" onClick={onCancel} disabled={isSubmitting}>
            {t('gymForm.actions.cancel')}
          </MuiButton>
        )}
        <MuiButton type="submit" variant="contained" disabled={isSubmitting || !name.trim()}>
          {isSubmitting ? <CircularProgress size={20} color="inherit" /> : submitLabel}
        </MuiButton>
      </Box>
    </Box>
  );
}
