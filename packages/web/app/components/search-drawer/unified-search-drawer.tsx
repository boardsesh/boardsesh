'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import InputAdornment from '@mui/material/InputAdornment';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import UserSearchResults from '../social/user-search-results';
import BoardSearchResults from '../social/board-search-results';
import PlaylistSearchResults from '../social/playlist-search-results';
import GymSearchResults from '../social/gym-search-results';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { BoardDetails } from '@/app/lib/types';

export type SearchCategory = 'climbs' | 'users' | 'playlists' | 'boards' | 'gyms';

interface UnifiedSearchDrawerProps {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  defaultCategory?: SearchCategory;
  boardDetails?: BoardDetails;
  /** Render prop for climb search content (accordion form). Only used when boardDetails is provided. */
  renderClimbSearch?: () => React.ReactNode;
  /** Render prop for climb search footer (search/clear buttons). Only used when boardDetails is provided. */
  renderClimbFooter?: () => React.ReactNode;
  /** Optional allow-list for category pills/results. */
  allowedCategories?: SearchCategory[];
  /** Show drawer close button on mobile devices. */
  showCloseButtonOnMobile?: boolean;
  /** Show drawer close button. */
  showCloseButton?: boolean;
}

export default function UnifiedSearchDrawer({
  open,
  onClose,
  onTransitionEnd,
  defaultCategory = 'boards',
  boardDetails,
  renderClimbSearch,
  renderClimbFooter,
  allowedCategories,
  showCloseButtonOnMobile = false,
  showCloseButton = false,
}: UnifiedSearchDrawerProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SearchCategory>(defaultCategory);
  const { token } = useWsAuthToken();

  const handleCategoryChange = (newCategory: SearchCategory) => {
    setCategory(newCategory);
    setQuery('');
  };

  const handleClose = useCallback(() => {
    onClose();
    setQuery('');
  }, [onClose]);

  const isClimbMode = category === 'climbs' && !!boardDetails && !!renderClimbSearch;

  const categories: { key: SearchCategory; label: string; visible: boolean }[] = [
    { key: 'climbs', label: 'Climbs', visible: !!boardDetails },
    { key: 'boards', label: 'Boards', visible: true },
    { key: 'gyms', label: 'Gyms', visible: true },
    { key: 'users', label: 'Users', visible: true },
    { key: 'playlists', label: 'Playlists', visible: true },
  ];

  const allowedCategorySet = allowedCategories ? new Set(allowedCategories) : null;
  const visibleCategories = categories.filter((c) => c.visible && (allowedCategorySet ? allowedCategorySet.has(c.key) : true));
  const showCategoryChips = visibleCategories.length > 1;

  useEffect(() => {
    if (visibleCategories.length === 0) return;
    if (!visibleCategories.some((c) => c.key === category)) {
      setCategory(visibleCategories[0].key);
    }
  }, [category, visibleCategories]);

  return (
    <SwipeableDrawer
      placement="top"
      open={open}
      onClose={handleClose}
      onTransitionEnd={onTransitionEnd}
      height={isClimbMode ? '100%' : '80vh'}
      fullHeight={isClimbMode}
      showDragHandle
      showCloseButton={showCloseButton}
      showCloseButtonOnMobile={showCloseButtonOnMobile}
      swipeEnabled
      footer={isClimbMode && renderClimbFooter ? renderClimbFooter() : undefined}
      styles={{
        body: {
          padding: isClimbMode ? '0 16px 16px' : '0',
          backgroundColor: isClimbMode ? 'var(--semantic-background, #F3F4F6)' : undefined,
        },
        footer: isClimbMode ? { padding: 0, border: 'none' } : undefined,
        header: isClimbMode ? { display: 'none' } : undefined,
        mask: { backgroundColor: 'rgba(128, 128, 128, 0.7)' },
      }}
    >
      {/* Category pills */}
      {showCategoryChips && (
        <Box sx={{ display: 'flex', gap: 1, px: 2, py: 1, flexWrap: 'wrap' }}>
          {visibleCategories.map((c) => (
            <Chip
              key={c.key}
              label={c.label}
              variant={category === c.key ? 'filled' : 'outlined'}
              color={category === c.key ? 'primary' : 'default'}
              onClick={() => handleCategoryChange(c.key)}
            />
          ))}
        </Box>
      )}

      {/* Climb mode: render via parent's render prop (has access to queue context) */}
      {isClimbMode && renderClimbSearch()}

      {/* Text search mode */}
      {!isClimbMode && (
        <>
          <Box sx={{ px: 2, pt: 0, pb: 1 }}>
            <TextField
              fullWidth
              size="small"
              placeholder={
                category === 'boards' ? 'Search boards...'
                  : category === 'gyms' ? 'Search gyms...'
                  : category === 'users' ? 'Search climbers...'
                  : 'Search playlists...'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchOutlined />
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>

          <Box sx={{ overflow: 'auto', flex: 1 }}>
            {category === 'boards' && (
              <BoardSearchResults query={query} authToken={token} />
            )}
            {category === 'gyms' && (
              <GymSearchResults query={query} authToken={token} />
            )}
            {category === 'users' && (
              <UserSearchResults query={query} authToken={token} />
            )}
            {category === 'playlists' && (
              <PlaylistSearchResults query={query} authToken={token} />
            )}
          </Box>
        </>
      )}
    </SwipeableDrawer>
  );
}
