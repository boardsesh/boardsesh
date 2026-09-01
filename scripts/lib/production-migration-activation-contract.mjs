export const PRODUCTION_MIGRATION_CORE_ENVIRONMENT = Object.freeze({
  MIGRATION_OWNER_ROLE: 'boardsesh_owner',
  MIGRATION_LOGIN_ROLE: 'boardsesh_migrator',
  EXPECTED_MIGRATION_DATABASE: 'railway',
  MIGRATION_RUNTIME_ROLE: 'boardsesh_runtime',
  MIGRATION_RUNTIME_SCHEMAS: 'public drizzle',
});

export const PRODUCTION_MIGRATION_SUBSCRIBER_ENVIRONMENT = Object.freeze({
  MIGRATION_SUBSCRIBER_ROLE: 'boardsesh_pg18_subscriber',
  MIGRATION_SUBSCRIPTION_NAME: 'boardsesh_pg18_sub',
});

export function validateProductionMigrationActivationEnvironment(environment) {
  for (const [environmentName, expectedValue] of Object.entries(PRODUCTION_MIGRATION_CORE_ENVIRONMENT)) {
    if (environment[environmentName] !== expectedValue) {
      throw new Error(`${environmentName} must match the exact production migration contract`);
    }
  }

  const subscriberRole = environment.MIGRATION_SUBSCRIBER_ROLE ?? '';
  const subscriptionName = environment.MIGRATION_SUBSCRIPTION_NAME ?? '';
  if ((subscriberRole === '') !== (subscriptionName === '')) {
    throw new Error('MIGRATION_SUBSCRIBER_ROLE and MIGRATION_SUBSCRIPTION_NAME must be empty or set together');
  }
  if (subscriberRole === '') return 'subscriber-absent';
  if (
    subscriberRole !== PRODUCTION_MIGRATION_SUBSCRIBER_ENVIRONMENT.MIGRATION_SUBSCRIBER_ROLE ||
    subscriptionName !== PRODUCTION_MIGRATION_SUBSCRIBER_ENVIRONMENT.MIGRATION_SUBSCRIPTION_NAME
  ) {
    throw new Error('the active PG18 subscriber pair must match the exact production migration contract');
  }
  return 'subscriber-active';
}
