import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePostgresNotice, resetReportedPostgresNotices } from '../postgres';

void describe('postgres notice handling', () => {
  beforeEach(() => resetReportedPostgresNotices());

  void it('reports a notice once and drops the repeats', () => {
    // The whole point: CheckMyDatabase fires the collation notice on every new
    // backend connection, which on short-lived serverless instances is roughly
    // one log line per request.
    const logged: string[] = [];
    const collation = { code: '01000', message: 'database "railway" has a collation version mismatch' };

    handlePostgresNotice(collation, (message) => logged.push(message));
    handlePostgresNotice(collation, (message) => logged.push(message));
    handlePostgresNotice(collation, (message) => logged.push(message));

    assert.equal(logged.length, 1);
    assert.match(logged[0], /collation version mismatch/);
    assert.match(logged[0], /01000/);
  });

  void it('still reports a notice it has not seen before', () => {
    // Deduping must not become swallowing: a new condition has to surface.
    const logged: string[] = [];

    handlePostgresNotice({ code: '01000', message: 'collation' }, (message) => logged.push(message));
    handlePostgresNotice({ code: '42P07', message: 'relation already exists' }, (message) => logged.push(message));

    assert.equal(logged.length, 2);
    assert.match(logged[1], /relation already exists/);
  });

  void it('falls back to the message when a notice carries no code', () => {
    const logged: string[] = [];

    handlePostgresNotice({ message: 'no code here' }, (message) => logged.push(message));
    handlePostgresNotice({ message: 'no code here' }, (message) => logged.push(message));
    handlePostgresNotice({ message: 'a different one' }, (message) => logged.push(message));

    assert.equal(logged.length, 2);
    assert.match(logged[0], /\(no code\)/);
  });
});
