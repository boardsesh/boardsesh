import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface Session {
    authSessionId?: string;
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface JWT {
    authSessionId?: string;
  }
}
