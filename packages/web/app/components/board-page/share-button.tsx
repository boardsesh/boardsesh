'use client';

import React, { useState } from 'react';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import EmojiEvents from '@mui/icons-material/EmojiEvents';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import Lightbulb from '@mui/icons-material/Lightbulb';
import AppleOutlined from '@mui/icons-material/Apple';
import ApiOutlined from '@mui/icons-material/ApiOutlined';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Badge from '@mui/material/Badge';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { QRCodeSVG } from 'qrcode.react';
import Box from '@mui/material/Box';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useQueueActions, useCurrentClimb, useSessionData } from '../graphql-queue';
import { usePersistentSession } from '../persistent-session';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import './share-button.css';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { TabPanel } from '@/app/components/ui/tab-panel';
import { themeTokens } from '@/app/theme/theme-config';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import SessionCreationForm from '../session-creation/session-creation-form';
import type { SessionCreationFormData } from '../session-creation/session-creation-form';
import { useCreateSession } from '@/app/hooks/use-create-session';
import { getBaseBoardPath } from '@/app/lib/url-utils';
import { deduplicateBy } from '@/app/utils/deduplicate';

const getShareUrl = (sessionId: string | null) => {
  try {
    if (!sessionId) return '';
    return `${window.location.origin}/join/${sessionId}`;
  } catch {
    return '';
  }
};

function LedConnectionTab() {
  const {
    isConnected,
    loading,
    connect,
    disconnect,
    isBluetoothSupported,
    isIOS,
  } = useBluetoothContext();
  const { currentClimbQueueItem } = useCurrentClimb();

  const handleConnect = async () => {
    if (currentClimbQueueItem) {
      await connect(
        currentClimbQueueItem.climb.frames,
        !!currentClimbQueueItem.climb.mirrored,
      );
    } else {
      await connect();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" component="span">
        Light up holds on your board. Routes switch automatically as you move through your queue.
      </Typography>

      {!isBluetoothSupported && (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            padding: '12px',
            background: 'var(--color-warning-bg)',
            border: `1px solid ${themeTokens.colors.warning}`,
            borderRadius: themeTokens.borderRadius.md,
          }}
        >
          <Typography variant="body1" component="p" sx={{ margin: 0 }}>
            <Typography variant="body2" component="span">
              This browser can&#39;t talk to your board over Bluetooth.
            </Typography>
          </Typography>
          {isIOS ? (
            <>
              <Typography variant="body1" component="p" sx={{ margin: 0 }}>
                To control your board from an iOS device, install the Bluefy
                browser:
              </Typography>
              <MuiButton
                variant="contained"
                startIcon={<AppleOutlined />}
                href="https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055"
                target="_blank"
              >
                Download Bluefy from the App Store
              </MuiButton>
            </>
          ) : (
            <Typography variant="body1" component="p" sx={{ margin: 0 }}>
              Switch to Chrome or another Chromium-based browser to connect.
            </Typography>
          )}
        </Box>
      )}

      {isBluetoothSupported && !isConnected && (
        <MuiButton
          variant="contained"
          size="large"
          startIcon={loading ? <CircularProgress size={16} /> : <LightbulbOutlined />}
          onClick={handleConnect}
          disabled={loading}
          fullWidth
        >
          Connect to Board
        </MuiButton>
      )}

      {isConnected && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              padding: '12px',
              background: 'var(--color-success-bg)',
              border: `1px solid ${themeTokens.colors.success}`,
              borderRadius: themeTokens.borderRadius.md,
            }}
          >
            <Lightbulb
              sx={{ color: themeTokens.colors.success, fontSize: '18px' }}
            />
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" component="span" fontWeight={600} sx={{ color: themeTokens.colors.success }}>
                Board connected
              </Typography>
              <br />
              <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: '12px' }}>
                Holds light up as you go
              </Typography>
            </Box>
            <MuiButton
              variant="text"
              color="error"
              startIcon={<ApiOutlined />}
              onClick={disconnect}
            >
              Disconnect
            </MuiButton>
          </Box>
        </Box>
      )}
    </Box>
  );
}

