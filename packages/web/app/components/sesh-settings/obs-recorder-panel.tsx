'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import CheckCircleOutlineOutlined from '@mui/icons-material/CheckCircleOutlineOutlined';
import FiberManualRecordOutlined from '@mui/icons-material/FiberManualRecordOutlined';
import PowerSettingsNewOutlined from '@mui/icons-material/PowerSettingsNewOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import { useTranslation } from 'react-i18next';
import {
  getObsErrorMessage,
  ObsWebSocketClient,
  ObsWebSocketClientError,
  ObsWebSocketRequestError,
  type StopRecordingResponse,
} from '@/app/lib/obs-websocket-client';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';

const RECORDER_SETTINGS_PREFERENCE_KEY = 'obsRecorderSettings';
const OVERLAY_VISIBLE_MS = 3000;

type RecorderSettings = {
  url: string;
  password: string;
  textSourceName: string;
};

type StoredRecorderSettings = Omit<RecorderSettings, 'password'>;

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping';
type RecordingOutcome = 'send' | 'fail';

const DEFAULT_SETTINGS: RecorderSettings = {
  url: 'ws://127.0.0.1:4455',
  password: '',
  textSourceName: 'Boardsesh Climb Overlay',
};

export const formatObsClimbOverlayText = (item: ClimbQueueItem | null, fallbackTitle = '') => {
  if (!item) return '';

  const climb = item.climb;
  const title = climb.name?.trim() || fallbackTitle;
  const details = [climb.difficulty, Number.isFinite(climb.angle) ? `${climb.angle}\u00b0` : null].filter(Boolean);

  if (!title) return details.join(' / ');
  return details.length ? `${title}\n${details.join(' / ')}` : title;
};

const readStoredSettings = async (): Promise<RecorderSettings> => {
  const stored = await getPreference(RECORDER_SETTINGS_PREFERENCE_KEY);

  if (!stored) return DEFAULT_SETTINGS;

  return {
    url: typeof stored.url === 'string' ? stored.url : DEFAULT_SETTINGS.url,
    password: DEFAULT_SETTINGS.password,
    textSourceName: typeof stored.textSourceName === 'string' ? stored.textSourceName : DEFAULT_SETTINGS.textSourceName,
  };
};

const writeStoredSettings = (settings: RecorderSettings) => {
  const storedSettings: StoredRecorderSettings = {
    url: settings.url,
    textSourceName: settings.textSourceName,
  };
  return setPreference(RECORDER_SETTINGS_PREFERENCE_KEY, storedSettings);
};

const getOutputPath = (response: StopRecordingResponse) => response.outputPath || null;

const isObsNotRecordingError = (error: unknown) => {
  const message = getObsErrorMessage(error).toLowerCase();
  return message.includes('not recording') || message.includes('not running') || message.includes('output not running');
};

const isValidObsWebsocketUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && Boolean(url.host);
  } catch {
    return false;
  }
};

type ObsRecorderPanelProps = {
  currentClimbQueueItem: ClimbQueueItem | null;
  onRecordingActiveChange?: (active: boolean) => void;
};

