// Hand-written mirror of the SDL in `schema/qa.ts` — the shared-schema public
// API re-exports these (not the codegen output), so web/mobile import them from
// `@boardsesh/shared-schema`.

/**
 * How many PR numbers one `qaPreviews` call may carry.
 *
 * Matched to the backend's own ceiling on the open-PR list it answers from (two
 * pages of 100), so a number beyond this could not have been in that list
 * anyway. Shared with the client because the request is REJECTED past it, not
 * truncated: a client that asks for one too many gets no metadata for any PR,
 * and the whole pick list degrades to bare `pr-N` rows.
 */
export const QA_PREVIEWS_MAX_PR_NUMBERS = 200;

export type QaVerdictKind = 'approved' | 'declined';

export type QaPlatform = 'ios' | 'android' | 'web';

export type QaVerdict = {
  id: string;
  prNumber: number;
  /** The OTA preview branch the tester was running, e.g. `pr-4792`. */
  branch: string;
  verdict: QaVerdictKind;
  comment: string | null;
  /** The PR's head commit when the verdict was filed. */
  headSha: string | null;
  createdAt: string;
  /** Null until the GitHub comment side effect lands (or when it failed). */
  githubCommentUrl: string | null;
};

/** One GitHub label on the PR. `color` is six hex digits, no leading `#`. */
export type QaLabel = {
  name: string;
  color: string;
};

/**
 * What the PR's OTA preview bundle is doing, from the `pr-preview` deployment.
 * `unavailable` is every deliberate no-publish (native change, behind main,
 * torn down); `unknown` means the deployment could not be read.
 */
export type QaOtaBuildState = 'building' | 'ready' | 'failed' | 'unavailable' | 'unknown';

export type QaPreview = {
  prNumber: number;
  /** `pr-<number>` — the xprem branch a compatible build can surf to. */
  branch: string;
  title: string;
  url: string;
  /** GitHub login of the PR author. */
  author: string;
  isDraft: boolean;
  headSha: string;
  /** Committer date of `headSha` (ISO 8601); null when the lookup failed. */
  headCommittedAt: string | null;
  updatedAt: string;
  /** 1–5 from the PR body's `Risk: N/5` line; null when absent. */
  risk: number | null;
  riskReason: string | null;
  /** The `## Test plan` section as written (comments stripped); null when absent. */
  testPlan: string | null;
  /** The plan's numbered steps; empty when the plan has none. */
  testPlanSteps: string[];
  /** The calling tester's most recent verdict on this PR, if any. */
  myLatestVerdict: QaVerdict | null;
  /** Every label on the PR, in GitHub's order. */
  labels: QaLabel[];
  /** Whether the preview bundle is published, publishing, or never coming. */
  otaBuild: QaOtaBuildState;
};

export type SubmitQaVerdictInput = {
  prNumber: number;
  /** Must equal `pr-<prNumber>`. */
  branch: string;
  verdict: QaVerdictKind;
  /** Up to 2000 characters. Required (10+ characters) for `declined`. */
  comment?: string | null;
  platform: QaPlatform;
  /** Marketing name of the handset, e.g. `iPhone 17 Pro`. Null on web. */
  deviceModel?: string | null;
  /** OS release the tester ran, e.g. `26.1`. */
  osVersion?: string | null;
  appVersion?: string | null;
  /** expo-updates `updateId` of the running bundle. */
  updateId?: string | null;
  runtimeVersion?: string | null;
  /** expo-updates `createdAt` of the running bundle (ISO 8601). */
  bundleCreatedAt?: string | null;
};
