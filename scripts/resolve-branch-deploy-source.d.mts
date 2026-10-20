export interface BranchDeployEventPayload {
  number?: unknown;
  inputs?: { pr_number?: unknown } | null;
  pull_request?: {
    head?: {
      sha?: unknown;
      repo?: { full_name?: unknown } | null;
    } | null;
  } | null;
}

export interface BranchDeploySourceResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface BranchDeploySourceOptions {
  eventName: string | undefined;
  eventPayload: BranchDeployEventPayload;
  repository: string | undefined;
  apiUrl?: string;
  token: string | undefined;
  fetchImpl?: (input: URL, init?: { headers: Record<string, string> }) => Promise<BranchDeploySourceResponse>;
}

export declare function resolveBranchDeploySource(
  options: BranchDeploySourceOptions,
): Promise<{ number: number; sourceSha: string }>;
