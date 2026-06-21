import * as WebBrowser from 'expo-web-browser';
import { reportError } from './error-reporting';

export const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';

type DiscordInviteSource = 'about' | 'user-drawer' | 'acknowledgements' | 'login';

export async function openDiscordInvite(source: DiscordInviteSource): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(DISCORD_INVITE_URL);
  } catch (error) {
    reportError(error, { tags: { source } });
  }
}
