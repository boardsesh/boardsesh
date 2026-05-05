import type { SearchRequestPagination } from '@/app/lib/types';
import { TENSION_KILTER_GRADES } from '@/app/lib/board-data';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';

export const DEFAULT_CLIMB_SEARCH_SUMMARY = 'What do you want to climb?';

function getGradeName(gradeId: number): string {
  const grade = TENSION_KILTER_GRADES.find((g) => g.difficulty_id === gradeId);
  return grade?.v_grade ?? `Grade ${gradeId}`;
}

export function hasActiveFilters(params: SearchRequestPagination): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (key === 'holdsFilter') {
      return Object.keys(value || {}).length > 0;
    }
    if (key === 'zoneBox') {
      return value !== null;
    }
    return value !== DEFAULT_SEARCH_PARAMS[key as keyof typeof DEFAULT_SEARCH_PARAMS];
  });
}

export function hasActiveNonNameFilters(params: SearchRequestPagination): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (key === 'name') return false;
    if (key === 'holdsFilter') {
      return Object.keys(value || {}).length > 0;
    }
    if (key === 'zoneBox') {
      return value !== null;
    }
    return value !== DEFAULT_SEARCH_PARAMS[key as keyof typeof DEFAULT_SEARCH_PARAMS];
  });
}

export function getClimbPanelSummary(params: SearchRequestPagination): string[] {
  const parts: string[] = [];

  if (params.minGrade && params.maxGrade) {
    parts.push(`${getGradeName(params.minGrade)}-${getGradeName(params.maxGrade)}`);
  } else if (params.minGrade) {
    parts.push(`${getGradeName(params.minGrade)}+`);
  } else if (params.maxGrade) {
    parts.push(`Up to ${getGradeName(params.maxGrade)}`);
  }

  if (params.name) {
    parts.push(`"${params.name}"`);
  }

  if (params.settername.length > 0) {
    parts.push(params.settername.length === 1 ? params.settername[0] : `${params.settername.length} setters`);
  }

  return parts;
}

export function getQualityPanelSummary(params: SearchRequestPagination): string[] {
  const parts: string[] = [];

  // minAscents >= 2 is reflected by the Ascent Status "Established" chip; avoid dup.
  if (params.minAscents && params.minAscents < 2) {
    parts.push(`${params.minAscents}+ ascents`);
  }
  if (params.minRating) {
    parts.push(`${params.minRating}+ rating`);
  }
  if (params.onlyClassics) {
    parts.push('Classics');
  }

  if (params.gradeAccuracy && params.gradeAccuracy !== DEFAULT_SEARCH_PARAMS.gradeAccuracy) {
    parts.push('Grade accuracy');
  }
  if (params.onlyTallClimbs) {
    parts.push('Tall');
  }

  return parts;
}

export function getStatusPanelSummary(params: SearchRequestPagination): string[] {
  if (params.onlyDrafts) return ['Drafts'];
  if (params.projectsOnly) return ['Projects'];
  if (params.minAscents >= 2) return ['Established'];
  return [];
}

export function getUserPanelSummary(params: SearchRequestPagination): string[] {
  // Merge "Hide" filters into single entry
  const hideFilters: string[] = [];
  if (params.hideAttempted) hideFilters.push('attempted');
  if (params.hideCompleted) hideFilters.push('completed');

  // Merge "Only" filters into single entry
  const onlyFilters: string[] = [];
  if (params.showOnlyAttempted) onlyFilters.push('attempted');
  if (params.showOnlyCompleted) onlyFilters.push('completed');

  const parts: string[] = [];
  if (hideFilters.length > 0) {
    parts.push(`Hide ${hideFilters.join(', ')}`);
  }
  if (onlyFilters.length > 0) {
    parts.push(`Only ${onlyFilters.join(', ')}`);
  }
  return parts;
}

export function getHoldsPanelSummary(params: SearchRequestPagination): string[] {
  const holdsCount = Object.keys(params.holdsFilter || {}).length;
  if (holdsCount === 0) return [];
  return [`${holdsCount} hold${holdsCount !== 1 ? 's' : ''}`];
}

export function getZonePanelSummary(params: SearchRequestPagination, label: string): string[] {
  return params.zoneBox ? [label] : [];
}

export function getBoardFiltersPanelSummary(params: SearchRequestPagination, zoneLabel: string): string[] {
  return [...getHoldsPanelSummary(params), ...getZonePanelSummary(params, zoneLabel)];
}

/**
 * Pre-translated labels used by the search-pill summary helpers.
 * Pass these in from the React layer where i18n is available.
 */
export type SearchPillLabels = {
  zone: string;
};

/**
 * Get compact search pill summary (max 2 items + "+N more")
 * Used for display in the search bar and recent search pills
 */
export function getSearchPillSummary(params: SearchRequestPagination, labels: SearchPillLabels): string {
  const allParts = [
    ...getClimbPanelSummary(params),
    ...getQualityPanelSummary(params),
    ...getStatusPanelSummary(params),
    ...getUserPanelSummary(params),
    ...getHoldsPanelSummary(params),
    ...getZonePanelSummary(params, labels.zone),
  ];

  if (allParts.length === 0) return DEFAULT_CLIMB_SEARCH_SUMMARY;

  // Show max 2 items, append "+N more" if more
  if (allParts.length <= 2) {
    return allParts.join(' \u00B7 ');
  }
  const remaining = allParts.length - 2;
  return allParts.slice(0, 2).join(' \u00B7 ') + ` \u00B7 +${remaining} more`;
}

/**
 * Get full search pill summary (all items, no truncation)
 * Used for tooltips to show the complete filter list
 */
export function getSearchPillFullSummary(params: SearchRequestPagination, labels: SearchPillLabels): string {
  const allParts = [
    ...getClimbPanelSummary(params),
    ...getQualityPanelSummary(params),
    ...getStatusPanelSummary(params),
    ...getUserPanelSummary(params),
    ...getHoldsPanelSummary(params),
    ...getZonePanelSummary(params, labels.zone),
  ];

  if (allParts.length === 0) return DEFAULT_CLIMB_SEARCH_SUMMARY;
  return allParts.join(' \u00B7 ');
}
