'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import CircularProgress from '@mui/material/CircularProgress';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import Snackbar from '@mui/material/Snackbar';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_COMMUNITY_ROLES, GRANT_ROLE, REVOKE_ROLE } from '@boardsesh/graphql/operations/proposals';
import {
  SEARCH_USERS,
  type SearchUsersQueryResponse,
  type SearchUsersQueryVariables,
} from '@boardsesh/graphql/operations/social';
import type { CommunityRoleAssignment, CommunityRoleType } from '@boardsesh/shared-schema';

type UserResult = SearchUsersQueryResponse['searchUsers']['results'][number]['user'];

// Chip accent per role: admins read as the destructive/error colour, testers as
// the cool info slate, community leaders as brand primary.
function roleChipColor(role: CommunityRoleType): string {
  if (role === 'admin') return themeTokens.colors.error;
  if (role === 'tester') return themeTokens.colors.info;
  return themeTokens.colors.primary;
}

export default function RoleManagement() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [roles, setRoles] = useState<CommunityRoleAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGrantDialog, setShowGrantDialog] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [grantRole, setGrantRole] = useState<CommunityRoleType>('community_leader');
  const [grantBoardType, setGrantBoardType] = useState('');
  const [snackbar, setSnackbar] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchRoles = useCallback(async () => {
    if (!token) return;
    try {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<{ communityRoles: CommunityRoleAssignment[] }>(GET_COMMUNITY_ROLES);
      setRoles(result.communityRoles);
    } catch (err) {
      console.error('[RoleManagement] Failed to fetch roles:', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchRoles();
  }, [fetchRoles]);

  // Debounced user search
  useEffect(() => {
    if (!token || searchQuery.length < 2) {
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
  }, [token, searchQuery]);

  const handleGrant = useCallback(async () => {
    if (!token || !selectedUser) return;
    try {
      const client = createGraphQLHttpClient(token);
      await client.request(GRANT_ROLE, {
        input: {
          userId: selectedUser.id,
          role: grantRole,
          boardType: grantBoardType || null,
        },
      });
      setShowGrantDialog(false);
      setSelectedUser(null);
      setSearchQuery('');
      setSearchResults([]);
      setGrantBoardType('');
      setGrantRole('community_leader');
      setSnackbar(t('roles.snackbar.granted'));
      void fetchRoles();
    } catch {
      setSnackbar(t('roles.snackbar.grantFailed'));
    }
  }, [token, selectedUser, grantRole, grantBoardType, fetchRoles, t]);

  const handleRevoke = useCallback(
    async (role: CommunityRoleAssignment) => {
      if (!token) return;
      try {
        const client = createGraphQLHttpClient(token);
        await client.request(REVOKE_ROLE, {
          input: {
            userId: role.userId,
            role: role.role,
            boardType: role.boardType || null,
          },
        });
        setSnackbar(t('roles.snackbar.revoked'));
        void fetchRoles();
      } catch {
        setSnackbar(t('roles.snackbar.revokeFailed'));
      }
    },
    [token, fetchRoles, t],
  );

  const handleCloseDialog = useCallback(() => {
    setShowGrantDialog(false);
    setSelectedUser(null);
    setSearchQuery('');
    setSearchResults([]);
    setGrantBoardType('');
    setGrantRole('community_leader');
  }, []);

  const fallbackInitial = t('roles.labels.fallbackUserInitial');
  const fallbackEmpty = t('roles.labels.fallbackEmpty');

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {t('roles.heading')}
        </Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setShowGrantDialog(true)}
          sx={{
            textTransform: 'none',
            bgcolor: themeTokens.colors.primary,
            '&:hover': { bgcolor: themeTokens.colors.primaryHover },
          }}
        >
          {t('roles.grant')}
        </Button>
      </Box>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('roles.table.user')}</TableCell>
              <TableCell>{t('roles.table.role')}</TableCell>
              <TableCell>{t('roles.table.board')}</TableCell>
              <TableCell>{t('roles.table.grantedBy')}</TableCell>
              <TableCell>{t('roles.table.date')}</TableCell>
              <TableCell align="right">{t('roles.table.actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Avatar src={role.userAvatarUrl || undefined} sx={{ width: 28, height: 28, fontSize: 12 }}>
                      {role.userDisplayName?.[0] || fallbackInitial}
                    </Avatar>
                    <Typography variant="body2">{role.userDisplayName || role.userId}</Typography>
                  </Box>
                </TableCell>
                <TableCell>
                  <Chip
                    label={
                      role.role === 'admin'
                        ? t('roles.labels.admin')
                        : role.role === 'tester'
                          ? t('roles.labels.tester')
                          : t('roles.labels.leader')
                    }
                    size="small"
                    sx={{
                      bgcolor: `${roleChipColor(role.role)}14`,
                      color: roleChipColor(role.role),
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  />
                </TableCell>
                <TableCell>{role.boardType || t('roles.labels.global')}</TableCell>
                <TableCell>{role.grantedByDisplayName || role.grantedBy || fallbackEmpty}</TableCell>
                <TableCell>{new Date(role.createdAt).toLocaleDateString()}</TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => handleRevoke(role)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {roles.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  <Typography variant="body2" sx={{ color: themeTokens.neutral[400], py: 2 }}>
                    {t('roles.empty')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Grant Role Dialog */}
      <Dialog open={showGrantDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>{t('roles.dialog.title')}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            {/* User search or selected user display */}
            {selectedUser ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  p: 1.5,
                  border: `1px solid ${themeTokens.neutral[200]}`,
                  borderRadius: 1,
                }}
              >
                <Avatar src={selectedUser.avatarUrl || undefined} sx={{ width: 32, height: 32, fontSize: 14 }}>
                  {selectedUser.displayName?.[0] || t('roles.dialog.fallbackUserInitial')}
                </Avatar>
                <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }}>
                  {selectedUser.displayName}
                </Typography>
                <Button
                  size="small"
                  onClick={() => {
                    setSelectedUser(null);
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                  sx={{ textTransform: 'none', fontSize: 12 }}
                >
                  {t('roles.dialog.change')}
                </Button>
              </Box>
            ) : (
              <Box>
                <TextField
                  label={t('roles.dialog.search.label')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  size="small"
                  fullWidth
                  placeholder={t('roles.dialog.search.placeholder')}
                  slotProps={{
                    input: {
                      endAdornment: searching ? <CircularProgress size={16} /> : null,
                    },
                  }}
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
                              {user.displayName?.[0] || t('roles.dialog.fallbackUserInitial')}
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
            <FormControl size="small" fullWidth>
              <InputLabel>{t('roles.dialog.roleLabel')}</InputLabel>
              <Select
                value={grantRole}
                label={t('roles.dialog.roleLabel')}
                onChange={(e) => {
                  const nextRole = e.target.value as CommunityRoleType;
                  setGrantRole(nextRole);
                  // Tester is a global-only capability; clear any board scope so the
                  // grant lands as a global role.
                  if (nextRole === 'tester') setGrantBoardType('');
                }}
              >
                <MenuItem value="community_leader">{t('roles.dialog.roleOptions.communityLeader')}</MenuItem>
                <MenuItem value="admin">{t('roles.dialog.roleOptions.admin')}</MenuItem>
                <MenuItem value="tester">{t('roles.dialog.roleOptions.tester')}</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth disabled={grantRole === 'tester'}>
              <InputLabel>{t('roles.dialog.boardTypeLabel')}</InputLabel>
              <Select
                value={grantBoardType}
                label={t('roles.dialog.boardTypeLabel')}
                onChange={(e) => setGrantBoardType(e.target.value)}
              >
                <MenuItem value="">{t('roles.dialog.boardTypeOptions.global')}</MenuItem>
                <MenuItem value="kilter">{t('roles.dialog.boardTypeOptions.kilter')}</MenuItem>
                <MenuItem value="tension">{t('roles.dialog.boardTypeOptions.tension')}</MenuItem>
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} sx={{ textTransform: 'none' }}>
            {t('roles.dialog.cancel')}
          </Button>
          <Button
            onClick={handleGrant}
            variant="contained"
            disabled={!selectedUser}
            sx={{
              textTransform: 'none',
              bgcolor: themeTokens.colors.primary,
              '&:hover': { bgcolor: themeTokens.colors.primaryHover },
            }}
          >
            {t('roles.dialog.submit')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  );
}
