// An embedded launch: no OTA update is running. Suites that assert update
// behaviour register their own vi.mock('expo-updates'), which takes precedence.
export const isEnabled = false;
export const updateId: string | null = null;
