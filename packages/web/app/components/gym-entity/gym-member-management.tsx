'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import ListItemButton from '@mui/material/ListItemButton';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Paper from '@mui/material/Paper';
import RemoveCircleOutlined from '@mui/icons-material/RemoveCircleOutline';
import PersonAddOutlined from '@mui/icons-material/PersonAddOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_GYM_MEMBERS,
  REMOVE_GYM_MEMBER,
  GRANT_GYM_WRITE_ACCESS,
  REVOKE_GYM_WRITE_ACCESS,
  type GetGymMembersQueryVariables,
  type GetGymMembersQueryResponse,
  type RemoveGymMemberMutationVariables,
  type RemoveGymMemberMutationResponse,
  type GrantGymWriteAccessMutationVariables,
  type GrantGymWriteAccessMutationResponse,
  type RevokeGymWriteAccessMutationVariables,
  type RevokeGymWriteAccessMutationResponse,
} from '@boardsesh/graphql/operations';
import {
  SEARCH_USERS,
  type SearchUsersQueryResponse,
  type SearchUsersQueryVariables,
} from '@boardsesh/graphql/operations/social';
import type { GymMember, GymMemberRole } from '@boardsesh/shared-schema';

type UserResult = SearchUsersQueryResponse['searchUsers']['results'][number]['user'];

type GymMemberManagementProps = {
  gymUuid: string;
  isOwnerOrAdmin: boolean;
  canGrantAccess: boolean;
  onMembersChanged?: () => void;
};

// Static-literal lookup: the i18n linter forbids t(variable).
function roleLabel(t: (key: string) => string, role: GymMemberRole): string {
  if (role === 'admin') return t('gymMemberManagement.roles.admin');
  if (role === 'editor') return t('gymMemberManagement.roles.editor');
  return t('gymMemberManagement.roles.member');
}

