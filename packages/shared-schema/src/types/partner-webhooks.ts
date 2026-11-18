export interface PartnerWebhookSettings {
  clientId: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  previousSecretExpiresAt: string | null;
}
export interface PartnerWebhookCredentials {
  settings: PartnerWebhookSettings;
  secret: string | null;
}
export interface PartnerWebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
export interface UpdatePartnerWebhookInput {
  clientId: string;
  url: string;
  events: string[];
  enabled: boolean;
}
