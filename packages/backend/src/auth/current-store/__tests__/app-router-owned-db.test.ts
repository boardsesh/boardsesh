import { describe, expect, it } from 'vite-plus/test';
import { ownedAppRouterAdminDatabase, ownedAppRouterDatabase } from './fixtures/app-router-owned-db';
const role = `ba03_router_stock_${'a'.repeat(32)}`;
const password = 'b'.repeat(64);
const connection = (port = '15478', host = '127.0.0.1', database = 'boardsesh_backend_test_w0_abcdef123456') =>
  `postgresql://${role}:${password}@${host}:${port}/${database}`;
describe('owned App Router fixture database boundary', () => {
  it.each([
    undefined,
    'postgresql://postgres:postgres@127.0.0.1:5433/boardsesh_backend_test',
    'postgresql://postgres:postgres@production.example.test:15478/boardsesh_backend_test',
  ])('rejects missing or unsafe browser admin configuration before global setup', (input) => {
    expect(() => ownedAppRouterAdminDatabase(input)).toThrow();
  });
  it('accepts only an explicit owned browser admin database', () => {
    expect(
      ownedAppRouterAdminDatabase('postgresql://postgres:postgres@127.0.0.1:15478/boardsesh_backend_test'),
    ).toContain(':15478/');
  });
  it.each(['5433', '15475', '15478'])(
    'accepts configured backend test port %s with salted worker database and generated LOGIN role',
    (port) => {
      expect(ownedAppRouterDatabase(connection(port)).port).toBe(port);
    },
  );
  it('accepts a normal unsalted backend worker without CI-specific environment flags', () => {
    expect(ownedAppRouterDatabase(connection('5433', 'localhost', 'boardsesh_backend_test_w1')).port).toBe('5433');
  });
  it.each([
    connection('15478', 'production.example.test'),
    connection('15478', '127.0.0.1', 'boardsesh_backend_test'),
    connection('15478', '127.0.0.1', 'customer_accounts'),
    connection().replace(role, 'postgres'),
    `${connection()}?options=unsafe`,
    connection('5432'),
    connection('5433', 'production.example.test'),
    connection('5433', 'localhost', 'boardsesh_backend_test'),
    connection('5433').replace(role, 'postgres'),
  ])('refuses an unowned destination or principal', (input) => {
    expect(() => ownedAppRouterDatabase(input)).toThrow('Unowned proof database');
  });
});
