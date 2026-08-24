## 7. Playlists / Library

### 7.1 Library Main Page (`/playlists`)

The library is the user's playlist hub, combining owned, pinned, smart, and community playlists into a scrollable discovery surface.

**Layout (top to bottom):**

1. **Board Filter Strip** -- Horizontal chip row of the user's saved boards (`useMyBoards`). Tapping a chip filters every section below to playlists matching that `boardType` + `layoutId`. An "All" chip clears the filter. The strip auto-selects the board matching the current queue/session context when no explicit selection exists.

2. **Sign-In Banner** (unauthenticated only) -- A horizontal bar with a login icon, title, one-line description, and a "Sign In" contained button. Tapping opens the auth modal with a playlist-specific title/description. A placeholder `div` of equal height renders during the `loading` auth state to prevent CLS.

3. **Your Picks (Smart Playlists)** -- Section title "Your Picks". A CSS grid of `PlaylistCard` components (variant `"grid"`). Each card maps to a `SmartPlaylistPresentation` preset:

   | Preset        | Icon         | Color      | Data Source                        |
   | ------------- | ------------ | ---------- | ---------------------------------- |
   | Five Stars    | star emoji   | amber      | User's 5-star rated climbs         |
   | Most Repeated | repeat emoji | purple     | Most attempted climbs              |
   | Projects      | target emoji | accentRose | Climbs worked most without sending |

   Cards with `count === 0` are omitted. Tapping navigates to `/discover/<slug>/<userId>`. The board-preview backdrop uses the currently selected board (or the user's primary board as fallback).

4. **Pinned** -- Section title "Pinned". A `PlaylistCardGrid` showing the user's server-side pinned playlists. Each card displays a pin toggle button (filled `PushPin` when pinned, outlined when not). Falls back to per-device IndexedDB "recently opened" playlists when the user has nothing pinned. Pin/unpin calls `PIN_PLAYLIST` / `UNPIN_PLAYLIST` mutations.

5. **Jump Back In** -- Section title "Jump Back In". A `PlaylistScrollSection` with horizontal scroll and IntersectionObserver-driven pagination. Shows all owned playlists ordered by `lastAccessedAt`. Each card is variant `"scroll"` (taller, wider).

6. **Discover** -- Section title "Discover". Same horizontal scroll pattern. Merges `popular` and `recent` community playlists, de-duped and excluding the current user's own playlists. Two parallel cursors (popular + recent) live inside `useDiscoverPlaylists`; exhausted streams stop pulling.

7. **Create Playlist FAB** (authenticated only) -- A fixed-position `Fab` with `+` icon anchored to the right edge of the page container, above the bottom bar. Tapping triggers a board picker drawer if no board is selected, or directly opens the create playlist drawer.

8. **Empty State** (authenticated, no playlists or pins) -- Centered icon (`LabelOutlined`), title, description text (max 300px wide).

9. **Error State** (authenticated, fetch error) -- Centered sad-face icon, title, description, "Try Again" outlined button.

**Playlist Card Anatomy:**

- **Grid variant**: Compact square thumbnail (`PlaylistPreviewSquare` showing a board image tinted with the playlist's color + optional emoji icon), name (single line, truncated), climb count text, optional pin button overlay.
- **Scroll variant**: Larger square thumbnail, name below, climb count below name.
- Both variants are wrapped in `LocaleLink` for navigation.

**React Native adaptation:**

- Replace horizontal `PlaylistScrollSection` with a `FlatList` with `horizontal` prop and snap-to-item behavior.
- Replace CSS grid with a 2-column `FlatList` for the pinned/smart sections.
- Replace FAB with a floating `Pressable` positioned via absolute layout above the tab bar.
- Board filter strip becomes a horizontal `ScrollView` with chip `Pressable` components.

---

### 7.2 Playlist Detail (`/playlists/[playlist_uuid]`)

**Header (Hero Section):**

- Back button (falls back to `/playlists`).
- `PlaylistPreviewSquare` (96x96) showing board image with playlist color tint and optional emoji icon.
- Playlist name (`h5`), climb count, follower count (with people icon), visibility badge (Public with globe icon / Private with lock icon).
- Optional description text.
- Follow button for non-owners on public playlists (uses generic `FollowButton` component with `FOLLOW_PLAYLIST` / `UNFOLLOW_PLAYLIST` mutations). Shows follower count change optimistically.
- **Top-right action cluster** (absolutely positioned):
  - Pin toggle button (any signed-in viewer): filled `PushPin` when pinned, outlined when not.
  - Share button (public playlists only): `IosShare` icon. Uses `shareWithFallback` (native Web Share API with clipboard fallback).
  - Three-dot menu (`MoreVertOutlined`):
    - **Generate** (owner only): Opens `PlaylistGeneratorDrawer` (AI-powered climb generation).
    - **Edit** (owner only): Opens `PlaylistEditDrawer`.
    - **Delete** (owner only): Red text, calls `DELETE_PLAYLIST` mutation, navigates back to library on success.

**Climb List:**

- Uses `MultiboardClimbList` component with board filter chips.
- Infinite scroll via `useInfiniteQuery` with 20 climbs per page.
- Each climb row: thumbnail, climb name, grade, board info. Tapping a climb activates it in the queue context if available.
- Empty state: "No climbs in this playlist yet" (via `EmptyState` component).

**Getting a playlist into the queue (mobile) — two paths, one destructive:**

| control                                                               | what it does                                                                                                   | confirmation                                                                                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Add to queue** row (list header, above Discussion)                  | Appends every board-scoped climb behind the live queue. Nothing is cleared, and the current climb never moves. | None on the way in — a count on the way out.                                                                                                                                         |
| **Start playlist** (Material app-bar play action, or a climb-row tap) | Replaces the whole queue with the playlist order, tapped climb active, so previous/next walk the circuit.      | A three-way prompt whenever anything is queued after the current climb: **Start playlist** (destructive) · **Add to queue** · **Keep queue**. Silent when there is nothing to clear. |

The additive row (`PlaylistAddToQueueRow`) renders on both platform branches, for
owners and non-owners, and on smart playlists (Liked Climbs / Five Stars /
Projects) — which have no overflow menu at all, so a menu item could never have
reached them. It is hidden when there is no active board, when the playlist is on
another board (the switch-board banner owns that prompt), on an empty playlist,
and in edit mode.

Append semantics live in `appendQueueItems` on the mobile queue provider. It
clamps the batch to `MAX_SYNCED_QUEUE_ITEMS` (the party backend's `setQueue`
throws rather than truncating a longer payload) and returns what landed. It never
broadcasts a whole-queue replace without a current-climb pointer, because the
resolver reads an absent pointer as "clear the session's current climb" — with
nothing current it fans the batch out as per-item adds instead.

**Discussion Section:**

- Rendered only for public playlists.
- Uses `CommentSection` component with entity type `"playlist_climb"` and entity ID `"<playlistUuid>:_all"`.

**React Native adaptation:**

- Hero section as a sticky header or scroll-away header using `Animated.ScrollView`.
- Action menu via an ActionSheet (iOS native bottom sheet).
- Climb list as a `FlashList` with `onEndReached` for pagination.

---

### 7.3 Create / Edit Playlist Drawers

**Create Playlist Drawer** (`CreatePlaylistDrawer`):

- Bottom sheet drawer (`SwipeableDrawer`).
- Title: "Create Playlist".
- Fields:
  - **Name** (required): `TextField`, max 100 chars, autofocus. Validation: required, max length.
  - **Description** (optional): `TextField`, multiline, 2 rows, max 500 chars.
  - **Color** (optional): Color picker (`<input type="color">`), defaults to `#000000`.
- Header-right "Create" contained button (disabled while submitting).
- Calls `CREATE_PLAYLIST` mutation with `boardType`, `layoutId`, name, description, color.
- On success: toast, analytics event, navigates to the new playlist detail page.

**Edit Playlist Drawer** (`PlaylistEditDrawer`):

- Bottom sheet drawer.
- Title: "Edit Playlist".
- Fields:
  - **Name**, **Description**, **Color** -- same as create.
  - **Icon** (optional): Emoji picker button (48x48, shows current emoji or "+"). Popover with `@emoji-mart/react` picker. Remove icon button when set.
  - **Visibility** toggle: `Switch` between Private (lock icon) and Public (globe icon) with descriptive hint text below.
- Header-right Cancel (outlined) + Save (contained) buttons.
- Calls `UPDATE_PLAYLIST` mutation.

**React Native adaptation:**

- Use `Sheet` component (bottom sheet) instead of `SwipeableDrawer`.
- Replace emoji picker with a modal or the `expo-emoji-picker` package.
- Color picker as a row of preset color swatches rather than a native color input (which has poor RN support).

---

### 7.4 Smart Playlists

Smart playlists are auto-generated from the user's logbook and are not editable. They live at `/discover/<slug>/<userId>`.

| Smart Playlist | Slug            | Logic                                                |
| -------------- | --------------- | ---------------------------------------------------- |
| Five Stars     | `five-stars`    | All climbs the user rated 5 stars                    |
| Most Repeated  | `most-repeated` | Climbs with the highest attempt count                |
| Projects       | `projects`      | Climbs with the most attempts but no successful send |

- Each has a dedicated color, emoji icon, and i18n title/description.
- Share button with preset share text.
- Empty state when no qualifying climbs exist.
- Counts fetched via `GET_MY_SMART_PLAYLIST_COUNTS` query (5-minute stale time).

**Data operations:**

- `allUserPlaylists` / `useUserPlaylists` -- Paginated owned playlists with board filter.
- `myPinnedPlaylists` / `usePinnedPlaylists` -- Server-side pins with IndexedDB recents fallback.
- `playlist` / `GET_PLAYLIST` -- Single playlist fetch.
- `playlistClimbs` / `GET_PLAYLIST_CLIMBS` -- Paginated climbs within a playlist (supports board-specific filtering).
- `discoverPlaylists` / `useDiscoverPlaylists` -- Popular + recent community playlists.
- `searchPlaylists` -- Text search across playlists.
- `mySmartPlaylistCounts` / `GET_MY_SMART_PLAYLIST_COUNTS` -- Counts for each smart playlist type.
- `smartPlaylist` -- Fetches climbs for a specific smart playlist type.
- `createPlaylist` / `CREATE_PLAYLIST` -- Creates a new playlist.
- `updatePlaylist` / `UPDATE_PLAYLIST` -- Updates name, description, color, icon, visibility.
- `deletePlaylist` / `DELETE_PLAYLIST` -- Deletes a playlist.
- `addClimbToPlaylist` / `ADD_CLIMB_TO_PLAYLIST` -- Adds a climb to a playlist.
- `removeClimbFromPlaylist` -- Removes a climb from a playlist.
- `pinPlaylist` / `PIN_PLAYLIST` -- Pins a playlist for the current user.
- `unpinPlaylist` / `UNPIN_PLAYLIST` -- Unpins a playlist.
- `followPlaylist` / `FOLLOW_PLAYLIST` -- Follows a playlist (non-owner).
- `unfollowPlaylist` / `UNFOLLOW_PLAYLIST` -- Unfollows a playlist.

---
