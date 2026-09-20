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
then ranks exact names before name prefixes and other matches, breaking ties by
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
