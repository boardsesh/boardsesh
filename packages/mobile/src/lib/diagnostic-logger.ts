import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPostHogClient } from './posthog-client';

export const isDiagnosticLoggingEnabled = process.env.EXPO_PUBLIC_BOARDSESH_DIAGNOSTIC_LOGGING === '1';

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
type DiagnosticStatus = 'idle' | 'uploading' | 'sent' | 'error';
type DiagnosticPropertyValue = string | number | boolean | null;
type DiagnosticProperties = Record<string, unknown>;
export type DiagnosticMode = 'normal' | 'no_overlays' | 'no_thumbnails' | 'bare_climbs';
export const DEFAULT_DIAGNOSTIC_MODE: DiagnosticMode = 'bare_climbs';

type DiagnosticRecord = {
  id: string;
  sessionId: string;
  timestamp: string;
  level: DiagnosticLevel;
  message: string;
  properties: Record<string, DiagnosticPropertyValue>;
};

export type DiagnosticState = {
  enabled: boolean;
  sessionId: string | null;
  pendingCount: number;
  status: DiagnosticStatus;
  lastError: string | null;
  mode: DiagnosticMode;
};

type DiagnosticPostHogClient = {
  capture?: (event: string, properties?: Record<string, DiagnosticPropertyValue>) => unknown;
  captureLog?: (
    level: DiagnosticLevel,
    message: string,
    properties?: Record<string, DiagnosticPropertyValue>,
  ) => unknown;
  flush?: () => Promise<unknown>;
  flushLogs?: () => Promise<unknown>;
};

const SESSION_STORAGE_KEY = 'boardsesh:diagnostic-session-id:v1';
const MODE_STORAGE_KEY = 'boardsesh:diagnostic-mode:v1';
const PENDING_STORAGE_KEY = 'boardsesh:diagnostic-pending-records:v1';
const MAX_PENDING_RECORDS = 400;
const MAX_PROPERTY_STRING_LENGTH = 240;

let sessionId: string | null = null;
let state: DiagnosticState = {
  enabled: isDiagnosticLoggingEnabled,
  sessionId: null,
  pendingCount: 0,
  status: 'idle',
  lastError: null,
  mode: DEFAULT_DIAGNOSTIC_MODE,
};
let storageQueue: Promise<void> = Promise.resolve();
let uploadQueued = false;
let modeLoaded = false;
const listeners = new Set<(nextState: DiagnosticState) => void>();

function emitState(partial: Partial<DiagnosticState>): void {
  state = { ...state, ...partial };
  for (const listener of listeners) listener(state);
}

export function getDiagnosticState(): DiagnosticState {
  return state;
}

export function subscribeDiagnosticState(listener: (nextState: DiagnosticState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

function makeSessionId(): string {
  return `diag-${makeDiagnosticId().slice(0, 8)}`;
}

function makeDiagnosticId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureSessionId(): Promise<string> {
  if (sessionId) return sessionId;
  const stored = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
  sessionId = stored ?? makeSessionId();
  if (!stored) await AsyncStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  emitState({ sessionId });
  return sessionId;
}

function isDiagnosticMode(value: string | null): value is DiagnosticMode {
  return value === 'normal' || value === 'no_overlays' || value === 'no_thumbnails' || value === 'bare_climbs';
}

async function ensureDiagnosticMode(): Promise<DiagnosticMode> {
  if (modeLoaded) return state.mode;
  const stored = await AsyncStorage.getItem(MODE_STORAGE_KEY);
  const mode = isDiagnosticMode(stored) ? stored : DEFAULT_DIAGNOSTIC_MODE;
  modeLoaded = true;
  emitState({ mode });
  return mode;
}

export function getDiagnosticMode(): DiagnosticMode {
  return state.mode;
}

export function setDiagnosticMode(mode: DiagnosticMode): void {
  if (!isDiagnosticLoggingEnabled) return;
  void queueStorageMutation(async () => {
    modeLoaded = true;
    await AsyncStorage.setItem(MODE_STORAGE_KEY, mode);
    emitState({ mode });
  }).then(() => {
    logDiagnostic('diagnostic_mode_changed', { mode });
  });
}

function sanitizeValue(value: unknown): DiagnosticPropertyValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return value.length > MAX_PROPERTY_STRING_LENGTH ? `${value.slice(0, MAX_PROPERTY_STRING_LENGTH)}...` : value;
  }
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function sanitizeProperties(properties: DiagnosticProperties | undefined): Record<string, DiagnosticPropertyValue> {
  const safeProperties: Record<string, DiagnosticPropertyValue> = {
    diagnostic_platform: 'mobile',
  };
  for (const [key, value] of Object.entries(properties ?? {})) {
    const sanitizedValue = sanitizeValue(value);
    if (sanitizedValue !== undefined) safeProperties[key] = sanitizedValue;
  }
  return safeProperties;
}

async function readPendingRecords(): Promise<DiagnosticRecord[]> {
  const raw = await AsyncStorage.getItem(PENDING_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is DiagnosticRecord => {
      if (typeof record !== 'object' || record === null) return false;
      const candidate = record as Partial<DiagnosticRecord>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.sessionId === 'string' &&
        typeof candidate.timestamp === 'string' &&
        typeof candidate.level === 'string' &&
        typeof candidate.message === 'string' &&
        typeof candidate.properties === 'object' &&
        candidate.properties !== null
      );
    });
  } catch {
    return [];
  }
}

