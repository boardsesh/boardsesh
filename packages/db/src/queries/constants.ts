// Plain constants from the query layer, with no schema or client imports.
// Request validation imports this entry instead of the `queries` barrel, which
// loads the whole db schema (and through it next-auth and the Next.js global
// types) into every program that validates a request.
export { CONFIDENCE } from './grade-model/constants';
export { MAX_SEARCH_PAGE } from './climbs/search-limits';
