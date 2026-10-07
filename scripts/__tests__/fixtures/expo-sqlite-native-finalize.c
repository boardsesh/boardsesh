/* Exercise the SQLite engine shipped by Expo, without a simulator or device.
 * The Kotlin/Swift finalized-state guards are covered by mobile-patches-check;
 * these cases prove why their error paths still own a destroyed statement. */
#include "sqlite3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void require_code(int actual, int expected, const char *operation) {
  if (actual != expected) {
    fprintf(stderr, "%s: expected SQLite code %d, received %d\n", operation, expected, actual);
    exit(1);
  }
}

static void execute(sqlite3 *database, const char *source) {
  require_code(exsqlite3_exec(database, source, NULL, NULL, NULL), SQLITE_OK, source);
}

static exsqlite3_stmt *prepare(sqlite3 *database, const char *source) {
  exsqlite3_stmt *statement = NULL;
  require_code(exsqlite3_prepare_v2(database, source, -1, &statement, NULL), SQLITE_OK, source);
  return statement;
}

static void finalize_once(sqlite3 *database, exsqlite3_stmt *statement, int expected) {
  require_code(exsqlite3_finalize(statement), expected, "finalize");
  /* Inspect the connection's statement registry, never dereference the freed
   * pointer or call finalize twice (which would itself be undefined behavior). */
  if (exsqlite3_next_stmt(database, NULL) != NULL) {
    fprintf(stderr, "finalize left an outstanding native statement\n");
    exit(1);
  }
}

static int read_sent(sqlite3 *database) {
  exsqlite3_stmt *statement = prepare(database, "SELECT sent FROM ticks WHERE id = 1");
  require_code(exsqlite3_step(statement), SQLITE_ROW, "read persisted tick");
  int sent = exsqlite3_column_int(statement, 0);
  finalize_once(database, statement, SQLITE_OK);
  return sent;
}

int main(int argument_count, char **arguments) {
  if (argument_count != 3) {
    fprintf(stderr, "usage: sqlite-finalize <scenario> <database-path>\n");
    return 1;
  }
  const char *scenario = arguments[1];
  sqlite3 *writer = NULL;
  sqlite3 *competitor = NULL;
  require_code(exsqlite3_open(arguments[2], &writer), SQLITE_OK, "open writer");
  /* Rollback journal is deliberate: a reader can prevent the final commit of
   * UPDATE RETURNING even after its first step has successfully yielded ROW. */
  execute(writer, "PRAGMA journal_mode = DELETE; CREATE TABLE ticks(id INTEGER PRIMARY KEY, sent INTEGER); INSERT INTO ticks VALUES (1, 0)");
  require_code(exsqlite3_open(arguments[2], &competitor), SQLITE_OK, "open competitor");
  require_code(exsqlite3_busy_timeout(writer, 0), SQLITE_OK, "disable busy wait");

  if (strcmp(scenario, "busy") == 0) {
    execute(competitor, "BEGIN IMMEDIATE");
    exsqlite3_stmt *statement = prepare(writer, "UPDATE ticks SET sent = 1 WHERE id = 1");
    require_code(exsqlite3_step(statement), SQLITE_BUSY, "contended write");
    finalize_once(writer, statement, SQLITE_BUSY);
    execute(competitor, "ROLLBACK");
    require_code(read_sent(writer), 0, "failed write stayed rolled back");
  } else if (strcmp(scenario, "constraint") == 0) {
    exsqlite3_stmt *statement = prepare(writer, "INSERT INTO ticks VALUES (1, 1)");
    require_code(exsqlite3_step(statement), SQLITE_CONSTRAINT, "duplicate tick");
    finalize_once(writer, statement, SQLITE_CONSTRAINT);
    require_code(read_sent(writer), 0, "constraint preserved existing tick");
  } else if (strcmp(scenario, "returning-busy") == 0) {
    execute(competitor, "BEGIN; SELECT * FROM ticks");
    exsqlite3_stmt *statement = prepare(writer, "UPDATE ticks SET sent = 1 WHERE id = 1 RETURNING sent");
    require_code(exsqlite3_step(statement), SQLITE_ROW, "RETURNING yields before commit");
    require_code(exsqlite3_column_int(statement, 0), 1, "RETURNING proposed tick");
    finalize_once(writer, statement, SQLITE_BUSY);
    execute(competitor, "ROLLBACK");
    require_code(read_sent(writer), 0, "failed finalization did not commit tick");
  } else if (strcmp(scenario, "success") == 0) {
    exsqlite3_stmt *statement = prepare(writer, "UPDATE ticks SET sent = 1 WHERE id = 1 RETURNING sent");
    require_code(exsqlite3_step(statement), SQLITE_ROW, "uncontended RETURNING");
    finalize_once(writer, statement, SQLITE_OK);
    require_code(read_sent(competitor), 1, "other connection observes committed tick");
  } else {
    fprintf(stderr, "unknown scenario: %s\n", scenario);
    return 1;
  }

  require_code(exsqlite3_close(competitor), SQLITE_OK, "close competitor without leaked statements");
  require_code(exsqlite3_close(writer), SQLITE_OK, "close writer without leaked statements");
  printf("PASS %s\n", scenario);
  return 0;
}
