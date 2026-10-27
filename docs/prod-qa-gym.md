# Production QA gym

`embedded/scripts/provision-qa-gym.mjs` provisions a shared, unlisted **Boardsesh QA gym** after the ESP32 hardware feasibility gate passes. It uses the normal authenticated GraphQL API. It does not deploy software, connect to Postgres, create accounts, or flash hardware.

The gym is public by direct link and has `isListed: false`. Its description identifies it as simulated QA hardware, not a climbing venue. No address, location name, latitude, or longitude is invented. The linked boards remain public and listed individually so maintainers opening the gym link can enumerate them; inherited gym listing keeps them off global discovery and indexing.

| Fixture | Layout | Size | Hold sets | Angle | Preferred serial |
| --- | --- | --- | --- | --- | --- |
| Kilter Homewall Full | 8 | 25 | 26,27,28,29 | 40° | 99000001 |
| Tension 2 Mirror | 10 | 6 | 12,13 | 40° | 99000002 |
| MoonBoard 2024 Standard | 3 | 1 | 5,6,7,8,9,10 | 40° | 99000003 |

MoonBoard's Standard size is `1`; its 2024 hold sets are `5` through `10`, as defined in `packages/shared/board-config/src/moonboard-config.ts`. Stock MoonBoard controllers still work without a serial. This fixture intentionally advertises its optional serial after the stock `MoonBoard A` prefix.

## Release order and hardware gate

1. Prove three independent connectable advertisements, connection routing, and payload handling on the USB-connected ESP32. Keep production provisioning blocked until this passes.
2. Deploy the database migration and backend change that add `Gym.isListed`, inherited discovery filtering, `controllerGymManifest`, `observedBoardSerialMatches`, and `/render/controller-preview`.
3. Review a provisioning dry run, then apply it using the normal account that will own the QA gym and controller.
4. Build the fixture firmware with the returned gym UUID, configure its private controller key locally, and capture the display while exercising all three boards.
5. Ship the mobile observed-serial client change with its required Astra/Fable BLE review before relying on fixture serial resolution in mobile.

The cloud/schema change can be reviewed separately from fixture firmware and mobile changes. Its PR notes must say that provisioning waits for the hardware gate. Fixture/mobile PR notes must name the deployed backend dependency and require the three-board connection and screenshot QA. No production UUID is recorded in this document until provisioning actually runs.

## Normal account credentials

Sign in to the production website with the account intended to own the fixture. The browser client obtains its backend token from the authenticated `GET /api/internal/ws-auth` route. In the browser's Network panel, use that response's `token` value, or the `Authorization: Bearer …` value from one of your own authenticated GraphQL requests. Use that normal user token, not a controller key, deployment token, database password, or another person's session.

Pass the token through `BOARDSESH_USER_TOKEN` or an existing private file containing just the token. Do not place a literal token in a command, repository file, PR, screenshot, or chat. For a zsh session, read it without echoing it or storing it in shell history:

```sh
read -rs BOARDSESH_USER_TOKEN
export BOARDSESH_USER_TOKEN
```

Paste the token at the hidden prompt and press Enter. After provisioning, run `unset BOARDSESH_USER_TOKEN`. Tokens can expire; sign in again and repeat the dry run if authentication fails. The script checks `profile.id` before mutations and never saves the user token.

## Dry run and apply

From the repository root:

```sh
vp exec node embedded/scripts/provision-qa-gym.mjs
```

Or use an existing private token file:

```sh
vp exec node embedded/scripts/provision-qa-gym.mjs --token-file /private/tmp/boardsesh-user-token
```

The default is read-only: no mutations, credential files, result files, or generated headers. Before planning writes, the script checks live GraphQL fields for the unlisted gym and controller manifest contract, validates the three catalog preview geometries, reads owned gyms/boards/controllers, and checks serial collisions across Kilter, Tension, and MoonBoard. A backend missing the new schema causes an immediate abort; the script never creates a public placeholder gym.

Review the printed plan. Apply it only after the hardware gate and backend deployment:

```sh
vp exec node embedded/scripts/provision-qa-gym.mjs --apply
```

The first mutation creates the gym with `isPublic: true, isListed: false`. Because `createGym` generates its own slug, `updateGym` then sets `boardsesh-qa`. New boards are linked during creation. Identified orphaned fixture boards can be relinked through `linkBoardToGym`; unrelated boards are never moved or overwritten. `allowDuplicateConfig: true` is scoped to these deliberately separate simulated fixture boards, while `allowDuplicateSerial` remains false.

