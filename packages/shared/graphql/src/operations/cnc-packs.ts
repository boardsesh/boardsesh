import { gql } from 'graphql-request';
import type { CncArtworkValidation, CncBoardConfigInput, CncCatalog, CncOrder } from '@boardsesh/shared-schema';

// ============================================
// CNC build pack fragments
// ============================================

/**
 * Every field the catalogue publishes.
 *
 * Selected wholesale rather than trimmed per screen: the catalogue is four
 * entries of static registry data, it is fetched once when the configurator
 * mounts, and a client that has the prices but not the option lists cannot
 * render a configurator anyway.
 */
const CNC_CATALOG_FIELDS = `
  version
  entries {
    boardName
    layoutId
    sizeId
    setIds
    label
    kickerOptional
    manufacturingOptions {
      key
      values
      defaultValue
      valueType
    }
    tiers {
      tier
      amountCents
      currency
    }
  }
`;

/**
 * Shared by GET_MY_CNC_ORDERS and GET_CNC_ORDER, both typed `CncOrder` — so
 * every field the type declares as REQUIRED has to be selected here, or
 * consumers read `undefined` while TypeScript promises a value.
 */
const CNC_ORDER_FIELDS = `
  id
  licenceId
  tier
  status
  boardName
  layoutId
  sizeId
  setIds
  options
  artwork
  licenseeName
  customerSiteName
  amountCents
  currency
  createdAt
  paidAt
  generatedAt
  zipSizeBytes
  downloadCount
  lastDownloadedAt
  errorMessage
`;

// ============================================
// CNC build pack queries
// ============================================

export const GET_CNC_CATALOG = gql`
  query GetCncCatalog {
    cncCatalog {
      ${CNC_CATALOG_FIELDS}
    }
  }
`;

/**
 * The panel layout for a configuration.
 *
 * `JSON` rather than a typed selection because the shape is the pack
 * generator's `LayoutResponse` — panels, seams, keep-outs, a BOM preview — and
 * it grows as the generator learns to build more. Mirroring it field-by-field
 * in the schema would make every generator change a coordinated four-package
 * deploy for a payload the placement editor reads as a whole anyway.
 */
export const GET_CNC_LAYOUT = gql`
  query GetCncLayout($config: CncBoardConfigInput!, $includeHoles: Boolean) {
    cncLayout(config: $config, includeHoles: $includeHoles)
  }
`;

export const GET_MY_CNC_ORDERS = gql`
  query GetMyCncOrders {
    myCncOrders {
      ${CNC_ORDER_FIELDS}
    }
  }
`;

export const GET_CNC_ORDER = gql`
  query GetCncOrder($licenceId: String!) {
    cncOrder(licenceId: $licenceId) {
      ${CNC_ORDER_FIELDS}
    }
  }
`;

// ============================================
// CNC build pack mutations
// ============================================

export const VALIDATE_CNC_ARTWORK = gql`
  mutation ValidateCncArtwork($config: CncBoardConfigInput!) {
    validateCncArtwork(config: $config) {
      ok
      collisions
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type GetCncCatalogQueryResponse = {
  cncCatalog: CncCatalog;
};

export type GetCncLayoutQueryVariables = {
  config: CncBoardConfigInput;
  includeHoles?: boolean | null;
};

/**
 * The generator's `LayoutResponse`, unopened. Callers narrow it themselves —
 * see the note on GET_CNC_LAYOUT for why it is not modelled here.
 */
export type GetCncLayoutQueryResponse = {
  cncLayout: unknown;
};

export type GetMyCncOrdersQueryResponse = {
  myCncOrders: CncOrder[];
};

export type GetCncOrderQueryVariables = {
  licenceId: string;
};

export type GetCncOrderQueryResponse = {
  cncOrder: CncOrder | null;
};

export type ValidateCncArtworkMutationVariables = {
  config: CncBoardConfigInput;
};

export type ValidateCncArtworkMutationResponse = {
  validateCncArtwork: CncArtworkValidation;
};
