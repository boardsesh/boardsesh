export const PREVIEW_PROJECT: 'boardsesh-app-previews';

export type PreviewSummary = { prNumber: number; sha?: string; createdOn?: string };
export type PreviewDomain = { hostname: string; branch: string; url: string };
export type CloudflarePreviewClient = {
  ensureProject(): Promise<Record<string, unknown>>;
  ensurePreviewDomain(prNumber: number | string): Promise<PreviewDomain>;
  removePreview(prNumber: number | string): Promise<void>;
  listPreviews(): Promise<PreviewSummary[]>;
  smokePreview(prNumber: number | string, sha: string): Promise<string>;
};

export function createCloudflareClient(options: {
  token: string;
  accountId: string;
  zoneId?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}): CloudflarePreviewClient;
