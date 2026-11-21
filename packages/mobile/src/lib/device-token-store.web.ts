// Browser target's fork of device-token-store.ts: stores nothing and sends
// nothing. The browser app signs in through www, where an HttpOnly cookie does
// the device-recognition job (#7656), and the backend's CORS does not allow the
// native request header, so a browser that sent it would fail the preflight and
// could not sign in. This file must never name that header;
// device-token-web-fork.test.ts checks every `.web` file for it.

export async function rememberDeviceTokenFromReply(
  _reply: unknown,
  _options?: { email?: string; jwt?: string },
): Promise<void> {}

export async function deviceTokenHeadersForCredentialsSignIn(_email: string): Promise<Record<string, string>> {
  return {};
}

export async function forgetDeviceTokenForAccount(_userId: string): Promise<void> {}
