export const qaTypeDefs = /* GraphQL */ `
  """
  A tester's verdict on a pull-request preview (crowdsourced QA; see
  docs/crowdsourced-qa.md).
  """
  enum QaVerdictKind {
    approved
    declined
  }

  """
  One verdict a tester filed from the mobile app. Mirrored to GitHub as a PR
  comment plus a \`qa-approved\` / \`qa-declined\` label; \`githubCommentUrl\` is
  null until that side effect lands (or when it failed — the row is the record).
  """
  type QaVerdict {
    id: ID!
    prNumber: Int!
    """
    The OTA preview branch the tester was running, e.g. \`pr-4792\`.
    """
    branch: String!
    verdict: QaVerdictKind!
    comment: String
    """
    The PR's head commit when the verdict was filed.
    """
    headSha: String
    createdAt: String!
    githubCommentUrl: String
  }

  """
  One GitHub label on the pull request, mirrored so the app can show the same
  chips the PR page does. \`color\` is GitHub's six-digit hex, no leading \`#\`.
  """
  type QaLabel {
    name: String!
    color: String!
  }

  """
  What the PR's OTA preview bundle is doing, read from the \`pr-preview\`
  deployment that \`mobile-ota-preview.yml\` maintains.

  \`unavailable\` is every deliberate no-publish — a native change, a branch
  behind a native change on main, or a torn-down preview. \`unknown\` means we
  could not read the deployment at all.
  """
  enum QaOtaBuildState {
    building
    ready
    failed
    unavailable
    unknown
  }

  """
  An open pull request with a published OTA preview branch, as a tester sees it:
  what to test (the PR body's \`## Test plan\`), how risky it is (\`Risk: N/5\`),
  and whether this tester already filed a verdict.
  """
  type QaPreview {
    prNumber: Int!
    """
    \`pr-<number>\` — the xprem branch a compatible build can surf to.
    """
    branch: String!
    title: String!
    url: String!
    """
    GitHub login of the PR author.
    """
    author: String!
    isDraft: Boolean!
    headSha: String!
    """
    Committer date of \`headSha\` (ISO 8601). Null when the lookup failed.
    """
    headCommittedAt: String
    """
    ISO 8601 — when the PR was last updated on GitHub.
    """
    updatedAt: String!
    """
    1–5 from the PR body's \`Risk: N/5\` line; null when the PR predates the rule.
    """
    risk: Int
    riskReason: String
    """
    The \`## Test plan\` section as written (comments stripped); null when absent.
    """
    testPlan: String
    """
    The plan's numbered steps, one string each. Empty when the plan has none.
    """
    testPlanSteps: [String!]!
    """
    The calling tester's most recent verdict on this PR, if any.
    """
    myLatestVerdict: QaVerdict
    """
    Every label on the PR, in GitHub's order.
    """
    labels: [QaLabel!]!
    """
    Whether the preview bundle is published, publishing, or never coming.
    """
    otaBuild: QaOtaBuildState!
  }

  """
  Input for submitQaVerdict. Everything but the verdict is device context the
  app fills in so the GitHub comment can say what was tested where.
  """
  input SubmitQaVerdictInput {
    prNumber: Int!
    """
    Must equal \`pr-<prNumber>\` — the branch the tester actually ran.
    """
    branch: String!
    verdict: QaVerdictKind!
    """
    Free text, up to 2000 characters. Required (10+ characters) for \`declined\`.
    """
    comment: String
    """
    'ios' | 'android' | 'web'.
    """
    platform: String!
    """
    Marketing name of the handset, e.g. \`iPhone 17 Pro\`. Null on web.
    """
    deviceModel: String
    """
    OS release the tester ran, e.g. \`26.1\`.
    """
    osVersion: String
    appVersion: String
    """
    expo-updates \`updateId\` of the running bundle.
    """
    updateId: String
    runtimeVersion: String
    """
    expo-updates \`createdAt\` of the running bundle (ISO 8601). Compared with
    the PR head's commit date to flag a verdict filed on an older revision.
    """
    bundleCreatedAt: String
  }
`;
