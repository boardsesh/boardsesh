import { assertLocalDockerIdentity, RehearsalSafetyError, type LocalDockerIdentity } from './target-guard';

export interface NamespaceResource {
  readonly id: string;
  readonly image: string;
  readonly name: string;
  readonly nonce: string;
  readonly running: boolean;
  readonly networkMode: string;
  readonly networkIds: readonly string[];
  readonly publishedBindings: number;
  readonly requestedBindings: number;
  readonly bindMounts: number;
  readonly privileged: boolean;
  readonly dns: readonly string[];
  readonly readOnly: boolean;
  readonly capDrop: readonly string[];
  readonly capAdd: readonly string[];
}
export interface NamespaceExpectation {
  readonly identity: LocalDockerIdentity;
  readonly nonce: string;
  readonly networkId: string;
  readonly postgres: { readonly id: string; readonly image: string };
  readonly redis: { readonly id: string; readonly image: string };
  readonly runtime: { readonly id: string; readonly image: string };
}
export interface NamespaceProof {
  readonly identity: LocalDockerIdentity;
  readonly internal: boolean;
  readonly networkId: string;
  readonly networkNonce: string;
  readonly networkMemberIds: readonly string[];
  readonly postgres: NamespaceResource;
  readonly redis: NamespaceResource;
  readonly runtime: NamespaceResource;
  readonly postgresNamespace: string;
  readonly runtimeNamespace: string;
}
export interface IsolatedNamespace {
  readonly runNonce: string;
  readonly networkNamespace: string;
}
const receipts = new WeakSet<object>();

/** No host endpoint is minted: only an owned, shared, isolated execution namespace. */
export function attestIsolatedNamespace(expected: NamespaceExpectation, proof: NamespaceProof): IsolatedNamespace {
  assertLocalDockerIdentity(expected.identity);
  assertLocalDockerIdentity(proof.identity);
  if (JSON.stringify(proof.identity) !== JSON.stringify(expected.identity))
    throw new RehearsalSafetyError('DOCKER_IDENTITY_CHANGED');
  if (
    !/^[a-f0-9]{32}$/.test(expected.nonce) ||
    !/^[a-f0-9]{64}$/.test(expected.networkId) ||
    !proof.internal ||
    proof.networkId !== expected.networkId ||
    proof.networkNonce !== expected.nonce ||
    proof.networkMemberIds.length !== 1 ||
    proof.networkMemberIds[0] !== expected.postgres.id
  )
    throw new RehearsalSafetyError('OWNED_INTERNAL_NAMESPACE_REQUIRED');
  for (const service of ['postgres', 'redis', 'runtime'] as const) {
    const resource = proof[service];
    const receipt = expected[service];
    if (
      !/^[a-f0-9]{64}$/.test(receipt.id) ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.image) ||
      resource.id !== receipt.id ||
      resource.image !== receipt.image ||
      resource.nonce !== expected.nonce ||
      resource.name !== `/boardsesh-auth-rehearsal-${service}-${expected.nonce}` ||
      !resource.running ||
      resource.bindMounts !== 0 ||
      resource.publishedBindings !== 0 ||
      resource.requestedBindings !== 0 ||
      resource.privileged
    )
      throw new RehearsalSafetyError('OWNED_NAMESPACE_RESOURCE_REQUIRED');
    if (resource.capAdd.length) throw new RehearsalSafetyError('OWNED_NAMESPACE_CAPABILITIES_REQUIRED');
    if (service === 'runtime' && (!resource.readOnly || resource.capDrop.length !== 1 || resource.capDrop[0] !== 'ALL'))
      throw new RehearsalSafetyError('OWNED_NAMESPACE_CAPABILITIES_REQUIRED');
    if (service === 'postgres') {
      if (resource.dns.length !== 1 || resource.dns[0] !== '127.0.0.1')
        throw new RehearsalSafetyError('OWNED_NAMESPACE_DNS_REQUIRED');
      if (
        resource.networkMode !== expected.networkId ||
        resource.networkIds.length !== 1 ||
        resource.networkIds[0] !== expected.networkId
      )
        throw new RehearsalSafetyError('OWNED_INTERNAL_NAMESPACE_REQUIRED');
    } else if (resource.networkMode !== `container:${expected.postgres.id}` || resource.networkIds.length !== 0)
      throw new RehearsalSafetyError('OWNED_SHARED_NAMESPACE_REQUIRED');
  }
  if (!/^net:\[[0-9]+\]$/.test(proof.postgresNamespace) || proof.runtimeNamespace !== proof.postgresNamespace)
    throw new RehearsalSafetyError('OWNED_SHARED_NAMESPACE_REQUIRED');
  const receipt = Object.freeze({ runNonce: expected.nonce, networkNamespace: proof.runtimeNamespace });
  receipts.add(receipt);
  return receipt;
}
export function requireNamespaceReceipt(receipt: IsolatedNamespace): void {
  if (!receipts.has(receipt)) throw new RehearsalSafetyError('OWNED_NAMESPACE_RECEIPT_REQUIRED');
}
