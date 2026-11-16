export {
  WEB_ROLE,
  WEB_FENCE_LOCK_SQL,
  WEB_WRITABLE_AUTH_SCHEMA_TABLES,
  quoteIdentifier,
  protectedIdentityTable,
  fencePlan,
  readFenceCatalog,
  verifyFence,
} from '@boardsesh/db/auth-web-acl';
export type { FenceRelation, FenceCatalog } from '@boardsesh/db/auth-web-acl';
