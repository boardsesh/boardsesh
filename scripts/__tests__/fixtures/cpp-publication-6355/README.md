# Reviewed manufacturer publication source pairs

These immutable test inputs bind the exact seven #6355 source changes. The
producer hashes come from `934beb7252534ddee20db1cd7a24db22e5a63fb8` and match the
submitted build 18 source `a988d35c03f29b46aba4bd090f7ced4d8af5f055`. Current hashes
come from `ad224e9376498c9c32beefc5ee88c8ab0904d238`.

The two `privacy.*.txt` files preserve the original bytes of
`packages/shared/privacy/src/index.ts` for full verifier tests without depending
on future application edits or Git history in shallow CI. They are test inputs,
not screenshot recordings. The manifest covers all seven reviewed pairs; only
Kilter, Tension and MoonBoard may use this exception. Spray is rejected.
