import type { StatusPillTone } from '../components/StatusPill';

/** New is neutral (violet is for tappables only); improved warns orange; fixed is green. */
export function changelogCategoryTone(category: 'new' | 'improved' | 'fixed'): StatusPillTone {
  if (category === 'new') return 'neutral';
  return category === 'improved' ? 'warning' : 'positive';
}
