# OG Smart Links & Share Buttons

The app shares public page URLs so chat apps can read their Open Graph metadata.
Cards are rendered on the public backend origin (normally `https://ws.boardsesh.com`).
[OG rendering and privacy rules](./og-climb.md) describe the full card contract.

## Supported links and app entry points

Sharing covers iOS, Android, and Expo web. Buttons sit on detail surfaces; browsing
rows and feed cards do not each need a Share button.

| Entity | Shared page URL | Backend card | App Share entry point |
| --- | --- | --- | --- |
| Catalogue climb | `/{board}/{layout}/{size}/{sets}/{angle}/view/{climb}` | `/og/climb` | Player, mini player, and climb actions |
| Spray climb | `/b/{slug}/{angle}/view/{climb}` | `/og/climb?board_name=spray&…` | Player and climb actions |
| Climber profile | `/profile/{user_id}` | `/og/profile?user_id=` | Your Profile tab and public profile headers |
| Setter | `/setter/{username}` | `/og/setter?username=` | Setter playlist header |
| Playlist | `/playlists/{uuid}` | `/og/playlist?uuid=` | Public playlist header |
| Session recap | `/session/{id}` | `/og/session?sessionId=` | Session detail header |
| Session invitation | `/join/{id}` | `/og/session?sessionId=&variant=join` | Active session invitation sheet |
| Gym | `/gym/{slug}` | `/og/place?kind=gym&slug=` | Expanded gym heading in Wall Finder |
| Board or Spraywall | `/b/{slug}` | `/og/place?kind=board&slug=` | Board detail Share link and its share sheet |

A board link resolves to its angle-specific list page. Climb `/play/` URLs use
the same card as their canonical `/view/` URL.

## Visibility and preview rules

| Entity | Share and preview availability |
| --- | --- |
| Climb | Drafts have no shareable link. Catalogue cards show published climbs. Spray climb cards require a public wall; an unlisted wall link carries `?wall={uuid}` and has no public card. |
| Profile | Share appears once visibility is known and the profile is public. Private profiles have no public card, including when the viewer can read their activity. |
| Setter | The card requires at least one publicly listable climb. |
| Playlist | The app Share button and public card require a public playlist. |
| Session | Recap cards require anonymous access and at least one visible tick. A live invitation has a join card; an ended invitation can fall back to a recap. `daily:` feed groups retain the web `/api/og/session` card. |
| Gym | Share requires a public gym and a slug. The card is gated by anonymous gym access. |
| Home board | Public and Unlisted boards share a plain link and can have a card. Owners can share Followers and Invite-only boards through a tokened invitation, which has no public card. Only-me boards have no share action. |
| Spraywall | Public and Unlisted walls can share links. Only a public, published wall with a public photo copy gets a place card. Private walls have no share action. |

Access tokens belong only in the page URL that grants access. Never attach
`invite` or `wall` capabilities to an OG image URL, analytics, logs, or toasts.
Card endpoints check anonymous access before reading cached bytes.

Sharing opens the native or browser share menu when available. A browser without
a share menu copies the link and confirms the copy. Cancelling a share menu is
quiet; failed sharing or copying shows a localized error. Preview prewarming is
best effort and never delays the share menu.

## App landing routes

Expo landing aliases send `/profile/{user_id}` to the Profile tab's user detail
and `/session/{id}` to Home's session detail, with a tab root behind the screen
for Back. Playlist and setter links have equivalent aliases into Discover.

Gym pages intentionally open in the browser. The iOS association excludes
`/gym/*`. Android's existing associations claim board, join, workout, and preview
links; people, playlist, and recap links continue to open in the browser.
Changing those Android associations requires a native rebuild.

## Web metadata and compatibility

Family card URLs are advertised in both `og:image` and `twitter:image`. Their
`v` parameter combines the render version and a content version. Without a
configured public backend origin, pages keep the site default card.

Legacy `/api/og/{climb,playlist,profile,setter}` URLs redirect to the backend.
`/api/og/session` redirects real session IDs and continues rendering `daily:`
feed groups.

Marketing and utility routes such as About, Help, authentication, and settings
are outside this app Share-button inventory. Utility and private surfaces keep
their `noindex` rules. Any new indexable public page type must also be reviewed
for server-rendered content, metadata, internal links, and sitemap inclusion in
`packages/web/app/lib/seo/sitemap/shard-registry.ts`.

## Website metadata and discovery

Public website pages use `createPageMetadata` and their route metadata builders
so title, description, canonical URL, locale alternates, Open Graph, and Twitter
describe the visible public entity. A share preview does not make a utility,
private, or duplicate route indexable. Join pages retain share metadata and
`noindex, follow`; a missing public recap may omit an image rather than publish
a broken preview.

Endpoint implementations live under `packages/web/app/api/og/` and the backend's
OG handlers. Their parameter validation, visibility checks, caching, and
absent-data behavior remain the source of truth.

`packages/web/next.config.mjs` preserves former utility and board-route links.
App handoff helpers retain the intended board and authoring context and strip
website locale prefixes. See [web architecture](web-reposition.md).

Public canonical indexable URLs belong in the relevant sitemap shard; private,
auth, filtered, and duplicate routes do not. Structured data must match visible
server content, using the appropriate Organization/WebSite, breadcrumb, or
public-profile shape. See [sitemap](sitemap.md).