export default function GymMemberManagement({
  gymUuid,
  isOwnerOrAdmin,
  canGrantAccess,
  onMembersChanged,
}: GymMemberManagementProps) {
  const { t } = useTranslation('boards');
  const [members, setMembers] = useState<GymMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();

  // Grant-access dialog state (user search picker).
  const [showGrantDialog, setShowGrantDialog] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [granting, setGranting] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchMembers = useCallback(
    async (offset = 0) => {
      if (!token) return;
      setLoading(true);
      try {
        const client = createGraphQLHttpClient(token);
        const data = await client.request<GetGymMembersQueryResponse, GetGymMembersQueryVariables>(GET_GYM_MEMBERS, {
          input: { gymUuid, limit: 20, offset },
        });

        if (offset === 0) {
          setMembers(data.gymMembers.members);
        } else {
          setMembers((prev) => [...prev, ...data.gymMembers.members]);
        }
        setHasMore(data.gymMembers.hasMore);
        setTotalCount(data.gymMembers.totalCount);
      } catch (error) {
        console.error('Failed to fetch members:', error);
      } finally {
        setLoading(false);
      }
    },
    [token, gymUuid],
  );

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  // Debounced user search for the grant dialog.
  useEffect(() => {
    if (!token || !showGrantDialog || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const client = createGraphQLHttpClient(token);
        const result = await client.request<SearchUsersQueryResponse, SearchUsersQueryVariables>(SEARCH_USERS, {
          input: { query: searchQuery, limit: 5 },
        });
        setSearchResults(result.searchUsers.results.map((r) => r.user));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimeout.current);
  }, [token, searchQuery, showGrantDialog]);

  const closeGrantDialog = useCallback(() => {
    setShowGrantDialog(false);
    setSelectedUser(null);
    setSearchQuery('');
    setSearchResults([]);
  }, []);

  const handleGrant = useCallback(async () => {
    if (!token || !selectedUser) return;
    setGranting(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<GrantGymWriteAccessMutationResponse, GrantGymWriteAccessMutationVariables>(
        GRANT_GYM_WRITE_ACCESS,
        { input: { gymUuid, userId: selectedUser.id } },
      );
      showMessage(t('gymMemberManagement.grant.snackbar.granted'), 'success');
      closeGrantDialog();
      await fetchMembers();
      onMembersChanged?.();
    } catch {
      showMessage(t('gymMemberManagement.grant.snackbar.grantFailed'), 'error');
    } finally {
      setGranting(false);
    }
  }, [token, selectedUser, gymUuid, showMessage, t, closeGrantDialog, fetchMembers, onMembersChanged]);

  const handleRevokeEditor = useCallback(
    async (userId: string) => {
      if (!token) return;
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<RevokeGymWriteAccessMutationResponse, RevokeGymWriteAccessMutationVariables>(
          REVOKE_GYM_WRITE_ACCESS,
          { input: { gymUuid, userId } },
        );
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
        setTotalCount((prev) => Math.max(0, prev - 1));
        showMessage(t('gymMemberManagement.grant.snackbar.revoked'), 'success');
        onMembersChanged?.();
      } catch {
        showMessage(t('gymMemberManagement.grant.snackbar.revokeFailed'), 'error');
      }
    },
    [token, gymUuid, showMessage, t, onMembersChanged],
  );

  const handleRemove = useCallback(
    async (userId: string) => {
      if (!token) return;
      if (!window.confirm(t('gymMemberManagement.removeConfirm'))) return;
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<RemoveGymMemberMutationResponse, RemoveGymMemberMutationVariables>(REMOVE_GYM_MEMBER, {
          input: { gymUuid, userId },
        });
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
        setTotalCount((prev) => Math.max(0, prev - 1));
        showMessage(t('gymMemberManagement.snackbar.removed'), 'success');
        onMembersChanged?.();
      } catch (error) {
        console.error('Failed to remove member:', error);
        showMessage(t('gymMemberManagement.snackbar.removeFailed'), 'error');
      }
    },
    [token, gymUuid, showMessage, t, onMembersChanged],
  );

  const renderRowAction = (member: GymMember): React.ReactNode => {
    if (member.role === 'editor' && canGrantAccess) {
      return (
        <IconButton
          edge="end"
          size="small"
          aria-label={t('gymMemberManagement.grant.revoke')}
          onClick={() => handleRevokeEditor(member.userId)}
        >
          <RemoveCircleOutlined fontSize="small" />
        </IconButton>
      );
    }
    if (isOwnerOrAdmin) {
      return (
        <IconButton
          edge="end"
          size="small"
          aria-label={t('gymMemberManagement.remove')}
          onClick={() => handleRemove(member.userId)}
        >
          <RemoveCircleOutlined fontSize="small" />
        </IconButton>
      );
    }
    return undefined;
  };

  return (
    <Box>
      {canGrantAccess && (
        <Box sx={{ mb: 2 }}>
          <MuiButton
            variant="outlined"
            size="small"
            startIcon={<PersonAddOutlined />}
            onClick={() => setShowGrantDialog(true)}
            sx={{ textTransform: 'none' }}
          >
            {t('gymMemberManagement.grant.button')}
          </MuiButton>
        </Box>
      )}

      {loading && members.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : members.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <MuiTypography variant="body2" color="text.secondary">
            {t('gymMemberManagement.empty')}
          </MuiTypography>
        </Box>
      ) : (
        <>
          <List disablePadding>
            {members.map((member) => (
              <ListItem key={member.userId} secondaryAction={renderRowAction(member)}>
                <ListItemAvatar>
                  <Avatar src={member.avatarUrl ?? undefined} sx={{ width: 32, height: 32, fontSize: 13 }}>
                    {member.displayName?.[0]?.toUpperCase()}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={member.displayName ?? t('gymMemberManagement.unknownUser')}
                  secondary={
                    <Chip
                      label={roleLabel(t, member.role)}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: 11, height: 20, mt: 0.5 }}
                    />
                  }
                />
              </ListItem>
            ))}
          </List>
          {hasMore && (
            <Box sx={{ p: 2 }}>
              <MuiButton
                onClick={() => fetchMembers(members.length)}
                disabled={loading}
                variant="outlined"
                fullWidth
                size="small"
              >
                {loading
                  ? t('common:actions.loading')
                  : t('gymMemberManagement.loadMore', { count: members.length, total: totalCount })}
              </MuiButton>
            </Box>
          )}
        </>
      )}

      {/* Grant write access dialog */}
      <Dialog open={showGrantDialog} onClose={closeGrantDialog} maxWidth="sm" fullWidth>
        <DialogTitle>{t('gymMemberManagement.grant.dialog.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>{t('gymMemberManagement.grant.dialog.description')}</DialogContentText>
          {selectedUser ? (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                p: 1.5,
                border: '1px solid var(--neutral-200)',
                borderRadius: 1,
              }}
            >
              <Avatar src={selectedUser.avatarUrl || undefined} sx={{ width: 32, height: 32, fontSize: 14 }}>
                {selectedUser.displayName?.[0]?.toUpperCase()}
              </Avatar>
              <MuiTypography variant="body2" sx={{ flex: 1, fontWeight: 500 }}>
                {selectedUser.displayName}
              </MuiTypography>
              <MuiButton
                size="small"
                onClick={() => {
                  setSelectedUser(null);
                  setSearchQuery('');
                }}
                sx={{ textTransform: 'none', fontSize: 12 }}
              >
                {t('gymMemberManagement.grant.dialog.change')}
              </MuiButton>
            </Box>
          ) : (
            <Box>
              <TextField
                label={t('gymMemberManagement.grant.dialog.searchLabel')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                size="small"
                fullWidth
                placeholder={t('gymMemberManagement.grant.dialog.searchPlaceholder')}
                slotProps={{ input: { endAdornment: searching ? <CircularProgress size={16} /> : null } }}
              />
              {searchResults.length > 0 && (
                <Paper variant="outlined" sx={{ mt: 0.5, maxHeight: 200, overflow: 'auto' }}>
                  <List dense disablePadding>
                    {searchResults.map((user) => (
                      <ListItemButton
                        key={user.id}
                        onClick={() => {
                          setSelectedUser(user);
                          setSearchResults([]);
                        }}
                      >
                        <ListItemAvatar sx={{ minWidth: 40 }}>
                          <Avatar src={user.avatarUrl || undefined} sx={{ width: 28, height: 28, fontSize: 12 }}>
                            {user.displayName?.[0]?.toUpperCase()}
                          </Avatar>
                        </ListItemAvatar>
                        <ListItemText primary={user.displayName} />
                      </ListItemButton>
                    ))}
                  </List>
                </Paper>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <MuiButton onClick={closeGrantDialog} sx={{ textTransform: 'none' }}>
            {t('gymMemberManagement.grant.dialog.cancel')}
          </MuiButton>
          <MuiButton
            onClick={handleGrant}
            variant="contained"
            disabled={!selectedUser || granting}
            sx={{ textTransform: 'none' }}
          >
            {granting ? <CircularProgress size={18} color="inherit" /> : t('gymMemberManagement.grant.dialog.submit')}
          </MuiButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
