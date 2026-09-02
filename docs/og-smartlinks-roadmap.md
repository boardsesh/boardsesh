# OG Smart Links & Share Buttons Roadmap

Status of Open Graph metadata, dynamic OG images, and share buttons across all routes.

## Current Status

### Routes with Dynamic OG Images + Share Buttons (Complete)

| Route                                       | OG Image API                        | Share Button               | Notes                                                  |
| ------------------------------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------ |
| `[board_name]/.../view/[climb_uuid]`        | `https://ws.boardsesh.com/og/climb` | Yes (climb actions drawer) | Immutable Rust-rendered board preview in Aura, no text overlay |
| `[board_name]/.../play/[climb_uuid]`        | `https://ws.boardsesh.com/og/climb` | Yes (climb actions drawer) | Same as view, canonical to view URL                    |
| `/b/[board_slug]/[angle]/view/[climb_uuid]` | `https://ws.boardsesh.com/og/climb` | Yes (inherited)            | Slug route, same immutable Aura board preview          |
| `/b/[board_slug]/[angle]/play/[climb_uuid]` | `https://ws.boardsesh.com/og/climb` | Yes (inherited)            | Slug route, same immutable Aura board preview          |
| `/crusher/[user_id]`                        | `/api/og/profile`                   | Yes (header)               | Avatar + grade distribution chart                      |
| `/setter/[setter_username]`                 | `/api/og/setter`                    | Yes (header)               | Avatar + ascents-per-grade chart for created climbs    |
| `/session/[sessionId]`                      | `/api/og/session`                   | Yes (header)               | Session name + participants + grade chart              |
| `/join/[sessionId]`                         | `/api/og/session?variant=join`      | N/A (redirect page)        | Same as session but with "Get on the wall" CTA         |
| `/playlists/[playlist_uuid]`                | `/api/og/playlist`                  | Yes (hero)                 | Playlist color/icon + name + climb count               |

### Routes with Static Metadata (Default OG Image)

| Route                                      | Title Pattern               | Notes                     |
| ------------------------------------------ | --------------------------- | ------------------------- | ---------------------------- |
| `/`                                        | `Boardsesh - ...`           | Homepage with brand image |
| `/about`                                   | `About                      | Boardsesh`                |                              |
| `/help`                                    | `Help                       | Boardsesh`                |                              |
| `/docs`                                    | `Docs                       | Boardsesh`                |                              |
| `/legal`                                   | `Legal                      | Boardsesh`                |                              |
| `/privacy`                                 | `Privacy                    | Boardsesh`                |                              |
| `/aurora-migration`                        | `Migration                  | Boardsesh`                |                              |
| `/playlists`                               | `Playlists                  | Boardsesh`                | List page                    |
| `/logbook`                                 | `Logbook                    | Boardsesh`                |                              |
| `/b/[board_slug]/[angle]/list`             | `{Board} Climbs at {angle}° | Boardsesh`                | Dynamic title, default image |
| `/b/[board_slug]/[angle]/create`           | `Create a Climb             | Boardsesh`                |                              |
| `/b/[board_slug]/[angle]/import`           | `Import Climbs              | Boardsesh`                |                              |
| `/b/[board_slug]/[angle]/playlists`        | `Playlists                  | Boardsesh`                |                              |
| `/b/[board_slug]/[angle]/playlists/[uuid]` | `{Playlist Name}            | Boardsesh`                | Dynamic title                |

### Routes with noindex

| Route                             | Reason             |
| --------------------------------- | ------------------ |
| `/auth/login`                     | Auth flow          |
| `/auth/error`                     | Auth flow          |
| `/auth/native-start`              | Auth flow          |
| `/auth/verify-request`            | Auth flow          |
| `/feed`                           | Authenticated feed |
| `/settings`                       | User settings      |
| `/b/[board_slug]/[angle]/liked`   | User-specific      |
| `/b/[board_slug]/[angle]/logbook` | User-specific      |
| `/join/[sessionId]`               | Redirect/utility   |

## OG Image API Routes

| Endpoint           | Params                                                     | Renders                                                               |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `/api/og/climb`    | board_name, layout_id, size_id, set_ids, angle, climb_uuid | Legacy compatibility redirect to immutable Rust-rendered board OG URL |
| `/api/og/profile`  | user_id                                                    | Avatar + name + grade distribution bar chart                          |
| `/api/og/setter`   | username                                                   | Avatar + name + ascents-per-grade bar chart for created climbs        |
| `/api/og/session`  | sessionId, variant?                                        | Session name + participants + grade chart. variant=join adds CTA      |
| `/api/og/playlist` | uuid                                                       | Playlist color/icon + name + description + climb count                |

## Future Improvements

### Custom OG Images for Static Pages

These pages currently use the default brand OG image. Custom images could improve click-through:

- `/aurora-migration` - Could show a visual comparison or migration flow
- `/about` - Could show board photos or app screenshots

### Board List Page OG

The `/b/[board_slug]/[angle]/list` page could potentially have a custom OG image showing a sample of popular climbs on that board, but the value is low since these pages are primarily navigational.

### Sitemap Updates

When adding new public page types, update `packages/web/app/sitemap.ts` to include:

- Popular setter profiles
- Popular climb view URLs (slug-based)
- Public playlists

### Structured Data

Consider adding JSON-LD structured data to:

- Profile pages (`ProfilePage` type)
- Session pages (event-like structured data)
- Homepage (`Organization` + `WebSite` types)
