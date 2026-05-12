'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import MuiAvatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import UploadOutlined from '@mui/icons-material/UploadOutlined';
import Instagram from '@mui/icons-material/Instagram';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import ChevronRightOutlined from '@mui/icons-material/ChevronRightOutlined';
import CookieOutlined from '@mui/icons-material/CookieOutlined';
import { useSession } from 'next-auth/react';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import AuroraCredentialsSection from '@/app/components/settings/aurora-credentials-section';
import ControllersSection from '@/app/components/settings/controllers-section';
import DeleteAccountSection from '@/app/components/settings/delete-account-section';
import SetPasswordSection from '@/app/components/settings/set-password-section';
import LocaleLink from '@/app/components/i18n/locale-link';
import { ConsentDialog } from '@/app/components/consent';
import BackButton from '@/app/components/back-button';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { usePartyProfile } from '@/app/components/party-manager/party-profile-context';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import { useHealthKitAutoSync } from '@/app/hooks/use-healthkit-sync';
import { isHealthKitAvailable } from '@/app/lib/healthkit/healthkit-bridge';

const MAX_INPUT_SIZE = 10 * 1024 * 1024; // 10MB input ceiling before compression
const MAX_DIMENSION = 1024; // resize longest side to ≤ 1024 px
const COMPRESSION_QUALITY = 0.85;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width >= height) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }

      // Fill white before drawing so transparent areas become white, not black,
      // when encoding as JPEG (which has no alpha channel).
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Compression failed'));
            return;
          }
          resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
        },
        'image/jpeg',
        COMPRESSION_QUALITY,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };

    img.src = objectUrl;
  });
}

type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  hasPassword: boolean;
  linkedProviders: string[];
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
    instagramUrl: string | null;
  } | null;
};

