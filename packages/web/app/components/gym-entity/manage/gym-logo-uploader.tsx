'use client';

// Gym logo uploader. Downscales client-side to ≤512px, uploads to the
// backend's POST /api/gym-logos (multipart, Bearer-authenticated), then
// persists the returned logoUrl via updateGym. Transparency is preserved:
// png/webp inputs re-encode as PNG (NOT the avatar JPEG-whitening flow, which
// would flatten a transparent brand mark onto a white box).

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import { useEntityMutation } from '@/app/hooks/use-entity-mutation';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { themeTokens } from '@/app/theme/theme-config';
import {
  UPDATE_GYM,
  type UpdateGymMutationResponse,
  type UpdateGymMutationVariables,
} from '@boardsesh/graphql/operations';
import type { Gym } from '@boardsesh/shared-schema';
import {
  GYM_LOGO_ACCEPTED_MIME_TYPES,
  GYM_LOGO_MAX_DIMENSION,
  GYM_LOGO_MAX_INPUT_BYTES,
  GYM_LOGO_MAX_UPLOAD_BYTES,
  resolveLogoEncodingPlan,
  scaleToFit,
  type GymLogoEncodingPlan,
} from './logo-image-utils';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';

/**
 * Downscale + re-encode via canvas per the plan. JPEG output fills white first
 * (JPEG has no alpha channel); PNG output keeps the alpha channel untouched.
 */
async function encodeLogoThroughCanvas(
  file: File,
  plan: Extract<GymLogoEncodingPlan, { kind: 'canvas' }>,
): Promise<File> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { width, height } = scaleToFit(image.naturalWidth, image.naturalHeight, GYM_LOGO_MAX_DIMENSION);
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
            reject(new Error('Logo encoding failed'));
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

type GymLogoUploaderProps = {
  gym: Gym;
  /** Display-resolved current logo URL (absolute), or null when unset. */
  logoDisplayUrl: string | null;
  onGymChange: (gym: Gym) => void;
};

export default function GymLogoUploader({ gym, logoDisplayUrl, onGymChange }: GymLogoUploaderProps) {
  const { t } = useTranslation('kiosk');
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const updateGymMutation = useEntityMutation<UpdateGymMutationResponse, UpdateGymMutationVariables>(UPDATE_GYM, {
    errorMessage: t('branding.logo.saveFailed'),
  });

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-picking the same file after a failure.
    event.target.value = '';
    if (!file) return;

    const plan = resolveLogoEncodingPlan(file.type);
    if (plan === null) {
      showMessage(t('branding.logo.unsupportedType'), 'error');
      return;
    }
    if (file.size > GYM_LOGO_MAX_INPUT_BYTES) {
      showMessage(t('branding.logo.tooLarge'), 'error');
      return;
    }

    setIsUploading(true);
    try {
      const uploadFile = plan.kind === 'canvas' ? await encodeLogoThroughCanvas(file, plan) : file;
      if (uploadFile.size > GYM_LOGO_MAX_UPLOAD_BYTES) {
        // Realistically only reachable for GIF passthrough (animations aren't
        // recompressed) — a ≤512px PNG/JPEG is far below 2MB.
        showMessage(t('branding.logo.uploadTooLarge'), 'error');
        return;
      }

      const backendBaseUrl = getBackendHttpUrl();
      if (!backendBaseUrl || !token) {
        showMessage(t('branding.logo.uploadFailed'), 'error');
        return;
      }

      const formData = new FormData();
      formData.append('logo', uploadFile);
      formData.append('gymUuid', gym.uuid);

      const response = await fetch(`${backendBaseUrl}/api/gym-logos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...webClientIdentityHeaders() },
        body: formData,
      });
      if (!response.ok) {
        // Localized message first; the backend detail (English) rides along as
        // secondary context, mirroring useEntityMutation's server-message style.
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        const localizedMessage = t('branding.logo.uploadFailed');
        showMessage(errorPayload?.error ? `${localizedMessage} (${errorPayload.error})` : localizedMessage, 'error');
        return;
      }

      // Persist the backend-relative path verbatim: no deploy domain frozen
      // into the row. Render sites resolve it via resolveGymLogoDisplayUrl.
      // Runtime-checked — an unexpected body must not store undefined.
      const uploadPayload = (await response.json().catch(() => null)) as { logoUrl?: unknown } | null;
      const logoUrl = typeof uploadPayload?.logoUrl === 'string' ? uploadPayload.logoUrl : null;
      if (logoUrl === null) {
        showMessage(t('branding.logo.uploadFailed'), 'error');
        return;
      }
      const savedGymData = await updateGymMutation.execute({ input: { gymUuid: gym.uuid, logoUrl } });
      if (savedGymData) {
        onGymChange(savedGymData.updateGym);
        showMessage(t('branding.logo.uploaded'), 'success');
      }
    } catch (error) {
      console.error('Gym logo upload failed:', error);
      showMessage(t('branding.logo.uploadFailed'), 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      const clearedGymData = await updateGymMutation.execute({ input: { gymUuid: gym.uuid, logoUrl: null } });
      if (clearedGymData) {
        onGymChange(clearedGymData.updateGym);
        showMessage(t('branding.logo.removed'), 'success');
      }
    } finally {
      setIsRemoving(false);
    }
  };

  const isBusy = isUploading || isRemoving;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box
        sx={{
          width: 72,
          height: 72,
          borderRadius: `${themeTokens.borderRadius.md}px`,
          border: '1px dashed',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {logoDisplayUrl ? (
          <Box
            component="img"
            src={logoDisplayUrl}
            alt={t('branding.logo.currentAlt', { gymName: gym.name })}
            sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <Typography variant="caption" color="text.secondary" align="center" sx={{ px: 0.5 }}>
            {t('branding.logo.emptyPlaceholder')}
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={isUploading ? <CircularProgress size={16} color="inherit" /> : <FileUploadOutlined />}
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            sx={{ textTransform: 'none' }}
          >
            {gym.logoUrl ? t('branding.logo.replace') : t('branding.logo.upload')}
          </Button>
          {gym.logoUrl && (
            <Button
              size="small"
              color="error"
              startIcon={isRemoving ? <CircularProgress size={16} color="inherit" /> : <DeleteOutline />}
              onClick={handleRemove}
              disabled={isBusy}
              sx={{ textTransform: 'none' }}
            >
              {t('branding.logo.remove')}
            </Button>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t('branding.logo.formatsHint')}
        </Typography>
      </Box>

      <Box
        component="input"
        ref={fileInputRef}
        type="file"
        accept={GYM_LOGO_ACCEPTED_MIME_TYPES.join(',')}
        onChange={handleFileSelected}
        sx={{ display: 'none' }}
      />
    </Box>
  );
}