export const ShareBoardButton = () => {
  const { showMessage } = useSnackbar();
  const {
    users,
    clientId,
    hasConnected,
    connectionError,
    isSessionActive,
    sessionId,
    sessionGoal,
  } = useSessionData();
  const {
    startSession,
    joinSession,
    endSession,
  } = useQueueActions();
  const { isConnected: isBoardConnected } = useBluetoothContext();
  const { status: authStatus } = useSession();
  const { activeSession } = usePersistentSession();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const controllerUrl = searchParams.get('controllerUrl');
  const isControllerMode = !!controllerUrl;

  const { createSession: createSessionMutation, isCreating } = useCreateSession();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [joinSessionId, setJoinSessionId] = useState('');
  const { openAuthModal } = useAuthModal();
  const [activeNoSessionTab, setActiveNoSessionTab] = useState('led');
  const [activeSessionTab, setActiveSessionTab] = useState('led');

  const isLoggedIn = authStatus === 'authenticated';

  const showDrawer = () => {
    setIsDrawerOpen(true);
  };

  const handleClose = () => {
    setIsDrawerOpen(false);
  };

  // Determine connection state
  const isConnecting = !!(sessionId && !hasConnected);
  const isConnected = !!(sessionId && hasConnected);

  const shareUrl = getShareUrl(sessionId);
  // Defensive dedup: during WebSocket reconnection race conditions the server
  // may briefly report the same user twice. Deduplicating by ID keeps the UI
  // stable until the next authoritative state sync arrives.
  const uniqueUsers = React.useMemo(
    () => deduplicateBy(users ?? [], (u) => u.id),
    [users],
  );

  const copyToClipboard = () => {
    navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        showMessage('Share URL copied to clipboard!', 'success');
      })
      .catch(() => {
        showMessage('Failed to copy URL.', 'error');
      });
  };

  const handleStartSessionEnhanced = async (formData: SessionCreationFormData) => {
    if (!isLoggedIn) {
      openAuthModal({ title: 'Sign in to start a session', description: 'Sign in to start climbing with your crew.' });
      return;
    }

    try {
      const boardPath = getBaseBoardPath(pathname);
      const newSessionId = await createSessionMutation(formData, boardPath);
      await startSession({
        sessionId: newSessionId,
        discoverable: formData.discoverable,
        name: formData.name,
      });
      showMessage('Session started!', 'success');
    } catch (error) {
      console.error('Failed to start session:', error);
      showMessage('Failed to start session', 'error');
    }
  };

  const handleJoinSession = async () => {
    if (!joinSessionId.trim()) {
      showMessage('Please enter a session ID', 'warning');
      return;
    }

    try {
      let sessionIdToJoin = joinSessionId.trim();
      try {
        const url = new URL(sessionIdToJoin);
        // Support /join/[sessionId] URL format
        const joinMatch = url.pathname.match(/\/join\/([^/]+)$/);
        if (joinMatch) {
          sessionIdToJoin = joinMatch[1];
        } else {
          // Legacy: support ?session= URL format
          const sessionParam = url.searchParams.get('session');
          if (sessionParam) {
            sessionIdToJoin = sessionParam;
          }
        }
      } catch {
        // Not a URL, use as-is
      }

      await joinSession(sessionIdToJoin);
      showMessage('Joined session!', 'success');
      setJoinSessionId('');
    } catch (error) {
      console.error('Failed to join session:', error);
      showMessage('Failed to join session', 'error');
    }
  };

  const handleEndSession = () => {
    endSession();
    showMessage('Left session', 'info');
  };

  const connectionCount = uniqueUsers.length;
  const currentUserId = clientId;

  // Session info content (shared between active and inactive states)
  const sessionInfoContent = (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: '12px',
          background: 'var(--color-success-bg)',
          border: `1px solid ${themeTokens.colors.success}`,
          borderRadius: themeTokens.borderRadius.md,
        }}
      >
        <CheckCircleOutlined sx={{ color: themeTokens.colors.success, fontSize: '18px' }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2" component="span" fontWeight={600} sx={{ color: themeTokens.colors.success }}>
            Session Active
          </Typography>
          <br />
          <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: '12px' }}>
            Session: {sessionId?.substring(0, 8)}...
          </Typography>
        </Box>
        <MuiButton
          variant="text"
          color="error"
          startIcon={<CancelOutlined />}
          onClick={handleEndSession}
        >
          Leave
        </MuiButton>
      </Box>

      {sessionGoal && (
        <Box
          sx={{
            padding: '8px 12px',
            background: 'var(--neutral-50)',
            borderRadius: themeTokens.borderRadius.md,
            border: '1px solid var(--neutral-200)',
          }}
        >
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            Goal
          </Typography>
          <Typography variant="body2">
            {sessionGoal}
          </Typography>
        </Box>
      )}

      {uniqueUsers.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="body2" component="span" fontWeight={600}>Connected Users ({uniqueUsers.length}):</Typography>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              maxHeight: '150px',
              overflowY: 'auto',
              padding: '4px',
            }}
          >
            {uniqueUsers.map((user) => (
              <Box
                key={user.id}
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background:
                    user.id === currentUserId ? 'var(--semantic-selected)' : 'var(--neutral-100)',
                  padding: '8px 12px',
                  borderRadius: themeTokens.borderRadius.md,
                  width: '100%',
                }}
              >
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Typography variant="body2" component="span" sx={{ fontSize: '14px' }}>
                    {user.username}
                    {user.id === currentUserId && ' (you)'}
                  </Typography>
                </Box>
                {user.isLeader && (
                  <EmojiEvents sx={{ color: themeTokens.colors.warning, fontSize: '16px' }} />
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {!isLoggedIn && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px',
            background: 'var(--neutral-100)',
            borderRadius: themeTokens.borderRadius.md,
          }}
        >
          <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: '13px' }}>
            Sign in to customize your username
          </Typography>
          <MuiButton variant="text" size="small" startIcon={<LoginOutlined />} onClick={() => openAuthModal({ title: 'Sign in to start a session', description: 'Sign in to start climbing with your crew.' })}>
            Sign in
          </MuiButton>
        </Box>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2" component="span" fontWeight={600}>Invite others to join:</Typography>
        <Box sx={{ display: 'flex', width: '100%', alignItems: 'center' }}>
          <TextField
            value={shareUrl}
            slotProps={{ input: { readOnly: true } }}
            variant="outlined"
            size="small"
            fullWidth
          />
          <IconButton onClick={copyToClipboard}>
            <ContentCopyOutlined />
          </IconButton>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <QRCodeSVG value={shareUrl} size={160} />
        </Box>
      </Box>
    </>
  );

  // Tab content for when no session is active
  const startTabContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" component="span">
        Climb with your crew. Share a queue and take turns on the wall.
      </Typography>

      {!isLoggedIn && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            padding: '12px',
            background: 'var(--color-warning-bg)',
            border: `1px solid ${themeTokens.colors.warning}`,
            borderRadius: themeTokens.borderRadius.md,
          }}
        >
          <Typography variant="body2" component="span">Sign in to start a session</Typography>
          <MuiButton variant="contained" size="small" startIcon={<LoginOutlined />} onClick={() => openAuthModal({ title: 'Sign in to start a session', description: 'Sign in to start climbing with your crew.' })}>
            Sign in
          </MuiButton>
        </Box>
      )}

      {isLoggedIn && (
        <SessionCreationForm
          onSubmit={handleStartSessionEnhanced}
          isSubmitting={isCreating}
          submitLabel="Start Session"
        />
      )}
    </Box>
  );

  const joinTabContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="body2" component="span">Paste a link or session ID from your crew.</Typography>

      <TextField
        placeholder="Paste session link or ID..."
        value={joinSessionId}
        onChange={(e) => setJoinSessionId(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleJoinSession()}
        variant="outlined"
        size="small"
      />

      <MuiButton variant="contained" size="large" onClick={handleJoinSession} fullWidth>
        Join Session
      </MuiButton>
    </Box>
  );

  const ledTabContent = <LedConnectionTab />;

  return (
    <>
      <Badge badgeContent={connectionCount} max={100} color="primary" invisible={connectionCount === 0}>
        <IconButton
          aria-label="Connect to"
          onClick={showDrawer}
          color={isSessionActive ? 'primary' : 'default'}
        >
          {isConnecting ? (
            <CircularProgress size={16} />
          ) : isBoardConnected ? (
            <Lightbulb className="connect-button-glow" />
          ) : (
            <LightbulbOutlined />
          )}
        </IconButton>
      </Badge>
      <SwipeableDrawer
        title={isControllerMode ? 'Controller Mode' : 'Connect to'}
        placement="bottom"
        onClose={handleClose}
        open={isDrawerOpen}
        styles={{
          wrapper: { height: '70vh' },
        }}
      >
        <Box sx={{ display: 'flex', gap: 2, flexDirection: 'column' }}>
          {/* Controller Mode Banner */}
          {isControllerMode && (
            <Box
              sx={{
                padding: '12px',
                background: 'var(--semantic-selected)',
                border: `1px solid ${themeTokens.colors.primary}`,
                borderRadius: themeTokens.borderRadius.md,
                mb: '16px',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box component="span" sx={{ fontSize: '18px' }}>🎮</Box>
                <Box>
                  <Typography variant="body2" component="span" fontWeight={600} sx={{ color: themeTokens.colors.primary }}>
                    Board Controller Connected
                  </Typography>
                  <br />
                  <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: '12px' }}>
                    Queue management is handled by your Board Controller
                  </Typography>
                </Box>
              </Box>
            </Box>
          )}

          {/* Party Mode Content */}
          {!isControllerMode && (
            <>
              {/* No active session and not connecting - show start/join/LED tabs */}
              {!isSessionActive && !isConnecting && (
                <>
                  <Tabs value={activeNoSessionTab} onChange={(_, v) => setActiveNoSessionTab(v)}>
                    <Tab label="Connect to Board" value="led" />
                    <Tab label="Start Session" value="start" />
                    <Tab label="Join Session" value="join" />
                  </Tabs>
                  <TabPanel value={activeNoSessionTab} index="led">
                    {ledTabContent}
                  </TabPanel>
                  <TabPanel value={activeNoSessionTab} index="start">
                    {startTabContent}
                  </TabPanel>
                  <TabPanel value={activeNoSessionTab} index="join">
                    {joinTabContent}
                  </TabPanel>
                </>
              )}

              {/* Connecting */}
              {isConnecting && (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '24px' }}>
                  <CircularProgress size={32} sx={{ color: themeTokens.colors.primary }} />
                  <Typography variant="body2" component="span">Connecting to session...</Typography>
                </Box>
              )}

              {/* Connection error */}
              {connectionError && !isConnecting && (
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    padding: '12px',
                    background: 'var(--color-error-bg)',
                    border: `1px solid ${themeTokens.colors.error}`,
                    borderRadius: themeTokens.borderRadius.md,
                  }}
                >
                  <Typography variant="body2" component="span" color="error">{connectionError.message}</Typography>
                </Box>
              )}

              {/* Connected - show session info + LED tabs */}
              {isConnected && (
                <>
                  <Tabs value={activeSessionTab} onChange={(_, v) => setActiveSessionTab(v)}>
                    <Tab label="Connect to Board" value="led" />
                    <Tab label="Session" value="session" />
                  </Tabs>
                  <TabPanel value={activeSessionTab} index="led">
                    {ledTabContent}
                  </TabPanel>
                  <TabPanel value={activeSessionTab} index="session">
                    <Box sx={{ display: 'flex', gap: 2, flexDirection: 'column' }}>
                      {sessionInfoContent}
                    </Box>
                  </TabPanel>
                </>
              )}
            </>
          )}
        </Box>
      </SwipeableDrawer>

    </>
  );
};
