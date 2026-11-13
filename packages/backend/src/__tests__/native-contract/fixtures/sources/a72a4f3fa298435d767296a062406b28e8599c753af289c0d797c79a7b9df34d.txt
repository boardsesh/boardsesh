import type { PostHog } from 'posthog-react-native';

type OtaSuperProperties = Record<string, string | boolean | null>;
let launchProperties: OtaSuperProperties | null = null;

/** Remember build context before the consent-controlled SDK has been constructed. */
export function rememberOtaSuperProperties(properties: OtaSuperProperties): void {
  launchProperties = properties;
}

export function reregisterOtaSuperProperties(client: Pick<PostHog, 'register'>): void {
  if (launchProperties) void Promise.resolve(client.register(launchProperties)).catch(() => {});
}
