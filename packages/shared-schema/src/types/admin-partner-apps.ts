export interface AdminPartnerApp {
  clientId: string;
  name: string | null;
  publisherName: string | null;
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  homepageUrl: string | null;
  createdAt: string;
  disabled: boolean;
  suspendedAt: string | null;
  suspensionReason: string | null;
  activeConnections: number;
  newConnectionsLast24Hours: number;
  maxActiveConnections: number;
  maxNewConnectionsPerDay: number;
}

export interface AdminPartnerAppsInput {
  query?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface AdminPartnerAppConnection {
  apps: AdminPartnerApp[];
  totalCount: number;
  hasMore: boolean;
}

export interface UpdatePartnerAppLimitsInput {
  clientId: string;
  maxActiveConnections: number;
  maxNewConnectionsPerDay: number;
}
