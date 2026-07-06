'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MuiTypography from '@mui/material/Typography';

export type GymFormFieldValues = {
  name: string;
  slug?: string;
  description: string;
  address: string;
  website: string;
  contactEmail: string;
  contactPhone: string;
  isPublic: boolean;
};

type GymFormProps = {
  title: string;
  submitLabel: string;
  initialValues: GymFormFieldValues;
  showSlugField?: boolean;
  onSubmit: (values: GymFormFieldValues) => Promise<void>;
  onCancel?: () => void;
};

export default function GymForm({
  title,
  submitLabel,
  initialValues,
  showSlugField = false,
  onSubmit,
  onCancel,
}: GymFormProps) {
  const { t } = useTranslation('boards');
  const [name, setName] = useState(initialValues.name);
  const [slug, setSlug] = useState(initialValues.slug ?? '');
  const [description, setDescription] = useState(initialValues.description);
  const [address, setAddress] = useState(initialValues.address);
  const [website, setWebsite] = useState(initialValues.website);
  const [contactEmail, setContactEmail] = useState(initialValues.contactEmail);
  const [contactPhone, setContactPhone] = useState(initialValues.contactPhone);
  const [isPublic, setIsPublic] = useState(initialValues.isPublic);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await onSubmit({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim(),
        address: address.trim(),
        website: website.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim(),
        isPublic,
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

      <TextField
        label={t('gymForm.fields.address')}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        fullWidth
        size="small"
        placeholder={t('gymForm.placeholders.address')}
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
