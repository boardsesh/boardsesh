'use client';

// Gym photo uploader. Downscales client-side to ≤1920px, uploads to the
// backend's POST /api/gym-photos (multipart, Bearer-authenticated), then
// persists the returned photo path via updateGym.
//
// Unlike the logo uploader next door, every failure lands in an inline
// <Alert severity="error"> rather than a snackbar: this sits inside a form the
// owner is already reading, and a photo upload can fail for reasons the owner
// can act on (wrong format, too big) — a toast that scrolls past doesn't tell
// them which.

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import PhotoCameraOutlined from '@mui/icons-material/PhotoCameraOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymPhotoDisplayUrl } from '@/app/lib/gym-logo-display-url';
import { themeTokens } from '@/app/theme/theme-config';
import {
  UPDATE_GYM,
  type UpdateGymMutationResponse,
  type UpdateGymMutationVariables,
} from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import {
  GYM_PHOTO_ACCEPTED_MIME_TYPES,
  GYM_PHOTO_MAX_DIMENSION,
  GYM_PHOTO_MAX_INPUT_BYTES,
  GYM_PHOTO_MAX_UPLOAD_BYTES,
  resolvePhotoEncodingPlan,
  scaleToFit,
  type GymPhotoEncodingPlan,
} from './photo-image-utils';

/**
 * Downscale + re-encode via canvas per the plan. The canvas is filled white
 * before the draw because JPEG has no alpha channel, so a transparent PNG
 * would otherwise come out on a black ground.
 */
async function encodePhotoThroughCanvas(file: File, plan: GymPhotoEncodingPlan): Promise<File> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { width, height } = scaleToFit(image.naturalWidth, image.naturalHeight, GYM_PHOTO_MAX_DIMENSION);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas not supported'));
        return;
      }

      if (plan.fillWhite) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Photo encoding failed'));
            return;
          }
          resolve(new File([blob], plan.outputFileName, { type: plan.outputMimeType }));
        },
        plan.outputMimeType,
        plan.quality,
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };

    image.src = objectUrl;
  });
}

type GymPhotoUploaderProps = {
  gym: Gym;
  onGymChange: (gym: Gym) => void;
};

