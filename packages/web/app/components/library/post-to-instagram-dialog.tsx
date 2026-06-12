'use client';

import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import ArrowBackIosNewOutlined from '@mui/icons-material/ArrowBackIosNewOutlined';
import InstagramIcon from '@mui/icons-material/Instagram';
import VideocamOutlined from '@mui/icons-material/VideocamOutlined';
import { useQuery } from '@tanstack/react-query';
import BoardseshBetaList from '@/app/components/beta-videos/boardsesh-beta-list';
import AttachBetaLinkForm from '@/app/components/beta-videos/attach-beta-link-form';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { buildInstagramCaption, copyAndOpenInstagram, getBoardDisplayName } from '@/app/lib/instagram-posting';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import { dedupeBetaLinks, mapBetaLinksResponse } from '@/app/lib/beta-video-url';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { themeTokens } from '@/app/theme/theme-config';

export type InstagramPostingTarget = {
  boardType: string;
  climbUuid: string;
  climbName: string;
  angle: number;
  grade?: string | null;
  setter?: string | null;
  layoutId?: number | null;
};

type PostToInstagramDialogProps = {
  open: boolean;
  onClose: () => void;
  item: InstagramPostingTarget | null;
};

export default function PostToInstagramDialog({ open, onClose, item }: PostToInstagramDialogProps) {
  const { t } = useTranslation('profile');
  const { showMessage } = useSnackbar();
  const instructions = useMemo(
    () => [
      t('logbook.instagram.steps.copy'),
      t('logbook.instagram.steps.paste'),
      t('logbook.instagram.steps.comeBack'),
      t('logbook.instagram.steps.pasteLink'),
    ],
    [t],
  );
  const [isLaunching, setIsLaunching] = useState(false);
  const {
    data: betaLinks = [],
    isLoading: betaLinksLoading,
    isError: betaLinksError,
    refetch: refetchBetaLinks,
  } = useQuery<BetaLink[]>({
    queryKey: ['betaLinks', item?.boardType, item?.climbUuid],
    queryFn: async () => {
      if (!item) return [];
      const client = createGraphQLHttpClient();
      const result = await client.request<{ betaLinks: Parameters<typeof mapBetaLinksResponse>[0] }>(GET_BETA_LINKS, {
        boardType: item.boardType,
        climbUuid: item.climbUuid,
      });
      return mapBetaLinksResponse(result.betaLinks);
    },
    enabled: open && !!item,
    staleTime: 5 * 60 * 1000,
  });
  const dedupedBetaLinks = useMemo(() => dedupeBetaLinks(betaLinks), [betaLinks]);

  const caption = useMemo(() => {
    if (!item) return '';
    return buildInstagramCaption({
      climbName: item.climbName,
      angle: item.angle,
      boardType: item.boardType,
      grade: item.grade,
      setter: item.setter,
      layoutId: item.layoutId,
    });
  }, [item]);

  const handleCopyAndOpen = useCallback(async () => {
    if (!caption) return;

    setIsLaunching(true);
    const result = await copyAndOpenInstagram(caption);
    setIsLaunching(false);

    if (!result.copied) {
      showMessage(t('logbook.instagram.snackbar.copyFailed'), 'error');
      return;
    }

    if (!result.opened) {
      showMessage(t('logbook.instagram.snackbar.openFailed'), 'error');
      return;
    }

    showMessage(t('logbook.instagram.snackbar.copied'), 'success');
  }, [caption, showMessage, t]);

  if (!item) return null;

  let betaVideosContent: React.ReactNode;
  if (betaLinksError) {
    betaVideosContent = (
      <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Typography variant="body2" color="error">
          {t('logbook.instagram.betaLoadFailed')}
        </Typography>
        <Button
          size="small"
          onClick={() => {
            void refetchBetaLinks();
          }}
        >
          {t('logbook.instagram.retry')}
        </Button>
      </Box>
    );
  } else {
    betaVideosContent = (
      <Box sx={{ mt: 1 }}>
        <BoardseshBetaList links={dedupedBetaLinks} isLoading={betaLinksLoading} boardType={item?.boardType} />
      </Box>
    );
  }

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
          <IconButton onClick={onClose} sx={{ color: 'text.primary' }} aria-label={t('logbook.instagram.back')}>
            <ArrowBackIosNewOutlined />
          </IconButton>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" component="h1" fontWeight={700}>
              {t('logbook.instagram.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('logbook.instagram.subtitle')}
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
            <Box
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 1.5,
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h5" component="h2" fontWeight={700} sx={{ mb: 0.5 }}>
                  {t('logbook.instagram.shareYourBeta')}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t('logbook.instagram.shareYourBetaBody')}
                </Typography>
              </Box>
              <InstagramIcon sx={{ color: 'primary.main', fontSize: 28, flexShrink: 0 }} />
            </Box>

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip size="small" label={getBoardDisplayName(item.boardType)} color="primary" variant="outlined" />
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
              {t('logbook.instagram.howItWorks')}
            </Typography>
            <Box
              sx={{
                color: 'text.secondary',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
                mt: 1,
              }}
            >
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
              {t('logbook.instagram.caption')}
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
            {t('logbook.instagram.copyAndOpen')}
          </Button>

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
                {t('logbook.instagram.pasteLinkTitle')}
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {t('logbook.instagram.pasteLinkBody')}
            </Typography>
            <AttachBetaLinkForm
              boardType={item.boardType}
              climbUuid={item.climbUuid}
              climbName={item.climbName}
              angle={item.angle}
              grade={item.grade}
              setter={item.setter}
              layoutId={item.layoutId}
              surface="instagram-dialog"
              resetTrigger={open}
              submitLabel={t('logbook.instagram.addLinkSubmit')}
              helperText={t('logbook.instagram.pasteLinkHelper')}
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
              {t('logbook.instagram.existingBetaVideos')}
            </Typography>
            {betaVideosContent}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
