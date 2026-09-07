// Types for the parts of scripts/railway-deployment-rollback.mjs that TypeScript
// callers use. The implementation stays plain `.mjs` on purpose: it runs under bare
// node inside a GitHub Actions composite step where tsx is not on PATH, and its
// tests run under `node --test`. Hand-written rather than generated, and
// deliberately narrow — it declares what is imported, not the whole module.
//
// scripts/check-service-deploy-inputs.mjs asserts things about the implementation
// file's contents; this declaration must never grow into a second source of truth
// for its behaviour.

/**
 * Roll a service back to a previous deployment, with the full fencing the
 * production deploy path relies on: scope validation against the project token,
 * `canRollback`, image identity, cross-query agreement, sole-newest, and a
 * post-mutation poll that confirms the restored deployment becomes the service
 * instance's latest and sole-active one.
 *
 * Requires a Railway PROJECT token — it derives its scope from
 * `projectToken { projectId environmentId }`.
 */
export function rollbackDeployment(options: {
  expectedCurrentDeploymentId: string;
  fetchImpl?: typeof fetch;
  maxConsecutiveReadErrors?: number;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  serviceId: string;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  targetDeploymentId: string;
  token: string;
}): Promise<{ deploymentId: string; image: string }>;
