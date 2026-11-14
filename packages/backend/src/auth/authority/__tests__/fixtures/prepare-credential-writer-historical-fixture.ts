import {
  materializeHistoricalCredentialWriterMigrations,
  HISTORICAL_CREDENTIAL_FIXTURE,
} from './credential-writer-historical-fixture';

async function prepare() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_[0] !== '--out' || !arguments_[1])
    throw new Error('HISTORICAL_CREDENTIAL_FIXED_PROFILE_REQUIRED');
  await materializeHistoricalCredentialWriterMigrations(arguments_[1]);
  process.stdout.write(
    `Prepared ${HISTORICAL_CREDENTIAL_FIXTURE.profile}: ${HISTORICAL_CREDENTIAL_FIXTURE.count} pinned migrations\n`,
  );
}
void prepare().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'HISTORICAL_CREDENTIAL_FIXTURE_UNAVAILABLE'}\n`);
  process.exitCode = 1;
});
