import { usePersonalGradesPreference } from '../lib/personal-grades-preference';
import { usePersonalGradesDefault } from '../providers/feature-flags-provider';

/**
 * Whether the grade a climber gave a climb outranks the crowd's right now
 * (#4796, #4828).
 *
 * Resolution, in order:
 *  1. The climber's own setting, whichever way they set it. An explicit opt-out
 *     is as binding as an explicit opt-in — a flag change must never silently
 *     reverse a decision someone made on purpose.
 *  2. Otherwise the `personal-grades` PostHog flag, which supplies the DEFAULT
 *     for everyone who has never touched the setting.
 *
 * The flag is read strictly (`=== true`), so an unresolved or unreachable
 * PostHog leaves the default OFF. That is what makes this fail closed: the
 * behaviour ships to people by a deliberate rollout, not by a service outage
 * being indistinguishable from a rollout.
 *
 * Read this at exactly one seam per half of the feature — `useMyGrade` for
 * everything that displays a grade, and the climbs screen for the search input.
 * The two must agree: a state where rows show your grade while the filter keys
 * the crowd's would put a V10 row behind a V0 filter, which is the defect
 * #4828 is about.
 */
export function usePersonalGradesActive(): boolean {
  const { choice } = usePersonalGradesPreference();
  const defaultEnabled = usePersonalGradesDefault();
  return choice ?? defaultEnabled;
}
