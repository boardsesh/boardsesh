import type { Gym } from '@boardsesh/shared-schema';

/**
 * The fields the indexability rule reads. A structural subset rather than the
 * whole `Gym`, so the sitemap shard, a card model or a test can ask the same
 * question with the four columns it already has in hand.
 */
export type IndexableVenueCandidate = Pick<Gym, 'isPublic' | 'latitude' | 'longitude'> & {
  isListed?: boolean;
};

function isRealCoordinate(coordinate: number | null | undefined, maximum: number): coordinate is number {
  return typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= maximum;
}

/**
 * Whether a gym page is a public VENUE worth putting in a search index — not
 * merely a page a logged-out visitor may load.
 *
 * Two different questions, and conflating them is what this exists to stop.
 * `isGymViewable` answers "may this viewer see the page" and is correct as it
 * stands; every gym it admits keeps serving 200. This answers "should Google
 * list it", and the answer is no for a climber's personal home wall.
 *
 * **Why coordinates are the proxy for "commercial venue".** Measured read-only
 * against production on 2026-09-20: 4,468 live public gyms, of which 2,848 carry
 * coordinates — leaving exactly the 1,620 rows that are climbers' home walls,
 * every one of them with a slug and therefore a live, indexable URL. 1,053 of
 * those names begin with the owner's own `users.name` (joined
 * `gyms.owner_id -> users.id`), so the page title rendered from
 * `gymPage.metaTitle` publishes a person's real name as a "climbing gym".
 * Google already serves 21 of them; `zhouzhou-s-moonboard-2024-standard` sits at
 * position 3.5.
 *
 * The coordinate split is not a guess about data completeness. The Aurora gym
 * sync validates coordinates before writing, so a synced commercial gym always
 * has a pin, while a garage wall someone created by hand never does. The same
 * proxy also gates directory searches through `requireLocation` and the
 * backend's public gym sitemap query. Both coordinates must be finite and in
 * geographic range. Text search callers that do not request venue eligibility
 * keep their existing behaviour.
 *
 * So: do NOT "simplify" this back to `gym.isPublic`. Dropping the coordinate
 * clause republishes 1,620 personal home walls into the index, which is the
 * privacy exposure this closes.
 *
 * Known cost, accepted: a handful of real commercial gyms have never been
 * geocoded and go `noindex, follow` with the home walls. They come back the
 * moment someone drops a pin on the listing — a self-healing miss, traded
 * against a leak that does not heal on its own.
 *
 * (0, 0) is deliberately NOT special-cased. The measurement above counted
 * presence, and Null Island is a broken geocode on a real venue, not a home
 * wall — the two failure modes point opposite ways, and the predicate stays
 * identical to the number that justifies it.
 */
export function gymIsIndexableVenue(gym: IndexableVenueCandidate): boolean {
  return (
    gym.isPublic && gym.isListed !== false && isRealCoordinate(gym.latitude, 90) && isRealCoordinate(gym.longitude, 180)
  );
}