export default function GymPhotoUploader({ gym, onGymChange }: GymPhotoUploaderProps) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const photoDisplayUrl = resolveGymPhotoDisplayUrl(gym.imageUrl ?? null, getBackendHttpUrl());

  // The mutation's own snackbar is suppressed: this component owns its error
  // surface, and two competing messages for one failure is worse than one.
  const handleMutationError = useCallback(
    (_error: unknown, serverMessage: string | null) => {
      setErrorText(serverMessage ?? t('manage.profile.photo.saveFailed'));
    },
    [t],
  );

  const updateGymMutation = useEntityMutation<UpdateGymMutationResponse, UpdateGymMutationVariables>(UPDATE_GYM, {
    errorMessage: t('manage.profile.photo.saveFailed'),
    onError: handleMutationError,
  });

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-picking the same file after a failure.
    event.target.value = '';
    if (!file) return;

    setErrorText(null);

    const plan = resolvePhotoEncodingPlan(file.type);
    if (plan === null) {
      setErrorText(t('manage.profile.photo.unsupportedType'));
      return;
    }
    if (file.size > GYM_PHOTO_MAX_INPUT_BYTES) {
      setErrorText(t('manage.profile.photo.tooLarge'));
      return;
    }

    setIsUploading(true);
    try {
      const uploadFile = await encodePhotoThroughCanvas(file, plan);
      if (uploadFile.size > GYM_PHOTO_MAX_UPLOAD_BYTES) {
        setErrorText(t('manage.profile.photo.uploadTooLarge'));
        return;
      }

      const backendBaseUrl = getBackendHttpUrl();
      if (!backendBaseUrl || !token) {
        setErrorText(t('manage.profile.photo.uploadFailed'));
        return;
      }

      const formData = new FormData();
      formData.append('photo', uploadFile);
      formData.append('gymUuid', gym.uuid);

      const response = await fetch(`${backendBaseUrl}/api/gym-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        // Localized message first; the backend detail (English) rides along as
        // secondary context, mirroring useEntityMutation's server-message style.
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        const localizedMessage = t('manage.profile.photo.uploadFailed');
        setErrorText(errorPayload?.error ? `${localizedMessage} (${errorPayload.error})` : localizedMessage);
        return;
      }

      // Persist the backend-relative path verbatim: no deploy domain frozen
      // into the row. Render sites resolve it via resolveGymPhotoDisplayUrl.
      // Runtime-checked — an unexpected body must not store undefined.
      const uploadPayload = (await response.json().catch(() => null)) as { photoUrl?: unknown } | null;
      const photoUrl = typeof uploadPayload?.photoUrl === 'string' ? uploadPayload.photoUrl : null;
      if (photoUrl === null) {
        setErrorText(t('manage.profile.photo.uploadFailed'));
        return;
      }
      const savedGymData = await updateGymMutation.execute({ input: { gymUuid: gym.uuid, imageUrl: photoUrl } });
      if (savedGymData) {
        onGymChange(savedGymData.updateGym);
      }
    } catch (error) {
      console.error('Gym photo upload failed:', error);
      setErrorText(t('manage.profile.photo.uploadFailed'));
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemove = async () => {
    setErrorText(null);
    setIsRemoving(true);
    try {
      // Null the column FIRST. An orphaned object is a few hundred KB we can
      // sweep later; a row still pointing at a deleted object is a broken
      // image on the public gym page.
      const clearedGymData = await updateGymMutation.execute({ input: { gymUuid: gym.uuid, imageUrl: null } });
      if (!clearedGymData) return;
      onGymChange(clearedGymData.updateGym);

      const backendBaseUrl = getBackendHttpUrl();
      if (!backendBaseUrl || !token) return;
      // Best-effort object cleanup — the photo is already gone from the page,
      // so a failure here is not the owner's problem.
      try {
        await fetch(`${backendBaseUrl}/api/gym-photos?gymUuid=${encodeURIComponent(gym.uuid)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (cleanupError) {
        console.error('Gym photo object cleanup failed:', cleanupError);
      }
    } finally {
      setIsRemoving(false);
    }
  };

  const isBusy = isUploading || isRemoving;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
          {t('manage.profile.photo.heading')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('manage.profile.photo.description')}
        </Typography>
      </Box>

      <Box
        sx={{
          width: '100%',
          maxWidth: 480,
          aspectRatio: '16 / 9',
          borderRadius: `${themeTokens.borderRadius.md}px`,
          border: '1px dashed',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {photoDisplayUrl ? (
          <Box
            component="img"
            src={photoDisplayUrl}
            alt={t('manage.profile.photo.currentAlt', { gymName: gym.name })}
            sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ px: 2 }}>
            {t('manage.profile.photo.emptyPlaceholder')}
          </Typography>
        )}
      </Box>

      {errorText && <Alert severity="error">{errorText}</Alert>}

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={isUploading ? <CircularProgress size={16} color="inherit" /> : <PhotoCameraOutlined />}
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          sx={{ textTransform: 'none' }}
        >
          {gym.imageUrl ? t('manage.profile.photo.replace') : t('manage.profile.photo.upload')}
        </Button>
        {gym.imageUrl && (
          <Button
            size="small"
            color="error"
            startIcon={isRemoving ? <CircularProgress size={16} color="inherit" /> : <DeleteOutline />}
            onClick={handleRemove}
            disabled={isBusy}
            sx={{ textTransform: 'none' }}
          >
            {t('manage.profile.photo.remove')}
          </Button>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary">
        {t('manage.profile.photo.formatsHint')}
      </Typography>

      <Box
        component="input"
        ref={fileInputRef}
        type="file"
        accept={GYM_PHOTO_ACCEPTED_MIME_TYPES.join(',')}
        onChange={handleFileSelected}
        sx={{ display: 'none' }}
      />
    </Box>
  );
}
