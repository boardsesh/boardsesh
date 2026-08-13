import type { SearchRequestPagination } from '@/app/lib/types';
import { PAGE_LIMIT } from '@/app/lib/climb-list-constants';

// Default climb search parameters
export const defaultClimbSearchParameters: SearchRequestPagination = {
  minGrade: 10,
  maxGrade: 33,
  name: '',
  minAscents: 1,
  sortBy: 'ascents',
  sortOrder: 'desc',
  minRating: 1.0,
  onlyBenchmarks: false,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  onlyWithBetaVideos: false,
  boulders: true,
  routes: false,
  gradeAccuracy: 1,
  settername: [],
  setternameSuggestion: '',
  //@ts-expect-error TODO fix later
  holdsFilter: '',
  zoneBox: null,
  zoneMode: 'allHolds',
  mirroredHolds: '',
  pageSize: PAGE_LIMIT,
  page: 0,
};
