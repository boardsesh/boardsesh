# Gym place search

The shared gym search form on the homepage and `/gyms` suggests towns from our
own PostgreSQL database. No request-time geocoding service or API key is involved.
Selecting a town searches gym coordinates within 50 km; the town name does not
become a gym-name filter. Submitting text without choosing a suggestion still
searches gym names and addresses.

## Source and attribution

We import GeoNames `cities500.zip`, `countryInfo.txt`, and
`admin1CodesASCII.txt` from https://download.geonames.org/export/dump/.
GeoNames data is licensed under CC BY 4.0. The form links to GeoNames;
see https://download.geonames.org/export/dump/readme.txt for the dataset terms.
This is a city/town gazetteer, not street-address geocoding. Places missing from
the source cannot appear as suggestions, and gyms without coordinates cannot
appear in geographic results.

The `places` table stores display names, regions, countries, coordinates,
population, normalized names and searchable aliases. `pg_trgm` is already a
database prerequisite (migration 0068). Search matches every normalized token,
then ranks complete city names, longest first (including queries with country/region qualifiers),
before name prefixes and other matches, breaking ties by
population descending and GeoNames ID ascending. The public `searchPlaces`
GraphQL query accepts 3–80 trimmed characters and returns at most five rows.

## Initial import and refresh

Apply database migrations first, then run:

```sh
vp run db:import-places -- --if-empty
```

The production migration job runs this before releasing backend or web. It skips
downloads when the dataset's completed-import record exists. The first run needs
HTTPS access to GeoNames and `unzip` (available on the deployment runner). A failed
import fails the deployment gate rather than releasing an empty autocomplete.

For an explicit refresh, omit `--if-empty`. To use previously downloaded,
extracted source files:

```sh
vp run db:import-places -- --source-dir /absolute/path/to/geonames
```

That directory must contain `cities500.txt`, `countryInfo.txt` and
`admin1CodesASCII.txt`. `DB_URL` explicitly selects a target database; without it,
the usual script environment selects the developer database. Never print the
connection string in logs. No refresh is scheduled automatically.

Sources are validated before writes. Batches and provenance (checksums, source
timestamps, import time and row count) commit in one transaction, under an
advisory lock. Upserts retain IDs and never delete places or modify gym rows.
A failed refresh leaves the previous searchable index intact.

## URLs and failure behavior

Selection produces `place`, `lat`, `lng`, and `radius` query parameters. `place`
is a display label only; it is bounded to 200 characters and ignored without
valid coordinates. Filters and pagination preserve these parameters. Editing
the selected place clears its geographic fields; clearing the area restores
ordinary browse mode and the device-location action. Device GPS coordinates
remain transient and are not put in URLs.

Autocomplete waits 300 ms and aborts obsolete requests. Lookup failure displays
a translated message while leaving the GET gym-name search usable. Results,
pagination and distance labels remain server-rendered; metadata/canonicals are
unchanged. Analytics retain only existing lengths/counts/flags, never place
names or coordinates.

## Checks

Type Sydney and select the Australian result. Nearby gyms should include
9 Degrees Waterloo, despite its address not containing Sydney. Change radius
and board type, follow pagination, and reload the URL: the selected town must
remain. Clear the place and search a gym name. Try the homepage, translated
routes, keyboard selection, and a simulated lookup failure.

## Mobile map discovery

The mobile Gyms map sends the first usable search immediately. Later changes to
the map position, submitted search, filters, or reset share one trailing 500 ms
debounce. Gym and board searches use the same final inputs. Small movements and
programmatic camera echoes do not trigger new searches; superseded requests are
cancelled.

Board discovery shares the server cooldown across search inputs and hooks. A
`searchBoards` `RATE_LIMITED` response delays the next attempt by
`retryAfterSeconds` plus 250 ms, using 60 seconds when the delay is missing or
invalid. Each board search allows two delayed retries. Changes during cooldown
replace the pending inputs, and unmounting cancels cooldown waits. The backend
limit remains 20 requests per minute.

The map and list retain their last successful results while updating or waiting
for cooldown. The screen labels these results as updating, then offers a retry
after recovery fails. A successful empty response clears the previous results.
Expected board discovery throttling leaves a sanitized Sentry breadcrumb with
only the operation, retry delay, and source, rather than a handled exception in
Sentry or Observe. Other rate-limited operations still report warnings.

## Creating a gym from the directory

The directory and its board-specific pages link to `/gyms/new`. Setup requires
sign-in and has two steps: details, then existing boards. New listings default to
public, and their creator manages the listing through the existing gym ownership
model. Optional opening hours use the same length limit and confirmation timestamp
as hours entered through the management console.

After the first save, `?gym=<uuid>` identifies the saved gym. Reloading resumes
board association; returning to details edits that gym instead of creating another.
The server validates the identifier and edit access on every resume. Setup is a
`noindex, follow` utility page and is excluded from the sitemap.

Board association reuses the management console's owned-board and nearby-board
controls. Nearby matching retains the 150-metre radius. A global or matching
board-type platform admin may also associate an unlinked public board owned by
someone else, subject to its effective location privacy. Ordinary gym managers
and community leaders do not gain that permission, and boards on human-managed
gyms remain excluded from nearby capture.

Setup supplies the candidate's expected source gym when attaching it. A changed
source produces a conflict so the user can refresh and review the new association.
An imported source listing may be folded into the new gym only after explicit
confirmation; the attachment input's optional fields preserve existing callers'
behavior when omitted. Successful saves and associations invalidate the directory
and facet-count caches through an authenticated action that checks gym edit access.
