'use client';

import React, { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import MuiAvatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import UploadOutlined from '@mui/icons-material/UploadOutlined';
import Instagram from '@mui/icons-material/Instagram';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Logo from '@/app/components/brand/logo';
import AuroraCredentialsSection from '@/app/components/settings/aurora-credentials-section';
import ControllersSection from '@/app/components/settings/controllers-section';
import DeleteAccountSection from '@/app/components/settings/delete-account-section';
import SetPasswordSection from '@/app/components/settings/set-password-section';
import BackButton from '@/app/components/back-button';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { usePartyProfile } from '@/app/components/party-manager/party-profile-context';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { getBackendHttpUrl } from '@/app/lib/backend-url';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface UserProfile {
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
}

export default function SettingsPageContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
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

  // Redirect unauthenticated users to login with a return URL
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/auth/login?callbackUrl=%2Fsettings');
    }
  }, [status, router]);

  // Fetch profile on mount
  useEffect(() => {
    if (status === 'authenticated') {
      fetchProfile();
    }
  }, [status]);

  // Clean up preview URL when component unmounts
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const fetchProfile = async () => {
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
      showMessage('Failed to load profile', 'error');
    } finally {
      setLoading(false);
    }
  };

  const beforeUpload = (file: File): boolean => {
    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      showMessage('Only JPG, PNG, GIF, and WebP images are allowed', 'error');
      return false;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      showMessage('Image must be smaller than 2MB', 'error');
      return false;
    }

    // Create preview
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);

    // Store file for later upload
    setSelectedFile(file);

    return false;
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
        showMessage('Display name must be less than 100 characters', 'error');
        return;
      }
      if (values.instagramUrl && !/^(https?:\/\/)?(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/.test(values.instagramUrl)) {
        showMessage('Please enter a valid Instagram profile URL', 'error');
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
            showMessage(errorData.error || 'Avatar upload failed', 'warning');
          }
        } catch (error) {
          console.error('Avatar upload failed:', error);
          showMessage(error instanceof Error ? error.message : 'Avatar upload failed', 'warning');
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
        throw new Error(error.error || 'Failed to update profile');
      }

      showMessage('Settings saved successfully', 'success');
      setSelectedFile(null);
      // Refresh profile locally and in context (so queue items show updated avatar)
      await fetchProfile();
      await refreshPartyProfile();
    } catch (error) {
      console.error('Failed to save settings:', error);
      showMessage(error instanceof Error ? error.message : 'Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const isSaving = saving || uploading;

  if (status === 'loading' || loading) {
    return (
      <Box sx={{ minHeight: '100vh', paddingTop: 'var(--global-header-height)', background: 'var(--semantic-background)' }}>
        <Box component="main" sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
          <CircularProgress size={48} />
        </Box>
      </Box>
    );
  }

  if (status === 'unauthenticated') {
    return null;
  }

  return (
    <Box sx={{ minHeight: '100vh', paddingTop: 'var(--global-header-height)', background: 'var(--semantic-background)' }}>
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
          Settings
        </Typography>
      </Box>

      <Box component="main" sx={{ padding: '24px', paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 0px))', maxWidth: 600, margin: '0 auto', width: '100%' }}>
        <Card>
          <CardContent>
            <Typography variant="h5">Profile</Typography>
            <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', marginBottom: 3 }}>
              Customize how you appear on Boardsesh
            </Typography>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Avatar</Typography>
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
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) beforeUpload(file);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outlined"
                      startIcon={uploading ? <CircularProgress size={16} /> : <UploadOutlined />}
                      disabled={isSaving}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {previewUrl ? 'Change' : 'Upload'}
                    </Button>
                    {previewUrl && (
                      <Button variant="outlined" onClick={handleRemoveAvatar} disabled={isSaving}>
                        Remove
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12 }}>
                    JPG, PNG, GIF, or WebP. Max 2MB.
                  </Typography>
                </Stack>
              </Box>

              <Box>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Display Name</Typography>
                <TextField
                  placeholder="Enter your display name"
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
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Instagram Profile</Typography>
                <TextField
                  placeholder="https://instagram.com/username"
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
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Email</Typography>
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
                <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12, marginTop: 0.5, display: 'block' }}>
                  Email cannot be changed
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
                  Save Changes
                </Button>
              </Box>
            </Box>
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

        <AuroraCredentialsSection />

        <MuiDivider sx={{ my: 2 }} />

        <ControllersSection />

        <MuiDivider sx={{ my: 2 }} />

        <DeleteAccountSection />
      </Box>
    </Box>
  );
}
