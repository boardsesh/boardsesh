// The test inserts the installed Expo methods below. Small stubs replace only
// React/JSI plumbing; Dispatch and Expo's vendored SQLite engine remain native.
import Foundation

enum JavaScriptActor {
  static func assumeIsolated(_ body: () -> Void) { body() }
}
enum LifecycleEvent { case appContextDestroys }
final class ModuleRegistry {
  var callback: (() -> Void)?
  func post(event: LifecycleEvent) { callback?() }
}
final class AppContext {
  private var hasPostedAppContextDestroys = false
  private var isModuleRegistryInitialized = false
  private(set) var registryInitializations = 0
  lazy var moduleRegistry: ModuleRegistry = {
    isModuleRegistryInitialized = true
    registryInitializations += 1
    return ModuleRegistry()
  }()
  init(registerModules: Bool = true) {
    if registerModules { _ = moduleRegistry }
  }
  var releasedRuntimeObjects = false
  private var _runtime: Int? = 1 {
    didSet {
      if _runtime == nil && oldValue != nil { destroy() }
    }
  }
  private func releaseRuntimeObjects() { releasedRuntimeObjects = true }
  // INSERT_APP_CONTEXT_METHODS
}

struct SQLiteErrorException: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
struct AccessClosedResourceException: Error {}
// Instrument only acquisition timing; production methods below own the lock order.
final class LifecycleLock {
  private let underlying = NSRecursiveLock()
  var afterFirstLock: (() -> Void)?
  func lock() {
    underlying.lock()
    let callback = afterFirstLock
    afterFirstLock = nil
    callback?()
  }
  func unlock() { underlying.unlock() }
}
final class StatementLock {
  private let underlying = NSLock()
  func withLock<Result>(_ body: (inout Void) throws -> Result) rethrows -> Result {
    underlying.lock()
    defer { underlying.unlock() }
    var state: Void = ()
    return try body(&state)
  }
}
// INSERT_SQLITE_RESULTS
enum ExpoModulesCore {
  struct Logger { func warn(_ message: String) { fatalError(message) } }
  static let log = Logger()
}
final class NativeDatabase {
  struct OpenOptions {
    let finalizeUnusedStatementsBeforeClosing = true
    let enableChangeListener = true
  }
  let openOptions = OpenOptions()
  var pointer: OpaquePointer?
  var isClosed = false
  let closeLock = NSLock()
  let statementLifecycleLock = LifecycleLock()
  var statements: [NativeStatement] = []
  let sharedObjectId: Int
  init(path: String, id: Int) {
    var connection: OpaquePointer?
    precondition(exsqlite3_open(path, &connection) == SQLITE_OK)
    pointer = connection!
    sharedObjectId = id
  }
  // INSERT_DATABASE_METHODS
  func prepareForShutdown(_ source: String) throws {
    try prepare(statement: NativeStatement(), source: source)
  }
  func executeDuringShutdown(_ source: String) throws {
    try exec(source: source)
  }
}
final class NativeStatement {
  var pointer: OpaquePointer?
  var isFinalized = false
  let lock = StatementLock()
  // INSERT_STATEMENT_METHODS
}
private let moduleQueueKey = DispatchSpecificKey<Void>()
final class SQLiteModule {
  private static let cacheLock = NSRecursiveLock()
  private var contextPairs = [Unmanaged<AnyObject>]()
  private var cachedDatabases = [NativeDatabase]()
  // INSERT_SQLITE_QUEUE
  // INSERT_SQLITE_METHODS
  func open(_ path: String, id: Int) -> NativeDatabase {
    let database = NativeDatabase(path: path, id: id)
    Self.cacheLock.withLock { cachedDatabases.append(database) }
    return database
  }
  // Replace the JSI change event only; keep the actual cache-lock rendezvous.
  private func addUpdateHook(_ database: NativeDatabase) {
    Self.cacheLock.withLock {}
  }
  func initialize(_ database: NativeDatabase) throws { try initDb(database: database) }
  func destroy() { closeAllDatabases() }
  func submit(_ operation: @escaping () -> Void) { moduleQueue.async(execute: operation) }
  func drain() { moduleQueue.sync(flags: .barrier) {} }
}

