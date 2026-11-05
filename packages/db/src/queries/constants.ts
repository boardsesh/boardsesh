// Plain constants from the query layer, with no schema or client imports.
// Request validation imports this entry instead of the `queries` barrel, which
// loads the full schema and database-client dependencies into every program
// that validates a request.
export { CONFIDENCE } from './grade-model/constants';
export { MAX_SEARCH_PAGE } from './climbs/search-limits';
export {
  BATCH_SYSTEM_USERS,
  HOLD_CLASSIFIER_USER_EMAIL,
  HOLD_CLASSIFIER_USER_ID,
  HOLD_CLASSIFIER_USER_NAME,
  RECOMMENDATIONS_USER_EMAIL,
  RECOMMENDATIONS_USER_ID,
  RECOMMENDATIONS_USER_NAME,
  SYSTEM_BOARD_OWNER_ID,
  SYSTEM_BOARD_OWNER_EMAIL,
  SYSTEM_BOARD_OWNER_NAME,
} from './system-account-constants';
