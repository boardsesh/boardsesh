-- Better Auth tables
-- Separate from NextAuth tables to allow dual-auth during transition.
-- Users table is shared; accounts, sessions, and verifications are separate.

-- Better Auth accounts table (separate from NextAuth accounts)
-- Better Auth uses a single-column PK and stores credential password hashes here
CREATE TABLE IF NOT EXISTS "ba_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "providerId" text NOT NULL,
  "accountId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ba_accounts_user_idx" ON "ba_accounts" ("userId");

-- Better Auth sessions table
CREATE TABLE IF NOT EXISTS "ba_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ba_sessions_token_idx" ON "ba_sessions" ("token");
CREATE INDEX IF NOT EXISTS "ba_sessions_user_idx" ON "ba_sessions" ("userId");

-- Better Auth verification table
CREATE TABLE IF NOT EXISTS "ba_verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now(),
  "updatedAt" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ba_verifications_identifier_idx" ON "ba_verifications" ("identifier");
