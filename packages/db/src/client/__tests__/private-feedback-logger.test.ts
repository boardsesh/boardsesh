import assert from 'node:assert/strict';
import { it } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { appFeedback } from '../../schema/app/feedback';
import { QueryLogger } from '../postgres';

void it('redacts a Drizzle feedback insert before the debug logger formats its bindings', (context) => {
  const lines: string[] = [];
  context.mock.method(console, 'info', (line: string) => lines.push(line));
  const note = 'private logger fixture';
  const email = 'private-logger@example.test';
  const insert = drizzle
    .mock()
    .insert(appFeedback)
    .values({
      source: 'board-request',
      platform: 'web',
      boardName: 'Fixture board',
      comment: note,
      context: { boardRequest: { role: 'gym', email } },
    })
    .toSQL();
  assert.match(JSON.stringify(insert.params), /private-logger@example.test/);
  const logger = new QueryLogger();
  logger.logQuery(insert.sql, insert.params);
  logger.logQuery('select * from "public"."app_feedback" where comment = $1', [note]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes('private statement omitted')));
  assert.ok(lines.every((line) => !line.includes(note) && !line.includes(email)));
  logger.logQuery('select $1', ['ordinary debug fixture']);
  assert.match(lines.at(-1) ?? '', /ordinary debug fixture/);
});
