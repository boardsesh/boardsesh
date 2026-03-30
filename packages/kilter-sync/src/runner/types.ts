export interface KilterSyncRunnerConfig {
  onLog?: (message: string) => void;
  onError?: (error: Error, context: { userId?: string }) => void;
}

export interface KilterSyncSummary {
  total: number;
  successful: number;
  failed: number;
  errors: KilterSyncError[];
}

export interface KilterSyncError {
  userId: string;
  error: string;
}

export interface KilterCredentialRecord {
  userId: string;
  boardType: string;
  encryptedUsername: string | null;
  encryptedPassword: string | null;
  auroraUserId: number | null;
  auroraToken: string | null;
  syncStatus: string | null;
  syncError: string | null;
  lastSyncAt: Date | null;
}
