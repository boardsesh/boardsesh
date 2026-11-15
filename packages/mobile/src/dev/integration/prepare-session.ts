export type IntegrationSessionSetup = {
  resolveSession: () => Promise<{ status: string }>;
  signIn: () => Promise<{ success: boolean; status?: number | null }>;
  preparePreferences: () => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
};

/** Setup finishes before the ordinary application's authentication gate mounts. */
export async function prepareIntegrationSession(setup: IntegrationSessionSetup): Promise<void> {
  await setup.preparePreferences();
  const session = await setup.resolveSession();
  if (session.status === 'authenticated') return;
  if (session.status !== 'anonymous') throw new Error(`Integration session is ${session.status}`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await setup.signIn();
    if (result.success) {
      const signedIn = await setup.resolveSession();
      if (signedIn.status !== 'authenticated') throw new Error(`Integration sign-in resolved to ${signedIn.status}`);
      return;
    }
    if (result.status != null && result.status < 500)
      throw new Error(`Integration sign-in rejected (${result.status})`);
    if (attempt < 3) await setup.sleep(attempt * 2000);
  }
  throw new Error('Integration sign-in failed after three attempts');
}
