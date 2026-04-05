'use client';

import React, { useState, useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MoreVertOutlined from '@mui/icons-material/MoreVertOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import EditAscentDialog, { type EditAscentValues } from './edit-ascent-dialog';
import type { TickStatus } from '@/app/hooks/use-logbook';

export interface AscentData {
  uuid: string;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  comment: string;
}

interface AscentActionsMenuProps {
  ascent: AscentData;
  onUpdate: (uuid: string, values: EditAscentValues) => void;
  onDelete: (uuid: string) => void;
  updating?: boolean;
  deleting?: boolean;
}

export default function AscentActionsMenu({
  ascent,
  onUpdate,
  onDelete,
  updating = false,
  deleting = false,
}: AscentActionsMenuProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const handleMenuOpen = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuAnchor(null);
  }, []);

  const handleEditClick = useCallback(() => {
    handleMenuClose();
    setEditOpen(true);
  }, [handleMenuClose]);

  const handleEditSave = useCallback((values: EditAscentValues) => {
    onUpdate(ascent.uuid, values);
    setEditOpen(false);
  }, [onUpdate, ascent.uuid]);

  const handleDelete = useCallback(() => {
    handleMenuClose();
    onDelete(ascent.uuid);
  }, [handleMenuClose, onDelete, ascent.uuid]);

  return (
    <>
      <IconButton
        size="small"
        onClick={handleMenuOpen}
        disabled={updating || deleting}
        aria-label="Ascent actions"
      >
        <MoreVertOutlined fontSize="small" />
      </IconButton>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={handleEditClick}>
          <ListItemIcon>
            <EditOutlined fontSize="small" />
          </ListItemIcon>
          <ListItemText>Edit</ListItemText>
        </MenuItem>
        <ConfirmPopover
          title="Delete this ascent?"
          description="This can't be undone."
          onConfirm={handleDelete}
          okText="Delete"
          okButtonProps={{ color: 'error' }}
        >
          <MenuItem sx={{ color: 'error.main' }}>
            <ListItemIcon>
              <DeleteOutlined fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        </ConfirmPopover>
      </Menu>

      {editOpen && (
        <EditAscentDialog
          open
          onClose={() => setEditOpen(false)}
          onSave={handleEditSave}
          saving={updating}
          initialValues={{
            status: ascent.status ?? 'attempt',
            attemptCount: ascent.attemptCount,
            quality: ascent.quality,
            comment: ascent.comment,
          }}
        />
      )}
    </>
  );
}
