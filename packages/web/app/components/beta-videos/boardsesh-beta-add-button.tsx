'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import AddOutlined from '@mui/icons-material/AddOutlined';
import IconButton from '@mui/material/IconButton';

type BoardseshBetaAddButtonProps = {
  onClick: () => void;
};

const BoardseshBetaAddButton: React.FC<BoardseshBetaAddButtonProps> = ({ onClick }) => {
  const { t } = useTranslation('feed');
  const { status } = useSession();

  if (status !== 'authenticated') return null;

  return (
    <IconButton size="small" onClick={onClick} aria-label={t('betaVideos.addButton')} sx={{ color: 'text.primary' }}>
      <AddOutlined fontSize="small" />
    </IconButton>
  );
};

export default BoardseshBetaAddButton;
