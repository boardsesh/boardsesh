## Climb Detail / View

### Climb Detail Shell

**Web component:** `packages/web/app/components/climb-detail/climb-detail-shell.client.tsx`

**Web route:** `/b/{board_slug}/{angle}/view/{uuid}` (info mode) or within play drawer (play mode)

**Mobile status:** Stack screen pushed from climb list

**Layout:**

- **Play mode:** Single-column scroll layout. Above-fold (board + header) renders first. Below-fold (collapsible sections) deferred via `startTransition` to avoid blocking initial paint.
- **Info mode:** Two-column on desktop (breakpoint 1024px), single-column on mobile. Left: board + sections. Right: sidebar with sections (desktop only).

### Climb Detail Header

**Web component:** `packages/web/app/components/climb-detail/climb-detail-header.tsx`

**Layout:** Flex row, padding `12px 16px`, gap 12px, min-height 56px.

- **Left (flex-shrink 0, min-width 48px):** Grade display
  - Formatted grade (bold, `fontSize: 2xl`, colored by grade)
  - Or raw difficulty string if grade format not loaded
  - Or "Project" italic text if no difficulty
  - Skeleton (48px wide) while grade format is loading

- **Center (flex: 1, centered):**
  - Climb name (`fontSize: lg`, bold) with marquee text animation for overflow
  - Climb icons: benchmark diamond, no-match indicator
  - Details row: quality rating + star, ascensionist count ("X sends"), setter username. Joined by " . " separator.

- **Right (flex-shrink 0, min-width 48px):** Empty spacer for visual centering of name

**Data sources:**

- `climb` object with `difficulty`, `name`, `quality_average`, `ascensionist_count`, `setter_username`, `benchmark_difficulty`, `is_no_match`
- Optional `communityGrade` override from `climb_community_status` table
- `useGradeFormat()` for board-specific grade formatting and coloring

### Collapsible Detail Sections

**Web component:** `packages/web/app/components/climb-detail/build-climb-detail-sections.tsx`

Sections are rendered via `CollapsibleSection` component. Each section has a label, title, summary, expand/collapse state, and lazy-loaded content.

**Sections (in order):**

1. **Beta** (`key: 'beta'`)
   - Label: Video camera icon + "Beta"
   - Default expanded, `keepExpanded: true`
   - Content: `BoardseshBetaList` showing video links (TikTok/Instagram embeds), plus `AddBetaVideoDialog` for adding new beta
   - Action button: `BoardseshBetaAddButton` opens the add beta video modal
   - Summary: "{N} videos" or "No videos yet"
   - Data: `GET_BETA_LINKS` GraphQL query, `betaLinks` response mapped via `mapBetaLinksResponse()`

2. **Your Logbook** (`key: 'logbook'`)
   - Content: `LogbookSection` -- user's ascent history for this climb
   - Summary: "{N} attempts, {M} sends" or "No ascents"

3. **Crew Logbook** (`key: 'crew-logbook'`)
   - Content: `CrewLogbookView` -- followed users' ascent data
   - Summary: "See your crew's sends"

4. **Community** (`key: 'community'`)
   - Content: `ClimbSocialSection` -- votes, comments, grade proposals
   - Summary: "Votes, Comments, Proposals"
   - Default active if `?proposalUuid=` query param is present

5. **Analytics** (`key: 'analytics'`)
   - Content: `ClimbAnalytics` -- ascent/quality trend charts
   - Summary: "Ascents, Quality, Trends"

6. **Similar Climbs** (`key: 'similar-climbs'`)
   - Content: `SimilarClimbsList` -- climbs with similar hold patterns
   - `keepExpanded: true`
   - Threshold: 0.5 similarity, limit 10 results
   - Summary: i18n `detail.sections.similarClimbsSummary`
   - Empty message: `similarClimbs.emptyOnLayout`

All sections are `lazy: true` (content mounts only when expanded).

**Data sources:**

- `betaLinks` query: `GET_BETA_LINKS` (GraphQL HTTP, staleTime 5min)
- `useLogbookSummary(climbUuid)` for logbook section summary
- `searchParams.get('proposalUuid')` for highlighting a specific proposal
- `climbUuid`, `boardType`, `angle`, `layoutId` passed to each section

**Mobile adaptation notes:**

- Collapsible sections: `react-native-reanimated` `useAnimatedStyle` for height animation
- Beta videos: `react-native-webview` for TikTok/Instagram embeds, or native video player
- Charts: `react-native-chart-kit` or `victory-native`

---
