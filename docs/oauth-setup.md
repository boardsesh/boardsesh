# OAuth and Email Verification Setup

This guide covers setting up OAuth authentication providers (Google, Apple, Facebook) and email verification for Boardsesh.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [OAuth Provider Setup](#oauth-provider-setup)
  - [Google OAuth](#1-google-oauth)
  - [Apple Sign-In](#2-apple-sign-in)
  - [Facebook OAuth](#3-facebook-oauth)
- [Email Verification Setup](#email-verification-setup)
- [Testing](#testing)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Boardsesh uses NextAuth.js v4 for authentication with the following components:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                          │
├─────────────────────────────────────────────────────────────────┤
│  SocialLoginButtons  │  AuthPageContent  │  AuthModal           │
│  (dynamic provider   │  (login/register  │  (modal auth flow)   │
│   discovery)         │   forms)          │                      │
└──────────┬───────────┴────────┬──────────┴──────────────────────┘
           │                    │
           ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                     NextAuth.js API Routes                       │
├─────────────────────────────────────────────────────────────────┤
│  /api/auth/[...nextauth]  - Core NextAuth handlers              │
│  /api/auth/providers-config - Available providers endpoint      │
│  /api/auth/register - Email/password registration               │
│  /api/auth/verify-email - Email verification callback           │
│  /api/auth/resend-verification - Resend verification emails     │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Auth Configuration                           │
├─────────────────────────────────────────────────────────────────┤
│  packages/web/app/lib/auth/auth-options.ts                      │
│  - Conditional OAuth providers (Google, Apple, Facebook)        │
│  - Credentials provider (email/password)                        │
│  - JWT session strategy                                         │
│  - DrizzleAdapter for database persistence                      │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Database (PostgreSQL)                        │
├─────────────────────────────────────────────────────────────────┤
│  users              - User accounts                             │
│  accounts           - OAuth provider accounts (linked)          │
│  sessions           - Active sessions                           │
│  verificationTokens - Email verification tokens                 │
│  userCredentials    - Password hashes (separate from users)     │
│  userProfiles       - Display preferences                       │
└─────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Conditional Providers**: OAuth buttons only appear when provider credentials are configured
- **Email Verification**: New email/password accounts require email verification
- **Account Linking**: OAuth users can add passwords; password users cannot add OAuth (security)
- **JWT Sessions**: Stateless authentication with 5-minute refresh interval
- **Rate Limiting**: In-memory rate limiting on auth endpoints (best-effort in serverless)

---

## Prerequisites

Before setting up OAuth providers, ensure you have:

1. **Node.js 18+** installed
2. **PostgreSQL database** running (via `bun run db:up` for local dev)
3. **NEXTAUTH_SECRET** generated:
   ```bash
   openssl rand -base64 32
   ```
4. **NEXTAUTH_URL** set to your application URL

---

## Environment Variables

Add these to `packages/web/.env.development.local` (local) or your production environment:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXTAUTH_SECRET` | Session encryption key (32+ chars) | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Your app's base URL | `http://localhost:3000` |

### OAuth Providers (Optional - configure as needed)

| Variable | Provider | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google | OAuth Client Secret |
| `APPLE_ID` | Apple | Services ID (e.g., `com.boardsesh.signin`) |
| `APPLE_SECRET` | Apple | JWT secret (regenerate every 6 months) |
| `FACEBOOK_CLIENT_ID` | Facebook | App ID |
| `FACEBOOK_CLIENT_SECRET` | Facebook | App Secret |

### Email (Required for email verification)

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname | `smtp.fastmail.com` |
| `SMTP_PORT` | SMTP port | `465` |
| `SMTP_USER` | SMTP username/email | - |
| `SMTP_PASSWORD` | SMTP app password | - |
| `EMAIL_FROM` | Sender email address | Same as `SMTP_USER` |

### Example Configuration

```bash
# Core NextAuth
NEXTAUTH_SECRET=your-32-character-secret-here
NEXTAUTH_URL=http://localhost:3000

# Google OAuth
GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxx

# Apple Sign-In
APPLE_ID=com.boardsesh.signin
APPLE_SECRET=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...

# Facebook OAuth
FACEBOOK_CLIENT_ID=1234567890
FACEBOOK_CLIENT_SECRET=abcdef1234567890

# Email (Fastmail)
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_USER=your-email@fastmail.com
SMTP_PASSWORD=your-app-password
EMAIL_FROM=your-email@fastmail.com
```

---

## OAuth Provider Setup

### 1. Google OAuth

**Difficulty**: Easy | **Time**: ~10 minutes

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth client ID**
5. Select **Web application** as the application type
6. Configure authorized origins and redirects:

   | Environment | JavaScript Origins | Redirect URIs |
   |-------------|-------------------|---------------|
   | Development | `http://localhost:3000` | `http://localhost:3000/api/auth/callback/google` |
   | Production | `https://your-domain.com` | `https://your-domain.com/api/auth/callback/google` |

7. Copy **Client ID** and **Client Secret** to environment variables

### 2. Apple Sign-In

**Difficulty**: Hard | **Time**: ~30-60 minutes | **Requires**: Paid Apple Developer Account ($99/year)

> **Important**: Apple Sign-In requires HTTPS. Use ngrok for local development.

#### Step 1: Create an App ID

1. Go to [Apple Developer Portal](https://developer.apple.com/) > **Certificates, Identifiers & Profiles**
2. Go to **Identifiers** > Click **+**
3. Select **App IDs** > Continue
4. Choose **App** type > Continue
5. Fill in:
   - Description: `Boardsesh`
   - Bundle ID: `com.boardsesh.app` (explicit)
6. Enable **Sign In with Apple** capability
7. Register the App ID

#### Step 2: Create a Services ID

1. Go to **Identifiers** > Click **+**
2. Select **Services IDs** > Continue
3. Fill in:
   - Description: `Boardsesh Web Auth`
   - Identifier: `com.boardsesh.signin`
4. Enable **Sign In with Apple**
5. Click **Configure**:
   - Primary App ID: Select `Boardsesh` (created above)
   - Domains: Add your domain(s)
     - `your-domain.com` (production)
     - `xxxx.ngrok.io` (development - get from ngrok)
   - Return URLs:
     - `https://your-domain.com/api/auth/callback/apple`
     - `https://xxxx.ngrok.io/api/auth/callback/apple`
6. Save and Register

#### Step 3: Create a Key

1. Go to **Keys** > Click **+**
2. Enter name: `Boardsesh Sign In Key`
3. Enable **Sign In with Apple**
4. Click **Configure** > Select Primary App ID > Save
5. Click **Continue** > **Register**
6. **Download the `.p8` key file** (you can only download once!)
7. Note the **Key ID** displayed

#### Step 4: Generate the Apple Secret JWT

Apple requires a JWT that expires every 6 months. Create it with this script:

```javascript
// generate-apple-secret.js
const jwt = require('jsonwebtoken');
const fs = require('fs');

// Your values from Apple Developer Portal
const TEAM_ID = 'XXXXXXXXXX';      // Found in Membership details
const KEY_ID = 'XXXXXXXXXX';        // Key ID from Step 3
const SERVICE_ID = 'com.boardsesh.signin';  // Services ID from Step 2
const KEY_FILE = './AuthKey_XXXXXXXX.p8';   // Downloaded key file

const privateKey = fs.readFileSync(KEY_FILE);

const token = jwt.sign({}, privateKey, {
  algorithm: 'ES256',
  expiresIn: '180d',
  audience: 'https://appleid.apple.com',
  issuer: TEAM_ID,
  subject: SERVICE_ID,
  keyid: KEY_ID,
});

console.log('APPLE_SECRET=' + token);
console.log('\nThis token expires in 180 days. Set a reminder to regenerate!');
```

Run it:
```bash
bun add jsonwebtoken
node generate-apple-secret.js
```

#### Local Development with ngrok

```bash
# Install ngrok
bun install -g ngrok

# Start tunnel (in a separate terminal)
ngrok http 3000

# Use the https URL from ngrok output
# Update NEXTAUTH_URL and Apple Services ID configuration
```

### 3. Facebook OAuth

**Difficulty**: Medium | **Time**: ~15 minutes

1. Go to [Facebook Developers](https://developers.facebook.com/)
2. Click **My Apps** > **Create App**
3. Select **Consumer** as app type > Next
4. Fill in app details and create

5. In the app dashboard:
   - Go to **Settings** > **Basic**
   - Copy **App ID** and **App Secret**

6. Add Facebook Login product:
   - Click **Add Product** > Find **Facebook Login** > **Set Up**
   - Go to **Facebook Login** > **Settings**
   - Add Valid OAuth Redirect URIs:
     - `http://localhost:3000/api/auth/callback/facebook`
     - `https://your-domain.com/api/auth/callback/facebook`

7. For production:
   - Go to **Settings** > **Basic**
   - Add Privacy Policy URL and Terms of Service URL
   - Toggle app to **Live** mode

---

## Email Verification Setup

Email verification is required for email/password accounts. OAuth accounts are pre-verified by the provider.

### Fastmail Setup (Recommended)

1. Log in to [Fastmail](https://www.fastmail.com/)
2. Go to **Settings** > **Password & Security** > **Third-party apps**
3. Click **New app password**
4. Name it: `Boardsesh Email`
5. Copy the generated password

### Other SMTP Providers

| Provider | Host | Port | Notes |
|----------|------|------|-------|
| Fastmail | `smtp.fastmail.com` | 465 (SSL) | Recommended |
| Gmail | `smtp.gmail.com` | 587 (TLS) | Requires App Password |
| SendGrid | `smtp.sendgrid.net` | 587 | Use API key as password |
| Mailgun | `smtp.mailgun.org` | 587 | Use SMTP credentials |

### Email Template

Verification emails are sent using a styled HTML template that matches the Boardsesh design system. The template includes:

- Branded header with primary color
- Clear call-to-action button
- Plain text link fallback
- 24-hour expiration notice

---

## Testing

### 1. Test Email Verification

```bash
# Start development server
bun run dev

# Navigate to login page
open http://localhost:3000/auth/login
```

1. Click **Create Account** tab
2. Enter email, password, and name
3. Submit the form
4. Check inbox for verification email
5. Click verification link
6. Login with credentials

### 2. Test OAuth Providers

**Google:**
1. Ensure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set
2. Restart dev server
3. Click "Continue with Google"
4. Complete Google sign-in
5. Verify redirect back to app

**Apple:**
1. Start ngrok: `ngrok http 3000`
2. Update `NEXTAUTH_URL` to ngrok URL
3. Ensure Apple Services ID has ngrok domain
4. Click "Continue with Apple"
5. Complete Apple sign-in

**Facebook:**
1. Ensure Facebook app is in Development mode (for testing)
2. Add your Facebook account as a tester
3. Click "Continue with Facebook"
4. Complete Facebook sign-in

### 3. Verify Provider Discovery

Check that only configured providers appear:

```bash
curl http://localhost:3000/api/auth/providers-config
# Returns: {"google":true,"apple":false,"facebook":false}
```

---

## Production Deployment

### Checklist

- [ ] **NEXTAUTH_SECRET**: Strong, unique secret (32+ characters)
- [ ] **NEXTAUTH_URL**: Production URL (no trailing slash)
- [ ] **OAuth Redirect URIs**: Updated for production domain
- [ ] **SMTP Credentials**: Production email service configured
- [ ] **Apple Secret**: Valid JWT (check expiration date)
- [ ] **Facebook App**: In Live mode
- [ ] **Database**: Migrations applied

### Vercel Deployment

1. Add environment variables in Vercel dashboard:
   - Project Settings > Environment Variables
   - Add all required variables

2. The `NEXTAUTH_URL` can be omitted on Vercel (auto-detected)

3. Ensure callback URLs are added to OAuth providers:
   - `https://your-app.vercel.app/api/auth/callback/[provider]`

### Security Recommendations

1. **Rotate secrets regularly**:
   - `NEXTAUTH_SECRET`: Every 6-12 months
   - `APPLE_SECRET`: Every 6 months (required)
   - SMTP passwords: Follow provider recommendations

2. **Monitor authentication**:
   - Enable logging for failed auth attempts
   - Set up alerts for unusual patterns

3. **Rate limiting**:
   - Current implementation uses in-memory storage
   - For production with strict requirements, consider Redis-based rate limiting:
     ```bash
     bun add @upstash/ratelimit @upstash/redis
     ```

4. **HTTPS only**:
   - All production OAuth must use HTTPS
   - Cookies are secure by default in production

---

## Troubleshooting

### "redirect_uri_mismatch" Error

**Cause**: OAuth callback URL doesn't match registered URL

**Solution**:
1. Check redirect URI in provider console exactly matches
2. Watch for:
   - Trailing slashes (`/api/auth/callback/google` vs `/api/auth/callback/google/`)
   - Protocol mismatch (`http` vs `https`)
   - Port numbers in development

### Apple Sign-In Not Working

**Cause 1**: Using HTTP instead of HTTPS
- Apple requires HTTPS
- Use ngrok for local development

**Cause 2**: Expired Apple Secret JWT
- JWT expires every 6 months
- Regenerate using the script above

**Cause 3**: Domain not registered
- Add domain to Apple Services ID configuration
- Include ngrok domains for development

### Email Not Sending

**Check**:
1. SMTP credentials are correct
2. App password is active (not main password)
3. Server logs for SMTP errors:
   ```bash
   bun run dev
   # Look for "Failed to send verification email" in console
   ```

### "OAuthAccountNotLinked" Error

**Cause**: User already has an account with different auth method

**Example**: User registered with email/password, then tried Google sign-in with same email

**Solution**:
- Users must sign in with their original method
- Account linking from OAuth to password is supported
- Account linking from password to OAuth is blocked (security)

### Social Buttons Not Appearing

**Check**:
1. Provider environment variables are set
2. Server was restarted after adding variables
3. Check API response:
   ```bash
   curl http://localhost:3000/api/auth/providers-config
   ```

### Session Not Persisting

**Check**:
1. `NEXTAUTH_SECRET` is consistent across deployments
2. Cookies are not being blocked by browser
3. Session callback in `auth-options.ts` includes user ID

---

## Native App Authentication (Capacitor)

OAuth in the Capacitor WebView requires special handling because the WebView and the external browser (Chrome Custom Tab / SFSafariViewController) have **separate cookie jars**. Calling `signIn()` from the WebView would set OAuth state cookies that the external browser never sees, breaking the callback.

### Transfer Token Flow

Instead, the entire OAuth flow runs in the external browser, and the result is transferred back to the WebView via a short-lived HMAC-signed token:

1. **User taps a social login button** in the WebView
2. The Capacitor Browser plugin opens `/auth/native-start?provider=google&callbackUrl=...` in the external browser
3. That page fetches a CSRF token and auto-submits the NextAuth sign-in form — all in the external browser's cookie context
4. The OAuth provider flow completes normally (redirect to Google/Apple/Facebook → callback → session created in external browser)
5. NextAuth redirects to `/api/auth/native/callback`, which reads the session, issues a **transfer token** (HMAC-SHA256 signed, 120s TTL), and redirects to `com.boardsesh.app://auth/callback?transferToken=...`
6. The native app intercepts the deep link, closes the external browser, and calls `signIn('native-oauth', { transferToken })` inside the WebView
7. The `native-oauth` credentials provider verifies the token signature/expiry/iat, looks up the user, and creates a session in the WebView

### Key Files

| File | Purpose |
|------|---------|
| `packages/web/app/lib/auth/native-oauth-transfer.ts` | Issue and verify HMAC-signed transfer tokens |
| `packages/web/app/api/auth/native/callback/route.ts` | Server endpoint that issues a transfer token and redirects to the deep link |
| `packages/web/app/auth/native-start/` | Auto-submit page opened in the external browser to start the OAuth flow |
| `packages/web/app/components/providers/session-provider.tsx` | Listens for `appUrlOpen` deep links and completes the sign-in in the WebView |
| `packages/web/app/components/auth/social-login-buttons.tsx` | Detects Capacitor and opens the external browser instead of calling `signIn()` |
| `packages/web/app/lib/auth/auth-options.ts` | Contains the `native-oauth` credentials provider |

### Security Properties

- Transfer tokens are HMAC-SHA256 signed with `NEXTAUTH_SECRET` — cannot be forged without the server secret
- 120-second TTL with both `exp` and `iat` validation (rejects tokens issued in the future)
- Path sanitization on both issue and verify (only relative paths starting with `/` are accepted)
- The token only carries a user ID — the credentials provider re-fetches the user from the database to confirm existence

### No Additional Environment Variables

The native OAuth flow reuses `NEXTAUTH_SECRET` for token signing. No extra configuration is needed beyond the standard OAuth provider setup described above.

---

## Related Documentation

- [NextAuth.js Documentation](https://next-auth.js.org/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [WebSocket Authentication](./websocket-implementation.md) - How auth integrates with real-time features
- [Mobile App Plan](./mobile-app-plan.md) - Capacitor architecture and auth persistence strategy
