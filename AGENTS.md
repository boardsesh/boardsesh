# AGENTS.md

This file adds repo-specific guidance for agents creating or updating public pages in Boardsesh.

## SEO for New Pages

### Decide if the page should rank

- Classify every new route as one of: indexable marketing page, indexable public entity page, utility/auth/session page, or duplicate/alternate experience page.
- Marketing pages should be indexable and canonical to themselves.
- Public entity pages should only be indexable if the first server-rendered HTML contains meaningful public content.
- Utility, auth, settings, session, and ephemeral pages should default to `noindex, follow`.
- Duplicate or alternate UX routes should usually be `noindex, follow` and canonical to the main page.

### Metadata checklist for indexable pages

- Set a unique `title`, `description`, and canonical URL with `alternates.canonical`.
- Add matching Open Graph and Twitter metadata.
- Add an explicit `robots` directive whenever a page should not be indexed.
- Avoid generic titles and descriptions such as `Profile | Boardsesh`, `Playlist | Boardsesh`, or `Page | Boardsesh`.
- Prefer title formats like `Topic or Entity | Boardsesh`.
- Match search intent naturally. Descriptive phrases like `Kilter Board app alternative` are fine when the page clearly presents Boardsesh as a compatible alternative, not the official app.

### First-render content requirements

- If a page is meant to rank, the first server-rendered HTML must include useful text content.
- Ship at least one clear `h1`, one or more descriptive paragraphs, and crawlable internal links near the top of the page.
- Do not rely on client-only fetching, spinners, drawers, or click-to-open UI for the page's main copy.
- If meaningful public content cannot be rendered on the server, improve SSR or mark the page `noindex`.

### Canonical and noindex defaults

- Canonicalize filtered, sorted, paginated, or query-param variants back to the clean base page unless the variant is intentionally indexable.
- Canonicalize duplicate experiences to the primary route.
- Keep private or auth-gated content out of the index.
- Do not let tool pages, session pages, or alternate player/viewer routes compete with the main public route.

### Internal linking rules

- Important public pages must be reachable through crawlable `Link href` or `<a href>` links.
- Do not rely on `router.push`, clickable `div`s, or button-only navigation for key SEO surfaces.
- Add at least 2 to 3 relevant internal links to or from each new indexable page.
- Use descriptive anchor text that explains the destination.

### Structured data defaults

- Consider JSON-LD for indexable pages when the page type supports it.
- Use `Organization` and `WebSite` for the homepage, `BreadcrumbList` for page hierarchies, and `ProfilePage` for public profile-like pages when appropriate.
- Only add structured data that matches visible page content.
- Validate rich-result markup before shipping when relevant.

### Sitemap rules

- Review sitemap inclusion whenever you add a new public page type.
- Add only public, canonical, indexable URLs to the sitemap.
- Keep utility, duplicate, filtered, and auth-only routes out of the sitemap.
- Use real content timestamps where possible instead of a generic "now" value.

### Pre-ship checklist

- Is this page supposed to rank?
- Does it have unique metadata?
- Is the first server-rendered HTML useful without client hydration?
- Is the canonical correct?
- Should it be `noindex` instead?
- Can crawlers reach it through normal links?
- Should it be added to the sitemap?
- If trademarked board names are used, is the wording descriptive and non-affiliative?