export default function ObsRecorderPanel({ currentClimbQueueItem, onRecordingActiveChange }: ObsRecorderPanelProps) {
  const { t } = useTranslation('session');
  const [settings, setSettings] = useState<RecorderSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutputPath, setLastOutputPath] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<RecordingOutcome | null>(null);
  const [recordingSnapshot, setRecordingSnapshot] = useState<ClimbQueueItem | null>(null);
  const clientRef = useRef<ObsWebSocketClient | null>(null);
  const overlayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsDirtyRef = useRef(false);
  const touchedSettingsRef = useRef<Partial<Record<keyof RecorderSettings, boolean>>>({});
  const notifiedRecordingActiveRef = useRef(false);
  const connectingClientPromiseRef = useRef<Promise<ObsWebSocketClient> | null>(null);

  const currentOverlayText = useMemo(
    () => formatObsClimbOverlayText(currentClimbQueueItem, t('settings.recorder.currentClimbFallback')),
    [currentClimbQueueItem, t],
  );
  const recordingActive =
    recordingStatus === 'starting' || recordingStatus === 'recording' || recordingStatus === 'stopping';
  const connected = connectionStatus === 'connected';

  useEffect(() => {
    if (notifiedRecordingActiveRef.current !== recordingActive) {
      onRecordingActiveChange?.(recordingActive);
      notifiedRecordingActiveRef.current = recordingActive;
    }

    return () => {
      if (notifiedRecordingActiveRef.current) {
        onRecordingActiveChange?.(false);
        notifiedRecordingActiveRef.current = false;
      }
    };
  }, [onRecordingActiveChange, recordingActive]);

  useEffect(() => {
    let cancelled = false;

    void readStoredSettings()
      .then((storedSettings) => {
        if (cancelled) return;
        setSettings((currentSettings) => ({
          url: touchedSettingsRef.current.url ? currentSettings.url : storedSettings.url,
          password: currentSettings.password,
          textSourceName: touchedSettingsRef.current.textSourceName
            ? currentSettings.textSourceName
            : storedSettings.textSourceName,
        }));
        setSettingsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !settingsDirtyRef.current) return;
    settingsDirtyRef.current = false;
    void writeStoredSettings(settings);
  }, [settings, settingsLoaded]);

  const clearOverlayTimeout = useCallback(() => {
    if (!overlayTimeoutRef.current) return;

    clearTimeout(overlayTimeoutRef.current);
    overlayTimeoutRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearOverlayTimeout();
      clientRef.current?.disconnect();
      clientRef.current = null;
    },
    [clearOverlayTimeout],
  );

  const disconnect = useCallback(() => {
    if (recordingActive) return;

    connectingClientPromiseRef.current = null;
    clearOverlayTimeout();
    clientRef.current?.disconnect();
    clientRef.current = null;
    setRecordingSnapshot(null);
    setConnectionStatus('disconnected');
    setRecordingStatus('idle');
  }, [clearOverlayTimeout, recordingActive]);

  const updateSetting = useCallback(
    (key: keyof RecorderSettings, value: string) => {
      touchedSettingsRef.current[key] = true;
      if (key === 'url' || key === 'textSourceName') {
        settingsDirtyRef.current = true;
      }
      setSettings((current) => ({ ...current, [key]: value }));
      if ((key === 'url' || key === 'password') && clientRef.current) {
        disconnect();
      }
    },
    [disconnect],
  );

  const getRecorderErrorMessage = useCallback(
    (obsError: unknown) => {
      if (obsError instanceof ObsWebSocketClientError) {
        switch (obsError.code) {
          case 'connectTimeout':
            return t('settings.recorder.errors.connectTimeout');
          case 'connectFailed':
            return t('settings.recorder.errors.connectFailed');
          case 'websocketError':
            return t('settings.recorder.errors.websocketError');
          case 'websocketClosed':
          case 'disconnected':
            return t('settings.recorder.errors.websocketClosed');
          case 'identifyTimeout':
            return t('settings.recorder.errors.identifyTimeout');
          case 'notConnected':
          case 'notOpen':
            return t('settings.recorder.notConnected');
          case 'requestTimeout':
            return t('settings.recorder.errors.requestTimeout', {
              requestType: obsError.requestType ?? t('settings.recorder.errors.unknownRequest'),
            });
          case 'base64Unavailable':
          case 'webCryptoUnavailable':
            return t('settings.recorder.errors.authUnavailable');
          case 'websocketUnavailable':
            return t('settings.recorder.errors.browserUnsupported');
          case 'connectionFailed':
          case 'unsupportedMessage':
          case 'invalidJson':
            return t('settings.recorder.errors.unknownError');
        }
      }

      if (obsError instanceof ObsWebSocketRequestError) {
        return obsError.message || t('settings.recorder.errors.unknownError');
      }

      const obsMessage = getObsErrorMessage(obsError);
      if (obsMessage) {
        return obsMessage;
      }

      return t('settings.recorder.errors.unknownError');
    },
    [t],
  );

  const ensureConnected = useCallback(async () => {
    if (clientRef.current?.isConnected) {
      setConnectionStatus('connected');
      return clientRef.current;
    }

    if (connectingClientPromiseRef.current) {
      return connectingClientPromiseRef.current;
    }

    const url = settings.url.trim();
    if (!isValidObsWebsocketUrl(url)) {
      setConnectionStatus('disconnected');
      throw new Error(t('settings.recorder.invalidUrl'));
    }

    const client = new ObsWebSocketClient(url, settings.password || undefined, {
      onRecordStateChanged: ({ outputActive }) => {
        if (outputActive) {
          setRecordingStatus('recording');
          return;
        }

        clearOverlayTimeout();
        setRecordingStatus('idle');
        setRecordingSnapshot(null);
      },
      onDisconnected: () => {
        clearOverlayTimeout();
        setConnectionStatus('disconnected');
        setRecordingStatus('idle');
        setRecordingSnapshot(null);
        setError(t('settings.recorder.errors.websocketClosed'));
      },
    });
    clientRef.current = client;
    setConnectionStatus('connecting');

    const connectPromise = client
      .connect()
      .then(() => {
        setConnectionStatus('connected');
        setMessage(t('settings.recorder.connected'));
        return client;
      })
      .finally(() => {
        if (connectingClientPromiseRef.current === connectPromise) {
          connectingClientPromiseRef.current = null;
        }
      });
    connectingClientPromiseRef.current = connectPromise;
    return connectPromise;
  }, [clearOverlayTimeout, settings.password, settings.url, t]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setMessage(null);
    setLastOutputPath(null);

    try {
      await ensureConnected();
    } catch (connectError) {
      connectingClientPromiseRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
      setConnectionStatus('disconnected');
      setError(getRecorderErrorMessage(connectError));
    }
  }, [ensureConnected, getRecorderErrorMessage]);

  const setOverlayText = useCallback(
    async (client: ObsWebSocketClient, text: string) => {
      const inputName = settings.textSourceName.trim();
      if (!inputName) return;

      await client.setInputSettings(inputName, { text }, true);
    },
    [settings.textSourceName],
  );

  const scheduleOverlayClear = useCallback(() => {
    clearOverlayTimeout();

    overlayTimeoutRef.current = setTimeout(() => {
      const client = clientRef.current;
      overlayTimeoutRef.current = null;
      if (!client?.isConnected) return;

      void setOverlayText(client, '').catch(() => undefined);
    }, OVERLAY_VISIBLE_MS);
  }, [clearOverlayTimeout, setOverlayText]);

  const handleStartRecording = useCallback(async () => {
    if (!currentClimbQueueItem) {
      setError(t('settings.recorder.noCurrentClimb'));
      return;
    }

    const snapshot = currentClimbQueueItem;
    setError(null);
    setMessage(null);
    setLastOutputPath(null);
    setLastOutcome(null);
    setRecordingStatus('starting');

    try {
      const client = await ensureConnected();
      await setOverlayText(client, formatObsClimbOverlayText(snapshot, t('settings.recorder.currentClimbFallback')));
      await client.startRecording();
      setRecordingSnapshot(snapshot);
      setRecordingStatus('recording');
      setMessage(t('settings.recorder.recording', { climbName: snapshot.climb.name }));
      scheduleOverlayClear();
    } catch (startError) {
      connectingClientPromiseRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
      setConnectionStatus('disconnected');
      setRecordingStatus('idle');
      setError(getRecorderErrorMessage(startError));
    }
  }, [currentClimbQueueItem, ensureConnected, getRecorderErrorMessage, scheduleOverlayClear, setOverlayText, t]);

  const handleStopRecording = useCallback(
    async (outcome: RecordingOutcome) => {
      setLastOutputPath(null);
      setLastOutcome(null);

      const client = clientRef.current;
      if (!client?.isConnected) {
        setRecordingStatus('idle');
        setConnectionStatus('disconnected');
        setError(t('settings.recorder.notConnected'));
        return;
      }

      clearOverlayTimeout();

      setError(null);
      setMessage(null);
      setRecordingStatus('stopping');

      try {
        await setOverlayText(client, '').catch(() => undefined);
        const response = await client.stopRecording();
        setRecordingStatus('idle');
        setLastOutcome(outcome);
        setLastOutputPath(getOutputPath(response));
        setMessage(t(outcome === 'send' ? 'settings.recorder.sendSaved' : 'settings.recorder.failSaved'));
        setRecordingSnapshot(null);
      } catch (stopError) {
        if (isObsNotRecordingError(stopError)) {
          setRecordingStatus('idle');
          setMessage(t('settings.recorder.recordingAlreadyStopped'));
          setRecordingSnapshot(null);
          return;
        }

        setRecordingStatus('recording');
        setError(getRecorderErrorMessage(stopError));
      }
    },
    [clearOverlayTimeout, getRecorderErrorMessage, setOverlayText, t],
  );

  const activeRecordingText = recordingSnapshot
    ? formatObsClimbOverlayText(recordingSnapshot, t('settings.recorder.currentClimbFallback')).replace('\n', ' / ')
    : currentOverlayText.replace('\n', ' / ');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle2" sx={(theme) => ({ fontWeight: theme.typography.fontWeightBold })}>
          {t('settings.recorder.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('settings.recorder.description')}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          label={t('settings.recorder.url')}
          value={settings.url}
          onChange={(event) => updateSetting('url', event.target.value)}
          size="small"
          fullWidth
          disabled={!settingsLoaded || recordingActive}
        />
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 1,
          }}
        >
          <TextField
            label={t('settings.recorder.password')}
            value={settings.password}
            onChange={(event) => updateSetting('password', event.target.value)}
            size="small"
            type="password"
            autoComplete="new-password"
            fullWidth
            disabled={!settingsLoaded || recordingActive}
          />
          <TextField
            label={t('settings.recorder.textSourceName')}
            value={settings.textSourceName}
            onChange={(event) => updateSetting('textSourceName', event.target.value)}
            size="small"
            fullWidth
            disabled={!settingsLoaded || recordingActive}
            helperText={t('settings.recorder.textSourceHelp')}
          />
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Chip
          size="small"
          color={connected ? 'success' : 'default'}
          label={connected ? t('settings.recorder.statusConnected') : t('settings.recorder.statusDisconnected')}
        />
        <Typography
          variant="body2"
          color={currentClimbQueueItem ? 'text.primary' : 'text.secondary'}
          sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {currentOverlayText || t('settings.recorder.noCurrentClimbShort')}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(4, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
        <Button
          variant={connected ? 'outlined' : 'contained'}
          startIcon={<PowerSettingsNewOutlined />}
          onClick={
            connected
              ? disconnect
              : () => {
                  void handleConnect();
                }
          }
          disabled={
            connectionStatus === 'connecting' ||
            recordingStatus === 'starting' ||
            recordingStatus === 'recording' ||
            recordingStatus === 'stopping'
          }
        >
          {connected ? t('settings.recorder.disconnect') : t('settings.recorder.connect')}
        </Button>
        <Button
          variant="contained"
          color="error"
          startIcon={<FiberManualRecordOutlined />}
          onClick={() => {
            void handleStartRecording();
          }}
          disabled={!currentClimbQueueItem || recordingActive}
        >
          {recordingStatus === 'starting' ? t('settings.recorder.starting') : t('settings.recorder.startRecording')}
        </Button>
        <Button
          variant="outlined"
          color="success"
          startIcon={<CheckCircleOutlineOutlined />}
          onClick={() => {
            void handleStopRecording('send');
          }}
          disabled={recordingStatus !== 'recording'}
        >
          {t('settings.recorder.markSend')}
        </Button>
        <Button
          variant="outlined"
          color="warning"
          startIcon={recordingStatus === 'stopping' ? <StopCircleOutlined /> : <CancelOutlined />}
          onClick={() => {
            void handleStopRecording('fail');
          }}
          disabled={recordingStatus !== 'recording'}
        >
          {t('settings.recorder.markFail')}
        </Button>
      </Box>

      {activeRecordingText && recordingStatus === 'recording' && (
        <Typography variant="caption" color="text.secondary">
          {t('settings.recorder.activeRecording', { climb: activeRecordingText })}
        </Typography>
      )}

      {error && <Alert severity="error">{error}</Alert>}
      {message && !error && <Alert severity="info">{message}</Alert>}
      {lastOutputPath && (
        <Alert severity={lastOutcome === 'send' ? 'success' : 'warning'}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t('settings.recorder.outputPath')}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
            {lastOutputPath}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('settings.recorder.fileHandlingNote')}
          </Typography>
        </Alert>
      )}
    </Box>
  );
}
