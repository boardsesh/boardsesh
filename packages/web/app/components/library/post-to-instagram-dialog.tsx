'use client';

import React, { useMemo, useState, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import ArrowBackIosNewOutlined from '@mui/icons-material/ArrowBackIosNewOutlined';
import InstagramIcon from '@mui/icons-material/Instagram';
import VideocamOutlined from '@mui/icons-material/VideocamOutlined';
import { useQuery } from '@tanstack/react-query';
import BetaVideos from '@/app/components/beta-videos/beta-videos';
import AttachBetaLinkForm from '@/app/components/beta-videos/attach-beta-link-form';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import {
  buildInstagramCaption,
  copyAndOpenInstagram,
} from '@/app/lib/instagram-posting';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { themeTokens } from '@/app/theme/theme-config';

export interface InstagramPostingTarget {
  boardType: string;
  climbUuid: string;
  climbName: string;
  angle: number;
}

export type InstagramDialogMode = 'post' | 'link';

interface PostToInstagramDialogProps {
  open: boolean;
  onClose: () => void;
  item: InstagramPostingTarget | null;
  /** 'post' = full flow (caption + link), 'link' = link-only. Default: 'post'. */
  mode?: InstagramDialogMode;
}

const instructions = [
  'Copy the caption and open Instagram.',
  'Paste the caption when creating your post.',
  'Once your post is live, come back here.',
  'Paste the Instagram link so we can display your ascent video here.',
];

export default function PostToInstagramDialog({
  open,
  onClose,
  item,
  mode = 'post',
}: PostToInstagramDialogProps) {
  const { showMessage } = useSnackbar();
  const [isLaunching, setIsLaunching] = useState(false);
  const { data: betaLinks = [], isLoading: betaLinksLoading } = useQuery<BetaLink[]>({
    queryKey: ['betaLinks', item?.boardType, item?.climbUuid],
    queryFn: async () => {
      if (!item) return [];
      const res = await fetch(`/api/v1/${item.boardType}/beta/${item.climbUuid}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open && !!item,
    staleTime: 5 * 60 * 1000,
  });

  const caption = useMemo(() => {
    if (!item) return '';
    return buildInstagramCaption({
      climbName: item.climbName,
      angle: item.angle,
    });
  }, [item]);

  const handleCopyAndOpen = useCallback(async () => {
    if (!caption) return;

    setIsLaunching(true);
    const result = await copyAndOpenInstagram(caption);
    setIsLaunching(false);

    if (!result.copied) {
      showMessage("Couldn't copy caption. Try again.", 'error');
      return;
    }

    if (!result.opened) {
      showMessage("Couldn't open Instagram. Open it manually and paste the copied caption.", 'error');
      return;
    }

    showMessage('Caption copied. Instagram should open next.', 'success');
  }, [caption, showMessage]);

  if (!item) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      PaperProps={{
        sx: {
          bgcolor: 'background.default',
          color: 'text.primary',
        },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <IconButton onClick={onClose} sx={{ color: 'text.primary' }} aria-label="Back">
            <ArrowBackIosNewOutlined />
          </IconButton>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" component="h1" fontWeight={700}>
              {mode === 'link' ? 'Link Instagram Post' : 'Post to Instagram'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {mode === 'link' ? 'Attach an existing Instagram post to this climb.' : 'Share your ascent and link it back here.'}
            </Typography>
          </Box>
        </Box>

        <Box
          sx={{
            width: '100%',
            maxWidth: 680,
            mx: 'auto',
            px: { xs: 2, sm: 3 },
            py: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
          }}
        >
          {mode === 'post' && (
            <>
              <Box
                sx={{
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: `${themeTokens.borderRadius.lg}px`,
                  p: 2.5,
                  boxShadow: themeTokens.shadows.sm,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.5,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="h5" component="h2" fontWeight={700} sx={{ mb: 0.5 }}>
                      Share your beta video
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      We'll copy the caption, open Instagram, and let you paste the final link back into Boardsesh.
                    </Typography>
                  </Box>
                  <InstagramIcon sx={{ color: 'primary.main', fontSize: 28, flexShrink: 0 }} />
                </Box>

                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Chip size="small" label="Kilter" color="primary" variant="outlined" />
                  <Chip size="small" label={`${item.angle}°`} variant="outlined" />
                  <Chip
                    size="small"
                    icon={<VideocamOutlined sx={{ fontSize: '0.9rem !important' }} />}
                    label={item.climbName}
                    variant="outlined"
                  />
                </Box>
              </Box>

              <Box
                sx={{
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: `${themeTokens.borderRadius.lg}px`,
                  p: 2.5,
                  boxShadow: themeTokens.shadows.sm,
                }}
              >
                <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.06em' }}>
                  How It Works
                </Typography>
                <Box sx={{ color: 'text.secondary', display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1 }}>
                  {instructions.map((instruction, index) => (
                    <Typography key={instruction} variant="body1" sx={{ lineHeight: 1.5 }}>
                      <Box component="span" sx={{ color: 'text.primary', fontWeight: 700, mr: 1 }}>
                        {index + 1}.
                      </Box>
                      {instruction}
                    </Typography>
                  ))}
                </Box>
              </Box>

              <Box
                sx={{
                  bgcolor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: `${themeTokens.borderRadius.lg}px`,
                  p: 2.5,
                  boxShadow: themeTokens.shadows.sm,
                }}
              >
                <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.06em' }}>
                  Caption
                </Typography>
                <Typography
                  variant="h5"
                  component="pre"
                  sx={{
                    mt: 1,
                    mb: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontWeight: 700,
                    lineHeight: 1.35,
                  }}
                >
                  {caption}
                </Typography>
              </Box>

              <Button
                variant="contained"
                fullWidth
                size="large"
                onClick={handleCopyAndOpen}
                disabled={isLaunching}
                startIcon={<OpenInNewOutlined />}
                sx={{
                  py: 1.6,
                  borderRadius: `${themeTokens.borderRadius.md}px`,
                  textTransform: 'none',
                  fontWeight: 700,
                  fontSize: themeTokens.typography.fontSize.lg,
                }}
              >
                Copy & Open Instagram
              </Button>
            </>
          )}

          <Box
            sx={{
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: `${themeTokens.borderRadius.lg}px`,
              p: 2.5,
              display: 'flex',
              flexDirection: 'column',
              gap: 1.5,
              boxShadow: themeTokens.shadows.sm,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <InstagramIcon sx={{ color: 'text.secondary' }} />
              <Typography variant="h6" component="h3" fontWeight={700}>
                Paste your Instagram link
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              When your post is live, paste the reel or post link here so Boardsesh can show your ascent video.
            </Typography>
            <AttachBetaLinkForm
              boardType={item.boardType}
              climbUuid={item.climbUuid}
              climbName={item.climbName}
              angle={item.angle}
              resetTrigger={open}
              submitLabel="Add Instagram link"
              helperText="Paste the live Instagram reel or post URL."
            />
          </Box>

          <Divider sx={{ borderColor: 'divider' }} />

          <Box
            sx={{
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: `${themeTokens.borderRadius.lg}px`,
              p: 2.5,
              boxShadow: themeTokens.shadows.sm,
            }}
          >
            <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.06em' }}>
              Existing Beta Videos
            </Typography>
            {betaLinksLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={24} />
              </Box>
            ) : (
              <Box sx={{ mt: 1 }}>
                <BetaVideos betaLinks={betaLinks} />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