func execute(_ database: NativeDatabase, _ sql: String) {
  precondition(!database.isClosed)
  precondition(exsqlite3_exec(database.pointer, sql, nil, nil, nil) == SQLITE_OK, sql)
}
func rowCount(_ database: NativeDatabase, table: String = "probe") -> Int32 {
  var statement: OpaquePointer?
  precondition(exsqlite3_prepare_v2(database.pointer, "SELECT COUNT(*) FROM \(table)", -1, &statement, nil) == SQLITE_OK)
  precondition(exsqlite3_step(statement) == SQLITE_ROW)
  let count = exsqlite3_column_int(statement, 0)
  precondition(exsqlite3_finalize(statement) == SQLITE_OK)
  return count
}

let scenario = CommandLine.arguments[1]
let path = CommandLine.arguments[2]
if scenario == "lifecycle" {
  var deliveries = 0
  var context: AppContext? = AppContext()
  context!.moduleRegistry.callback = { [weak retainedContext = context] in
    precondition(retainedContext!.releasedRuntimeObjects)
    deliveries += 1
    retainedContext!.destroy()
  }
  context!.destroy()
  context!.destroy()
  precondition(deliveries == 1)
  context = nil
  precondition(deliveries == 1)
  var fallback: AppContext? = AppContext()
  fallback!.moduleRegistry.callback = { deliveries += 1 }
  fallback = nil
  precondition(deliveries == 2)
  let neverRegistered = AppContext(registerModules: false)
  neverRegistered.destroy()
  precondition(neverRegistered.registryInitializations == 0)
} else {
  let oldModule = SQLiteModule()
  let oldMain = oldModule.open(path, id: 1)
  execute(oldMain, """
    PRAGMA journal_mode=WAL;
    CREATE TABLE probe(id INTEGER PRIMARY KEY);
    CREATE TABLE ticks(id INTEGER PRIMARY KEY);
    CREATE TABLE outbox(tick_id INTEGER PRIMARY KEY);
    BEGIN; INSERT INTO probe VALUES (0); INSERT INTO ticks VALUES (0); INSERT INTO outbox VALUES (0); COMMIT;
    """)
  let oldWriter = oldModule.open(path, id: 2)
  execute(oldWriter, "BEGIN IMMEDIATE; INSERT INTO probe VALUES (1); INSERT INTO ticks VALUES (1); INSERT INTO outbox VALUES (1)")
  let newModule = SQLiteModule()
  let newConnection = newModule.open(path, id: 3)
  precondition(rowCount(newConnection) == 1)
  precondition(exsqlite3_exec(newConnection.pointer, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_BUSY)

  if scenario == "retained-context" {
    let context = AppContext()
    context.moduleRegistry.callback = { oldModule.destroy() }
    context.destroy()
    context.destroy()
    // The old module and both connections remain strongly retained here.
    precondition(oldMain.isClosed && oldWriter.isClosed)
  } else if scenario == "admitted-prepare" {
    let entered = DispatchSemaphore(value: 0)
    let finishPrepare = DispatchSemaphore(value: 0)
    let closeAttempted = DispatchSemaphore(value: 0)
    let closed = DispatchSemaphore(value: 0)
    oldModule.submit {
      entered.signal()
      finishPrepare.wait()
      precondition(!oldWriter.isClosed, "cleanup overtook an admitted operation")
      try! oldWriter.prepareForShutdown("SELECT * FROM probe")
      // Deliberately leave this admitted statement for shutdown to finalize.
    }
    entered.wait()
    DispatchQueue.global().async {
      closeAttempted.signal()
      oldModule.destroy()
      closed.signal()
    }
    closeAttempted.wait()
    precondition(closed.wait(timeout: .now() + 0.25) == .timedOut, "cleanup did not wait for the admitted operation")
    finishPrepare.signal()
    precondition(closed.wait(timeout: .now() + 5) == .success)
  } else if scenario == "same-queue" {
    let submitted = DispatchSemaphore(value: 0)
    oldModule.submit {
      oldModule.destroy()
      submitted.signal()
    }
    precondition(submitted.wait(timeout: .now() + 5) == .success, "cleanup deadlocked its own queue")
    oldModule.drain()
  } else if scenario == "other-module-queue" {
    let submitted = DispatchSemaphore(value: 0)
    newModule.submit {
      oldModule.destroy()
      submitted.signal()
    }
    precondition(submitted.wait(timeout: .now() + 5) == .success)
    oldModule.drain()
    newModule.drain()
  } else if scenario == "init-close-lock-order" {
    let acquiredLifetime = DispatchSemaphore(value: 0)
    let finishInitialization = DispatchSemaphore(value: 0)
    let initialized = DispatchSemaphore(value: 0)
    let closeAttempted = DispatchSemaphore(value: 0)
    let closed = DispatchSemaphore(value: 0)
    oldWriter.statementLifecycleLock.afterFirstLock = {
      acquiredLifetime.signal()
      finishInitialization.wait()
    }
    DispatchQueue.global().async {
      try! oldModule.initialize(oldWriter)
      initialized.signal()
    }
    precondition(acquiredLifetime.wait(timeout: .now() + 5) == .success)
    DispatchQueue.global().async {
      closeAttempted.signal()
      oldModule.destroy()
      closed.signal()
    }
    closeAttempted.wait()
    precondition(closed.wait(timeout: .now() + 0.25) == .timedOut)
    finishInitialization.signal()
    precondition(initialized.wait(timeout: .now() + 5) == .success, "init and close acquired cache/lifetime locks in opposite order")
    precondition(closed.wait(timeout: .now() + 5) == .success)
  } else if scenario == "concurrent-exec" {
    // SDK 58's @JS(.concurrent) operations bypass moduleQueue. Only the
    // installed exec method's connection-lifetime lock makes teardown wait.
    let acquiredLifetime = DispatchSemaphore(value: 0)
    let finishExecution = DispatchSemaphore(value: 0)
    let executed = DispatchSemaphore(value: 0)
    let closeAttempted = DispatchSemaphore(value: 0)
    let closed = DispatchSemaphore(value: 0)
    oldWriter.statementLifecycleLock.afterFirstLock = {
      acquiredLifetime.signal()
      finishExecution.wait()
    }
    DispatchQueue.global().async {
      try! oldWriter.executeDuringShutdown("INSERT INTO probe VALUES (3)")
      executed.signal()
    }
    precondition(acquiredLifetime.wait(timeout: .now() + 5) == .success, "concurrent exec has no connection-lifetime guard")
    DispatchQueue.global().async {
      closeAttempted.signal()
      oldModule.destroy()
      closed.signal()
    }
    closeAttempted.wait()
    precondition(closed.wait(timeout: .now() + 0.25) == .timedOut, "cleanup overtook a running concurrent exec")
    finishExecution.signal()
    precondition(executed.wait(timeout: .now() + 5) == .success)
    precondition(closed.wait(timeout: .now() + 5) == .success)
  } else {
    fatalError("unknown scenario")
  }
  precondition(oldMain.isClosed && oldWriter.isClosed)
  precondition(!newConnection.isClosed)
  precondition(rowCount(newConnection) == 1, "committed rows were lost or abandoned writes were committed")
  precondition(rowCount(newConnection, table: "ticks WHERE id = 0") == 1)
  precondition(rowCount(newConnection, table: "outbox WHERE tick_id = 0") == 1)
  precondition(rowCount(newConnection, table: "ticks WHERE id = 1") == 0)
  precondition(rowCount(newConnection, table: "outbox WHERE tick_id = 1") == 0)
  execute(newConnection, "BEGIN IMMEDIATE; INSERT INTO probe VALUES (2); INSERT INTO ticks VALUES (2); INSERT INTO outbox VALUES (2); COMMIT")
  precondition(rowCount(newConnection) == 2)
  precondition(rowCount(newConnection, table: "ticks") == 2)
  precondition(rowCount(newConnection, table: "outbox") == 2)
  oldModule.destroy()
  newModule.destroy()
}
print("PASS \(scenario)")
