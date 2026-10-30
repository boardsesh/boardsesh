/** Bounded command names shared by the phone-flow compiler and readiness server. */
export const MAX_IOS_CAMPAIGN_PHONE_COMMANDS = 32;
export const MAX_IOS_CAMPAIGN_DUO_COMMANDS = 8;

export function iosCampaignPhoneScene(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_IOS_CAMPAIGN_PHONE_COMMANDS) {
    throw new Error(`Campaign phone scene index must be an integer from 0 to ${MAX_IOS_CAMPAIGN_PHONE_COMMANDS - 1}`);
  }
  return `campaign-phone-climbs-${index}`;
}

export function iosCampaignDuoScene(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_IOS_CAMPAIGN_DUO_COMMANDS) {
    throw new Error(`Campaign Duo scene index must be an integer from 0 to ${MAX_IOS_CAMPAIGN_DUO_COMMANDS - 1}`);
  }
  return `campaign-duo-climbs-${index}`;
}
