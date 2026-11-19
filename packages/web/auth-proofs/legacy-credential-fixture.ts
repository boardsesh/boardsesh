import { vi } from 'vite-plus/test';
export { decode, encode, type JWT } from 'next-auth/jwt';

// The route proofs supply their database and exercise Boardsesh's session handlers.
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
