# Genuine provider account-creation receipt

This follow-up restores native browser OAuth account-creation metadata for the selected-browser flow. Public readiness stays false. It adds no database schema, grant, production configuration, credential issuer or authentication freshness source.

## Original attempt and durable result

Only a successful actual anonymous Google/Apple start can capture attribution. The server validates the signed native attempt marker against the exact actual native callback URL, including its original query encoding, and hashes both with a fixed purpose. That optional digest travels through the private intent, durable flow binding, full preparation binding and sealed browser carrier. Requests with no native marker retain their previous wire shape and flow hashes. A later valid native marker, changed query, ordinary WWW login or account age cannot supply the original binding.

The shared pure attempt policy, with crypto primitives supplied by thin Node adapters, retains the installed synchronous HMAC bytes, cookie name, token purpose and two-minute lifetime. It remains functional correlation metadata. It never proves a user, session, account creation or authentication age.

The readonly creation-receipt entry point shares the existing exact preparation and current-B acknowledgement checks but rejects an unconsumed preparation before any writer can run. It derives `accountCreated` from the plan whose actual apply committed, after the durable preparation consume and actual selected B source proof agree. Returning accounts receive false. Reading the receipt does not apply an identity plan, create a credential, retry a finalizer or change any row. The normal finalizer's response stays unchanged.

## Native private transport and exchange

The selected native callback locates at most four actual ordinary carriers. Only an exact sealed anonymous preparation, physically selected proof, original marker and original callback URL can provide optional native attribution context. Public request fields cannot supply an `accountCreated` bit, owner or generation. That context crosses the existing private native issue DTO; it is verified again by the backend.

Between the receipt read and capability issuance, the backend retains the actual proof, cursor, source expiry, receipt expiry and complete authority frame, including epoch. The normal source issuer independently admits the captured current credential and compares that frame before constructing the capability. Both final source and metadata deadlines survive asynchronous work. Receipt or source uncertainty emits no new capability.

The encrypted native capability may contain the verified account-creation metadata. Existing metadata-free capabilities still decode. Backend-delegation capabilities reject native metadata and remain non-interchangeable with native handoff. No marker timestamp becomes authentication age. Exchange still spends one durable capability receipt in the same transaction as the native credential pair; its optional `accountCreation` response uses the installed additive response contract.

The existing mobile browser fallback stores that actual pair, parses its receipt and passes it to the auth provider's owner and credential-generation fences. Existing consent, partner attribution, conversion deduplication and onboarding handling remain in place. An older response without receipt metadata remains supported. A stale, replaced or unrelated attempt cannot manufacture a new-user conversion.

## Evidence and limits

Owned PostgreSQL/HTTP tests exercise new and returning Google/Apple accounts under both authorities and credential kinds, pending-receipt refusal, original-marker/query mismatch, forged new-account metadata, captured-frame drift, one-shot exchange and unchanged unknown authentication age. Actual mobile browser-fallback subprocesses run the product auth client, receipt parser and SecureStore policy against the owned HTTP exchange; only native host I/O is replaced. Installed NextAuth proofs separately exercise original marker capture, emitted proof cookies and the actual selected native callback. Private RPC is mocked in those framework proofs; these layers do not claim a joined real-browser-plus-database qualification.

Supported browsers/devices, joined deployment qualification, remaining coordinator/writer coverage and rollout/rollback remain tracked in #7430. This implementation does not activate production authentication or complete epic #6975.