export default function SettingsPageContent() {
  const { data: session, status } = useSession();
  const router = useLocaleRouter();
  const { t, i18n } = useTranslation('settings');
  const { t: tConsent } = useTranslation('consent');
  const activeLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  const [formValues, setFormValues] = useState({ displayName: '', instagramUrl: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const { token: authToken } = useWsAuthToken();
  const { refreshProfile: refreshPartyProfile } = usePartyProfile();
  const { showMessage } = useSnackbar();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { gradeFormat, setGradeFormat, loaded: gradeFormatLoaded } = useGradeFormat();
  const {
    enabled: healthKitAutoSync,
    loaded: healthKitAutoSyncLoaded,
    setEnabled: setHealthKitAutoSyncEnabled,
  } = useHealthKitAutoSync();
  const [healthKitAvailable, setHealthKitAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void isHealthKitAvailable().then((available) => {
      if (!cancelled) setHealthKitAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Redirect unauthenticated users to login with a return URL
  useEffect(() => {
    if (status === 'unauthenticated') {
      const callback = encodeURIComponent(localeHref('/settings', activeLocale));
      router.push(`/auth/login?callbackUrl=${callback}`);
    }
  }, [status, router, activeLocale]);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch('/api/internal/profile');
      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }
      const data = await response.json();
      setProfile(data);
      setFormValues({
        displayName: data.profile?.displayName || data.name || '',
        instagramUrl: data.profile?.instagramUrl || '',
      });
      setPreviewUrl(data.profile?.avatarUrl || data.image || undefined);
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      showMessage(t('loading.profileError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showMessage, t]);

  // Fetch profile on mount
  useEffect(() => {
    if (status === 'authenticated') {
      void fetchProfile();
    }
  }, [status, fetchProfile]);

  // Clean up preview URL when component unmounts
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleFileSelect = async (file: File): Promise<void> => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      showMessage(t('profile.validation.invalidImageType'), 'error');
      return;
    }

    if (file.size > MAX_INPUT_SIZE) {
      showMessage(t('profile.validation.imageTooLarge'), 'error');
      return;
    }

    // Show preview immediately with the original file
    const objectUrl = URL.createObjectURL(file);
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(objectUrl);

    try {
      const compressed = await compressImage(file);
      setSelectedFile(compressed);
    } catch (err) {
      console.error('Image compression failed:', err);
      if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(undefined);
      showMessage(t('profile.validation.compressionFailed'), 'error');
    }
  };

  const handleRemoveAvatar = () => {
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(undefined);
    setSelectedFile(null);
  };

  const handleSubmit = async () => {
    try {
      // Inline validation
      const values = { ...formValues };
      if (values.displayName && values.displayName.length > 100) {
        showMessage(t('profile.validation.displayNameTooLong'), 'error');
        return;
      }
      if (
        values.instagramUrl &&
        !/^(https?:\/\/)?(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/.test(values.instagramUrl)
      ) {
        showMessage(t('profile.validation.invalidInstagramUrl'), 'error');
        return;
      }

      setSaving(true);

      let avatarUrl = profile?.profile?.avatarUrl || profile?.image || null;

      // Upload avatar if there's a new file
      if (selectedFile) {
        setUploading(true);
        try {
          const backendUrl = getBackendHttpUrl();
          if (!backendUrl) {
            throw new Error('Backend URL not configured');
          }

          if (!authToken) {
            throw new Error('Authentication required for avatar upload');
          }

          if (!profile?.id) {
            throw new Error('User profile not loaded');
          }

          const formData = new FormData();
          formData.append('avatar', selectedFile);
          formData.append('userId', profile.id);

          const uploadResponse = await fetch(`${backendUrl}/api/avatars`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
            body: formData,
          });

          if (uploadResponse.ok) {
            const uploadData = await uploadResponse.json();
            // The backend returns a relative URL, need to make it absolute
            avatarUrl = uploadData.avatarUrl.startsWith('/')
              ? `${backendUrl}${uploadData.avatarUrl}`
              : uploadData.avatarUrl;
          } else {
            const errorData = await uploadResponse.json().catch(() => ({}));
            showMessage(errorData.error || t('profile.avatarUploadFailed'), 'warning');
          }
        } catch (error) {
          console.error('Avatar upload failed:', error);
          showMessage(error instanceof Error ? error.message : t('profile.avatarUploadFailed'), 'warning');
        } finally {
          setUploading(false);
        }
      }

      // Update profile
      const response = await fetch('/api/internal/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          displayName: values.displayName?.trim() || null,
          avatarUrl,
          instagramUrl: values.instagramUrl?.trim() || null,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('profile.saveError'));
      }

      showMessage(t('profile.saved'), 'success');
      setSelectedFile(null);
      // Refresh profile locally and in context (so queue items show updated avatar)
      await fetchProfile();
      await refreshPartyProfile();
    } catch (error) {
      console.error('Failed to save settings:', error);
      showMessage(error instanceof Error ? error.message : t('profile.saveError'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const isSaving = saving || uploading;

  if (status === 'loading' || loading) {
    return (
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
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
          }}
        >
          <CircularProgress size={48} />
        </Box>
      </Box>
    );
  }

  if (status === 'unauthenticated') {
    return null;
  }

  return (
    // Page-level translate="no" was removed because it blocked browser
    // translation of every static UI label on this page. The error boundary
    // (app/error.tsx) auto-recovers from any residual translator-DOM
    // NotFoundError (issue #2064).
    <Box
      sx={{
        minHeight: '100vh',
        paddingTop: 'var(--global-header-height)',
        background: 'var(--semantic-background)',
      }}
    >
      <Box
        component="header"
        sx={{
          background: 'var(--semantic-surface)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          boxShadow: 'var(--shadow-xs)',
          height: 64,
        }}
      >
        <BackButton />
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('title')}
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          padding: '24px',
          paddingBottom: 'var(--bottom-bar-height)',
          maxWidth: 600,
          margin: '0 auto',
          width: '100%',
        }}
      >
        <Card>
          <CardContent>
            <Typography variant="h5">{t('profile.title')}</Typography>
            <Typography
              variant="body2"
              component="span"
              color="text.secondary"
              sx={{ display: 'block', marginBottom: 3 }}
            >
              {t('profile.subtitle')}
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                  {t('profile.avatar.label')}
                </Typography>
                <Stack spacing={1} alignItems="center" sx={{ width: '100%' }}>
                  <MuiAvatar sx={{ width: 96, height: 96 }} src={previewUrl ?? undefined}>
                    {!previewUrl && <PersonOutlined />}
                  </MuiAvatar>
                  <Stack direction="row" spacing={1}>
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept={ALLOWED_TYPES.join(',')}
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) await handleFileSelect(file);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outlined"
                      startIcon={uploading ? <CircularProgress size={16} /> : <UploadOutlined />}
                      disabled={isSaving}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {previewUrl ? t('profile.avatar.change') : t('profile.avatar.upload')}
                    </Button>
                    {previewUrl && (
                      <Button variant="outlined" onClick={handleRemoveAvatar} disabled={isSaving}>
                        {t('profile.avatar.remove')}
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12 }}>
                    {t('profile.avatar.hint')}
                  </Typography>
                </Stack>
              </Box>

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                  {t('profile.displayName.label')}
                </Typography>
                <TextField
                  placeholder={t('profile.displayName.placeholder')}
                  variant="outlined"
                  size="small"
                  fullWidth
                  value={formValues.displayName}
                  onChange={(e) => setFormValues((prev) => ({ ...prev, displayName: e.target.value }))}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <PersonOutlined />
                        </InputAdornment>
                      ),
                    },
                  }}
                  inputProps={{ maxLength: 100 }}
                />
              </Box>

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                  {t('profile.instagram.label')}
                </Typography>
                <TextField
                  placeholder={t('profile.instagram.placeholder')}
                  variant="outlined"
                  size="small"
                  fullWidth
                  value={formValues.instagramUrl}
                  onChange={(e) => setFormValues((prev) => ({ ...prev, instagramUrl: e.target.value }))}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <Instagram />
                        </InputAdornment>
                      ),
                    },
                  }}
                />
              </Box>

              <MuiDivider sx={{ my: 2 }} />

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                  {t('profile.email.label')}
                </Typography>
                <TextField
                  value={profile?.email || session?.user?.email || ''}
                  disabled
                  variant="outlined"
                  size="small"
                  fullWidth
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <PersonOutlined />
                        </InputAdornment>
                      ),
                    },
                  }}
                />
                <Typography
                  variant="body2"
                  component="span"
                  color="text.secondary"
                  sx={{ fontSize: 12, marginTop: 0.5, display: 'block' }}
                >
                  {t('profile.email.help')}
                </Typography>
              </Box>

              <Box sx={{ mt: 3 }}>
                <Button
                  variant="contained"
                  onClick={handleSubmit}
                  disabled={isSaving}
                  startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
                  fullWidth
                >
                  {t('profile.save')}
                </Button>
              </Box>
            </Box>
          </CardContent>
        </Card>

        <MuiDivider sx={{ my: 2 }} />

        <Card>
          <CardContent>
            <Typography variant="h5">{t('preferences.title')}</Typography>
            <Typography
              variant="body2"
              component="span"
              color="text.secondary"
              sx={{ display: 'block', marginBottom: 3 }}
            >
              {t('preferences.subtitle')}
            </Typography>

            <Box>
              <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                {t('preferences.gradeFormat.label')}
              </Typography>
              <ToggleButtonGroup
                value={gradeFormat}
                exclusive
                onChange={(_e, newFormat) => {
                  if (newFormat !== null) {
                    void setGradeFormat(newFormat);
                  }
                }}
                disabled={!gradeFormatLoaded}
                size="small"
                fullWidth
              >
                <ToggleButton value="v-grade">{t('preferences.gradeFormat.vGrade')}</ToggleButton>
                <ToggleButton value="font">{t('preferences.gradeFormat.font')}</ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {healthKitAvailable && (
              <Box sx={{ mt: 3 }}>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                  {t('preferences.appleHealth.label')}
                </Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={healthKitAutoSync}
                      onChange={(e) => void setHealthKitAutoSyncEnabled(e.target.checked)}
                      disabled={!healthKitAutoSyncLoaded}
                    />
                  }
                  label={t('preferences.appleHealth.switchLabel')}
                />
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
                  {t('preferences.appleHealth.subtitle')}
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>

        <MuiDivider sx={{ my: 2 }} />

        <SetPasswordSection
          hasPassword={profile?.hasPassword ?? false}
          userEmail={profile?.email || session?.user?.email || ''}
          linkedProviders={profile?.linkedProviders ?? []}
          onPasswordSet={fetchProfile}
        />

        <MuiDivider sx={{ my: 2 }} />

        <Card variant="outlined" sx={{ borderRadius: 2 }}>
          <CardContent
            component={LocaleLink}
            href="/playlists"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              textDecoration: 'none',
              color: 'inherit',
              '&:hover': { bgcolor: 'action.hover' },
              cursor: 'pointer',
            }}
          >
            <HistoryOutlined color="action" />
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle2">{t('logbook.title')}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t('logbook.subtitle')}
              </Typography>
            </Box>
            <ChevronRightOutlined color="action" />
          </CardContent>
        </Card>

        <MuiDivider sx={{ my: 2 }} />

        <AuroraCredentialsSection />

        <MuiDivider sx={{ my: 2 }} />

        <ControllersSection />

        <MuiDivider sx={{ my: 2 }} />

        <Card variant="outlined" sx={{ borderRadius: 2 }}>
          {/* CardActionArea wraps the content in a button element with proper
              tabIndex, role="button", Enter/Space activation, and focus ring.
              Replaces a raw onClick on CardContent which wasn't keyboard-
              reachable. */}
          <CardActionArea onClick={() => setConsentDialogOpen(true)} aria-label={tConsent('settingsEntry.title')}>
            <CardContent
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <CookieOutlined color="action" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2">{tConsent('settingsEntry.title')}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {tConsent('settingsEntry.subtitle')}
                </Typography>
              </Box>
              <ChevronRightOutlined color="action" />
            </CardContent>
          </CardActionArea>
        </Card>

        <ConsentDialog open={consentDialogOpen} onClose={() => setConsentDialogOpen(false)} source="settings" />

        <MuiDivider sx={{ my: 2 }} />

        <DeleteAccountSection />
      </Box>
    </Box>
  );
}