async function writePendingRecords(records: DiagnosticRecord[]): Promise<void> {
  const cappedRecords = records.slice(-MAX_PENDING_RECORDS);
  await AsyncStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(cappedRecords));
  emitState({ pendingCount: cappedRecords.length });
}

function asDiagnosticPostHogClient(): DiagnosticPostHogClient | null {
  return getPostHogClient() as unknown as DiagnosticPostHogClient | null;
}

async function sendRecord(record: DiagnosticRecord): Promise<void> {
  const posthog = asDiagnosticPostHogClient();
  if (!posthog) throw new Error('PostHog client unavailable');
  const properties: Record<string, DiagnosticPropertyValue> = {
    ...record.properties,
    diagnostic_session_id: record.sessionId,
    diagnostic_record_id: record.id,
    diagnostic_timestamp: record.timestamp,
    diagnostic_level: record.level,
    diagnostic_message: record.message,
  };

  try {
    posthog.captureLog?.(record.level, record.message, properties);
  } catch {
    // Some PostHog SDK versions expose logs with a different runtime signature.
    // The event below is the compatibility path we always send.
  }
  posthog.capture?.('Mobile Diagnostic Log', properties);
  await posthog.flushLogs?.();
  await posthog.flush?.();
}

function queueStorageMutation(work: () => Promise<void>): Promise<void> {
  storageQueue = storageQueue.then(work, work).catch((error: unknown) => {
    emitState({ status: 'error', lastError: error instanceof Error ? error.message : String(error) });
  });
  return storageQueue;
}

function queueUpload(): void {
  if (uploadQueued) return;
  uploadQueued = true;
  void queueStorageMutation(async () => {
    uploadQueued = false;
    const records = await readPendingRecords();
    if (records.length === 0) {
      emitState({ status: 'sent', lastError: null, pendingCount: 0 });
      return;
    }

    emitState({ status: 'uploading', lastError: null, pendingCount: records.length });
    const unsentRecords: DiagnosticRecord[] = [];
    for (const record of records) {
      try {
        await sendRecord(record);
      } catch (error) {
        unsentRecords.push(record);
        emitState({ status: 'error', lastError: error instanceof Error ? error.message : String(error) });
      }
    }
    await writePendingRecords(unsentRecords);
    if (unsentRecords.length === 0) emitState({ status: 'sent', lastError: null });
  });
}

export function initializeDiagnostics(): void {
  if (!isDiagnosticLoggingEnabled) return;
  void queueStorageMutation(async () => {
    await ensureSessionId();
    await ensureDiagnosticMode();
    const records = await readPendingRecords();
    emitState({ pendingCount: records.length });
  }).then(queueUpload);
}

export function flushDiagnosticLogs(): Promise<void> {
  if (!isDiagnosticLoggingEnabled) return Promise.resolve();
  queueUpload();
  return storageQueue;
}

export function logDiagnostic(
  message: string,
  properties?: DiagnosticProperties,
  level: DiagnosticLevel = 'info',
): void {
  if (!isDiagnosticLoggingEnabled) return;
  const recordPromise = async () => {
    const currentSessionId = await ensureSessionId();
    const currentMode = await ensureDiagnosticMode();
    const record: DiagnosticRecord = {
      id: makeDiagnosticId(),
      sessionId: currentSessionId,
      timestamp: new Date().toISOString(),
      level,
      message,
      properties: { ...sanitizeProperties(properties), diagnostic_mode: currentMode },
    };
    const records = await readPendingRecords();
    await writePendingRecords([...records, record]);
    console.info(`[boardsesh-diagnostics] ${message}`, record.properties);
  };
  void queueStorageMutation(recordPromise).then(queueUpload);
}

export function boardDiagnosticProperties(board: {
  uuid?: string | null;
  boardType?: string | null;
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: string | null;
  angle?: number | null;
}): Record<string, DiagnosticPropertyValue> {
  return {
    boardUuid: board.uuid ?? null,
    boardName: board.boardType ?? null,
    layoutId: board.layoutId ?? null,
    sizeId: board.sizeId ?? null,
    setIds: board.setIds ?? null,
    angle: board.angle ?? null,
  };
}
