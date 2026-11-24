import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';

/**
 * Reuse the authority's DNS-pinned HTTPS transport for gym images. Importing
 * this wrapper while OAuth is off loads no Better Auth runtime; only an
 * explicitly requested fetch loads the transport, never an auth factory.
 */
export const fetchPublicHttpsResource: ClientMetadataResourceFetch = async (input, init) => {
  const { fetchClientMetadataResource } = await import('@better-auth/cimd/node');
  return fetchClientMetadataResource(input, init);
};
