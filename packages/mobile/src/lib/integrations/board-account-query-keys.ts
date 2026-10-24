// Kept free of runtime imports so the root query client can use the key
// without pulling the native-module graph behind the credentials fetcher.
export const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;
export const AURORA_UNSYNCED_QUERY_KEY = ['auroraCredentials', 'unsynced'] as const;