The default files are:

| File | Contents |
| --- | --- |
| `/private/tmp/boardsesh-qa-controller.json` | Private device key, controller ID, owning user ID, endpoint, gym UUID; mode `600` |
| `/private/tmp/boardsesh-qa-gym.json` | Nonsecret gym/board UUIDs, serials, configurations, controller ID, and endpoints |

The console prints only the nonsecret fixture result. The public result JSON and generated header contain no controller key. `--out` and `--result-file` override the paths. Back up the private controller file in your normal credential store: the API returns a controller key only once, at registration. A local lock prevents two applies sharing that credential path; after an interrupted process, inspect the fixture and confirm no provisioning process is running before removing its leftover `.lock` file.

Rerun the same command and file paths to reuse the gym, all three boards, and controller. The fixture is identified by its owner, stable names, marker description, and saved gym UUID. `--gym-uuid UUID` selects an existing owned QA gym explicitly when its identity is ambiguous. A conflicting `boardsesh-qa` slug, unrelated linked board, unexpected existing fixture configuration, or serial shared with another wall aborts instead of modifying those records.

If a preferred serial is occupied, even by a private board visible only as geometry, the script selects an unused `990000xx` serial. It preserves other boards' available preferred serials. If another writer claims a serial between the lookup and mutation, the backend rejects creation; rerun the dry run to choose from the new inventory. Partial applies are resumable and do not roll back by deleting records.

If the private key file is lost or its controller was deleted, the script refuses to register a duplicate automatically. Restore the key file, or explicitly pass `--new-controller` to register a replacement. This flag creates another registration and does not delete the old one. An API key rotated outside this script may require that same explicit replacement; keys cannot be recovered from `myControllers`.

## Firmware defaults and local settings

To generate the small credential-free header from the actual returned gym UUID:

```sh
vp exec node embedded/scripts/provision-qa-gym.mjs --apply --write-defaults
```

The default header is `embedded/projects/board-controller/src/gym/provisioned_defaults.h`; `--defaults-header PATH` overrides it. The tracked placeholder carries the script's managed-file marker and the safe `boardsesh-qa` fallback. Provisioning can replace that placeholder or a previously generated header; it refuses to overwrite an unrelated file. The generated header defines only `GYM_FIXTURE_DEFAULT_GYM`, validates that the returned value is a UUID, and never invents a production ID. The fixture target includes this header globally through its compiler flags, keeping runtime and local settings defaults consistent. Provisioning does not build or flash firmware.

Open the device's existing local configuration page after connecting it to WiFi. Its **Gym Fixture** section accepts a Boardsesh gym URL, slug, or UUID, the production endpoint `wss://ws.boardsesh.com/graphql`, and the controller key from the private output file. Saving reloads the fixture configuration. A blank key keeps the saved key; the explicit clear checkbox removes it. GET configuration/status responses return only `fixture_key_configured`, never the key.

The device connects over GraphQL WebSocket with `connectionParams.controllerApiKey`. That key does not create a normal signed-in user context and cannot authenticate the HTTP GraphQL transport. `controllerGymManifest` looks up the controller's registered user and requires that user to own or administer the selected gym. Maintainers can open the shareable gym URL without credentials; the gym owner must add an existing account as a gym admin for it to administer the gym or use its own registered controller. `UserBoard.serialNumber` remains owner-only. Mobile correlates an already observed serial through `observedBoardSerialMatches` instead of widening that field.

The status page shows the gym name, refresh/cache status, and up to three board names, serials, advertised names, advertising state, and last payload LED counts. Confirm each board independently accepts a climb and appears in a captured display. Also test an offline restart, changed gym/key settings, and a revoked controller registration: explicit authentication/permission denial must stop advertising cached identities.

## Local verification

```sh
vp exec node --test embedded/scripts/provision-qa-gym.test.mjs
```

The fake GraphQL integration validates every operation against the repository's real generated schema. It covers schema/auth/catalog aborts before writes, dry runs without files, idempotent applies, private serial collisions, partial recovery, missing/revoked key protection, orphan relinking, owner-only credential files, and UUID-safe header generation. It performs no production requests.
