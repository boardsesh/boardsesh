# Design previews

Browse the [published previews](previews.md). Editable HTML stays here; generated
PNGs live in the public `dev` object-storage bucket and are ignored by Git.

`vp run design:mockups` captures every HTML mockup at 1440px and 390px, uploads each
PNG, verifies its public download checksum, and updates `previews.json` and
`previews.md`. Pass an HTML file or directory after `--` to capture a subset.
`vp run design:publish` publishes already generated local PNGs without recapturing.
Commit the HTML and updated links together.

Add the variables from `.env.dev-artifacts.example` to the repository root's
ignored `.env.local`, then fill in the dev bucket credentials. Existing process variables take precedence.
These commands use only `DEV_*` storage variables, never production media credentials.
The S3 client sends no ACL header. Content-hashed object keys keep shared links stable.

Only public design PNGs under this directory are accepted. Store captures and
recorded backend fixtures keep their existing capture pipeline.
