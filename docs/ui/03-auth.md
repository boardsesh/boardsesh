## Auth

### Login Page

**Web route:** `/auth/login`

**Mobile status:** Auth flow screen, not in tab navigator

**Layout:** Full-screen, `minHeight: 100vh`, `background: var(--semantic-background)`

**Header bar:** Fixed 64px height. Contains: BackButton (left), Logo (small, no text), "Boardsesh" title (h4).

**Main content:** Centered card, `maxWidth: 400px`, `paddingTop: 48px`

**Card contents:**

1. **Logo** (centered, size md)
2. **Subtitle** (body2, text.secondary): `login.subtitle`
3. **Tab selector** (MUI `Tabs`, centered):
   - "Sign In" tab (`login.tabs.signIn`, value `login`)
   - "Create Account" tab (`login.tabs.signUp`, value `register`)

4. **Sign In tab:**
   - Email field: `TextField` with `MailOutlined` start adornment, placeholder `login.placeholders.email`, validation `login.validation.emailRequired` / `login.validation.emailInvalid`
   - Password field: `TextField` type=password with `LockOutlined` start adornment, placeholder `login.placeholders.password`
   - Submit button: `Button` variant=contained, size=large, full width. Shows `CircularProgress` (16px) when loading. Label: `login.submit.signIn`
   - Form validates on submit. Errors shown via `helperText` on each field.

5. **Create Account tab:**
   - Name field (optional): `TextField` with `PersonOutlined` start adornment, placeholder `login.placeholders.name`
   - Email field: same as login
   - Password field: placeholder `login.placeholders.passwordWithMin` (mentions 8 char minimum)
   - Confirm password field: placeholder `login.placeholders.confirmPassword`
   - Submit button: label `login.submit.signUp`
   - Registration calls `/api/auth/register` POST
   - If `requiresVerification` in response: shows info toast, switches to login tab, pre-fills email
   - If no verification required: auto-signs in via `signIn('credentials', ...)` and redirects

6. **Divider** with text "or" (`login.divider`)

7. **Social login buttons** (`SocialLoginButtons` component):
   - Fetches available providers from `/api/auth/providers-config`
   - Google button: white background, Google color icon, "Continue with Google"
   - Apple button: black background, Apple icon, "Continue with Apple"
   - Facebook button: #1877F2 background, Facebook icon, "Continue with Facebook"
   - In native Capacitor app: uses `buildNativeOAuthSignInUrl()` for in-app browser OAuth
   - Loading state: Skeleton placeholders while providers config loads

**User actions:**

- Switch between Sign In / Create Account tabs
- Submit login form (Enter key or button tap)
- Submit registration form
- Tap social login button
- Tap back button

**States:**

- Loading: session status `loading` -- renders nothing
- Authenticated: session status `authenticated` -- redirects to `callbackUrl` (default `/`)
- Error from URL param `?error=CredentialsSignin` -- shows "Invalid credentials" toast
- Error from URL param `?error=<other>` -- shows generic "Authentication failed" toast
- Verified from URL param `?verified=true` -- shows "Email verified" success toast
- Login loading: submit button disabled with spinner
- Register loading: submit button disabled with spinner
- Field validation errors: red border + helper text on individual fields

**Data sources:**

- NextAuth `signIn()` for credential login
- `/api/auth/register` POST for registration
- `/api/auth/providers-config` GET for available OAuth providers
- `callbackUrl` query parameter for post-auth redirect

**Navigation:**

- Back button -> previous page
- Successful login -> `callbackUrl` or `/`
- Social login -> OAuth flow -> callback -> `callbackUrl`

**Mobile adaptation notes:**

- Replace MUI `Tabs` with segmented control or custom tab component
- Social login uses `expo-auth-session` or `expo-web-browser` for OAuth
- Apple Sign-In via `expo-apple-authentication`
- Google Sign-In via `@react-native-google-signin/google-signin`
- `KeyboardAvoidingView` for form fields
- `SecureStore` for token persistence

### Verify Request Page

**Web route:** `/auth/verify-request`

**Mobile status:** Auth flow screen

**Layout:** Same shell as login page (header bar + centered card)

**Card contents:**

- If no error: Mail icon (48px, primary color), "Check your email" title (h3), description text
- If error (from `?error=` param, codes: `EmailNotVerified`, `InvalidToken`, `TokenExpired`, `TooManyAttempts`): Cancel icon (48px, error color), Alert with error message
- Email input field with `MailOutlined` adornment for resend
- "Resend verification email" button (contained, large, full width, shows spinner when loading)
- "Back to login" text button linking to `/auth/login`

**Data:** POST to `/api/auth/resend-verification` with `{ email }`

### Error Page

**Web route:** `/auth/error`

**Mobile status:** Auth flow screen

**Layout:** Same shell as login page

**Card contents:**

- Cancel icon (48px, error color)
- "Authentication Error" title (h3)
- Alert (severity=error) with localized message based on `?error=` param
- Known error codes: `Configuration`, `AccessDenied`, `Verification`, `OAuthSignin`, `OAuthCallback`, `OAuthCreateAccount`, `OAuthEmailRequired`, `EmailCreateAccount`, `Callback`, `OAuthAccountNotLinked`, `SessionRequired`
- "Back to login" button (contained, large, full width) linking to `/auth/login`

### Native Start Page

**Web route:** `/auth/native-start`

**Mobile status:** Not needed in React Native (OAuth handled natively)

This page is a web-only entry point for mobile OAuth flows. It auto-submits a hidden form to the NextAuth provider endpoint. Shows a `CircularProgress` spinner and "Signing in..." text. Only allows providers: `google`, `apple`, `facebook`.

---
