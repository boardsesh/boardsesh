# Authentication and identity

Released authentication behavior, staged Better Auth contracts, compatibility requirements and activation gates.

[All documentation](../README.md)

## Start here

- [Mobile Auth Flow](mobile-auth-flow.md)
- [Better Auth migration: backend-owned identity without disrupting installed clients](better-auth-migration.md)
- [Browser sign-in for www and the browser app](better-auth-browser-session.md)
- [Better Auth rollout: every switch, and the order to turn them on](better-auth-rollout.md)

## Guides and supporting records

Current behavior and operational requirements live with their topic. A proposal,
measurement or historical qualification is supporting evidence; its stated limits
and outstanding acceptance gates still apply. A merged change alone does not prove
a production rollout or a physical-device result.

| Document | Path |
| --- | --- |
| [Account email audit](account-email-audit.md) | `account-email-audit.md` |
| [Account deletion and identity authority](better-auth-account-deletion.md) | `better-auth-account-deletion.md` |
| [Actual App Router and configured-provider OAuth proof](better-auth-app-router-oauth.md) | `better-auth-app-router-oauth.md` |
| [First-party authority module (BA-04 PR 6)](better-auth-authority-module.md) | `better-auth-authority-module.md` |
| [BA-03 batch-job system identities](better-auth-batch-system-users.md) | `better-auth-batch-system-users.md` |
| [BA05 browser cookie response-order counterexample](better-auth-browser-cookie-order.md) | `better-auth-browser-cookie-order.md` |
| [Browser sign-in for www and the browser app](better-auth-browser-session.md) | `better-auth-browser-session.md` |
| [Backend credential connection](better-auth-credential-database.md) | `better-auth-credential-database.md` |
| [Dedicated credential writer: reviewed capability profiles](better-auth-credential-writer-capability.md) | `better-auth-credential-writer-capability.md` |
| [BA-03 current-store reservation and revocation foundation](better-auth-current-store-foundation.md) | `better-auth-current-store-foundation.md` |
| [BA-03 current-store password service](better-auth-current-store.md) | `better-auth-current-store.md` |
| [Deleted-account credential admission](better-auth-deletion-readers.md) | `better-auth-deletion-readers.md` |
| [Development identity seed targets](better-auth-dev-auth-seed-guard.md) | `better-auth-dev-auth-seed-guard.md` |
| [Private account email resolution (BA-02 PR 4)](better-auth-email-resolution.md) | `better-auth-email-resolution.md` |
| [First-party authentication enforcement windows](better-auth-enforcement-windows.md) | `better-auth-enforcement-windows.md` |
| [Facebook product sign-in boundary](better-auth-facebook-retirement.md) | `better-auth-facebook-retirement.md` |
| [Account-bound first password after email confirmation](better-auth-first-password-email.md) | `better-auth-first-password-email.md` |
| [Staged fixed system-owner lock order](better-auth-fixed-system-owner-order.md) | `better-auth-fixed-system-owner-order.md` |
| [Identity import and reconciliation](better-auth-identity-import.md) | `better-auth-identity-import.md` |
| [Identity mirror (BA-04 PR 7)](better-auth-identity-mirror.md) | `better-auth-identity-mirror.md` |
| [Better Auth implementation evidence and decisions](better-auth-implementation.md) | `better-auth-implementation.md` |
| [Legacy web credential proof](better-auth-legacy-web-proof.md) | `better-auth-legacy-web-proof.md` |
| [BA-03 location batch preparation](better-auth-location-batch-preparation.md) | `better-auth-location-batch-preparation.md` |
| [Selected-authority location owner and data writes](better-auth-location-writer-adoption.md) | `better-auth-location-writer-adoption.md` |
| [Better Auth migration: backend-owned identity without disrupting installed clients](better-auth-migration.md) | `better-auth-migration.md` |
| [Legacy native JWT clock compatibility](better-auth-native-clock-proof.md) | `better-auth-native-clock-proof.md` |
| [Staged normalized reservations for native OAuth](better-auth-native-oauth.md) | `better-auth-native-oauth.md` |
| [Staged normalized reservations for native registration](better-auth-native-registration.md) | `better-auth-native-registration.md` |
| [Native transfer and watch capability ancestry](better-auth-native-transfer-ancestry.md) | `better-auth-native-transfer-ancestry.md` |
| [Public NextAuth4 callback and compound backend identity proof](better-auth-nextauth-public-handler-proof.md) | `better-auth-nextauth-public-handler-proof.md` |
| [Backend-owned UID-bound password recovery](better-auth-password-recovery.md) | `better-auth-password-recovery.md` |
| [Provider identity planning](better-auth-provider-identity-planning.md) | `better-auth-provider-identity-planning.md` |
| [BA-04 selected-authority provider security](better-auth-provider-security-adoption.md) | `better-auth-provider-security-adoption.md` |
| [Selected-authority provider sign-in writers](better-auth-provider-writer-adoption.md) | `better-auth-provider-writer-adoption.md` |
| [Released native and Garmin source contracts](better-auth-released-client-contracts.md) | `better-auth-released-client-contracts.md` |
| [Renewed historical web login ancestry](better-auth-renewed-web-lineage.md) | `better-auth-renewed-web-lineage.md` |
| [Better Auth implementation review guide](better-auth-review-guide.md) | `better-auth-review-guide.md` |
| [Revocation follows the selected identity authority](better-auth-revocation-authority.md) | `better-auth-revocation-authority.md` |
| [Better Auth rollout: every switch, and the order to turn them on](better-auth-rollout.md) | `better-auth-rollout.md` |
| [Session encoding, publication and reader boundaries](better-auth-session-publication.md) | `better-auth-session-publication.md` |
| [BA-03 shared-board system identity](better-auth-system-board-owner.md) | `better-auth-system-board-owner.md` |
| [Staged verification bound to a user ID](better-auth-uid-verification.md) | `better-auth-uid-verification.md` |
| [Fully migrated user-reference catalog proof](better-auth-user-reference-catalog.md) | `better-auth-user-reference-catalog.md` |
| [Web credential proofs and sensitive writers (BA-04 PR 9c)](better-auth-web-credential-proofs.md) | `better-auth-web-credential-proofs.md` |
| [Backend-owned web OAuth identity writes](better-auth-web-oauth-identity.md) | `better-auth-web-oauth-identity.md` |
| [Staged web password delegation to the current backend store](better-auth-web-password-delegation.md) | `better-auth-web-password-delegation.md` |
| [BA-03 candidate PostgreSQL writer-capability fence](better-auth-writer-fence-proof.md) | `better-auth-writer-fence-proof.md` |
| [Existing identity writers and installed-client contracts](better-auth-writer-inventory.md) | `better-auth-writer-inventory.md` |
| [iOS keychain namespaces (v2 + legacy)](keychain-namespaces.md) | `keychain-namespaces.md` |
| [Mobile Auth Flow](mobile-auth-flow.md) | `mobile-auth-flow.md` |
| [OAuth and Email Verification Setup](oauth-setup.md) | `oauth-setup.md` |
