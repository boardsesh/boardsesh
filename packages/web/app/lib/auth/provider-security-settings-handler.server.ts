import 'server-only';
import { createProviderSecuritySettingsBroker } from './provider-security-settings.server';

/** Shared server configuration, never caller-selected. Public readiness stays
 * code-owned and false until the complete browser flow is qualified. */
export const providerSecuritySettingsHandler = createProviderSecuritySettingsBroker();
