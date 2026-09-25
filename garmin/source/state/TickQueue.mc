using Toybox.Application;
using Toybox.Lang;

// Bounded FIFO of SaveTickInput dictionaries waiting to save, persisted in
// Application.Storage under `bs.pendingTicks`.
//
// A tick is persisted BEFORE its first request. Its RFC 4122 uuid makes retries
// idempotent at the backend. Accepted and permanently rejected ticks are removed
// by uuid; retryable failures remain queued. When full, the oldest entry drops.
//
// The list math (boundedAppend) is pure so it can be unit-tested without
// Storage; the Storage-touching helpers wrap it.
module TickQueue {
    const KEY = "bs.pendingTicks";

    // PURE: append `item` to `list`, dropping oldest entries until the result
    // is within `maxSize`. Returns a NEW array (does not mutate `list`).
    function boundedAppend(list as Lang.Array or Null, item, maxSize as Lang.Number) as Lang.Array {
        var result = [];
        if (list != null) {
            for (var i = 0; i < list.size(); i += 1) {
                result.add(list[i]);
            }
        }
        result.add(item);
        // At most one item is added per call, so the result can exceed maxSize
        // by at most one — a single drop-oldest is enough (no loop needed).
        if (result.size() > maxSize) {
            var trimmed = [];
            for (var j = 1; j < result.size(); j += 1) {
                trimmed.add(result[j]);
            }
            result = trimmed;
        }
        return result;
    }

    // PURE: remove every entry bearing `uuid`. Removing all duplicates makes a
    // repeated callback harmless and repairs any duplicate persisted entries.
    function withoutUuid(list as Lang.Array or Null, uuid as Lang.String) as Lang.Array {
        var result = [];
        if (list == null) { return result; }
        for (var index = 0; index < list.size(); index += 1) {
            var entry = list[index];
            var entryUuid = entry instanceof Lang.Dictionary ? entry["uuid"] : null;
            var matches = entryUuid instanceof Lang.String && entryUuid.equals(uuid);
            if (!matches) {
                result.add(entry);
            }
        }
        return result;
    }

    function containsUuidIn(list as Lang.Array or Null, uuid as Lang.String) as Lang.Boolean {
        if (list == null) { return false; }
        for (var index = 0; index < list.size(); index += 1) {
            var entry = list[index];
            var entryUuid = entry instanceof Lang.Dictionary ? entry["uuid"] : null;
            if (entryUuid instanceof Lang.String && entryUuid.equals(uuid)) {
                return true;
            }
        }
        return false;
    }

    // Deterministic helper for legacy entries. The caller persists the containing
    // queue before sending; repeated calls retain the first assigned identifier.
    function assignUuidIfMissing(input as Lang.Dictionary, generatedUuid as Lang.String) as Lang.String {
        var existingUuid = input["uuid"];
        if (existingUuid instanceof Lang.String && !existingUuid.equals("")) {
            return existingUuid;
        }
        input["uuid"] = generatedUuid;
        return generatedUuid;
    }

    // PURE: classify a tick-flush result so the front item is handled correctly.
    // Returns one of:
    //   :success -> the tick was accepted (2xx with a body) — pop and continue.
    //   :drop    -> a PERMANENT failure for THIS tick: an HTTP 4xx rejection, or
    //               a GraphQL error (saveTick returns HTTP 200 with null data
    //               only on error). Pop it too, so a poison tick can't block the
    //               rest of the queue forever.
    //   :retry   -> a RETRYABLE failure: a transport error (negative code), auth
    //               (401 — BsClient already tried refresh + routed to pairing),
    //               rate limit (429), or a server 5xx. Keep the queue for later.
    // Extracted as a pure function so the poison-tick handling is unit-testable.
    function classifyFlushResult(code as Lang.Number, hasData as Lang.Boolean) as Lang.Symbol {
        if (code >= 200 && code < 300 && hasData) {
            return :success;
        }
        if (code < 200 || code == 401 || code == 429 || code >= 500) {
            return :retry;
        }
        return :drop;
    }

    function all() as Lang.Array {
        var stored = Application.Storage.getValue(KEY);
        if (stored == null) {
            return [];
        }
        return stored;
    }

    function size() as Lang.Number {
        return all().size();
    }

    function isEmpty() as Lang.Boolean {
        return all().size() == 0;
    }

    function enqueue(input as Lang.Dictionary) as Void {
        var existingUuid = input["uuid"];
        if (!(existingUuid instanceof Lang.String) || existingUuid.equals("")) {
            assignUuidIfMissing(input, Uuid.generate());
        }
        var next = boundedAppend(all(), input, BuildConfig.TICK_QUEUE_MAX);
        Application.Storage.setValue(KEY, next);
    }

    // Returns the front tick after ensuring legacy pre-uuid queue entries have
    // a generated uuid persisted BEFORE the request is made.
    function prepareFront() {
        var pending = all();
        if (pending.size() == 0) {
            return null;
        }
        var first = pending[0];
        if (first instanceof Lang.Dictionary) {
            var existingUuid = first["uuid"];
            if (!(existingUuid instanceof Lang.String) || existingUuid.equals("")) {
                assignUuidIfMissing(first, Uuid.generate());
                Application.Storage.setValue(KEY, pending);
            }
        }
        return first;
    }

    function removeUuid(uuid as Lang.String) as Void {
        Application.Storage.setValue(KEY, withoutUuid(all(), uuid));
    }

    function containsUuid(uuid as Lang.String) as Lang.Boolean {
        return containsUuidIn(all(), uuid);
    }

    function clear() as Void {
        Application.Storage.setValue(KEY, []);
    }
}

// Drains TickQueue sequentially. Accepted and permanently rejected ticks are
// removed by exact UUID; retryable failures stay queued for the next flush.
// Invokes onComplete when the queue drains or a retryable failure stops it.
class TickFlusher {
    private var _client as BsClient or Null;
    private var _onComplete;   // Method() or Null
    private var _currentUuid as Lang.String or Null;

    function initialize(client as BsClient or Null) {
        _client = client;
        _currentUuid = null;
    }

    function start(onComplete) as Void {
        _onComplete = onComplete;
        _step();
    }

    private function _step() as Void {
        var client = _client;
        if (client == null) {
            _finish();
            return;
        }
        var first = TickQueue.prepareFront();
        if (first == null) {
            _finish();
            return;
        }
        if (!(first instanceof Lang.Dictionary)) {
            // Stored ticks are dictionaries. Stop safely if storage is corrupt
            // rather than indexing an unexpected value and crashing on exit.
            _finish();
            return;
        }
        var firstUuid = first["uuid"];
        if (!(firstUuid instanceof Lang.String)) {
            // A malformed stored item cannot be sent idempotently. prepareFront
            // normally repairs this; stop defensively rather than crash.
            _finish();
            return;
        }
        _currentUuid = firstUuid;
        client.saveTick(first, method(:onResult));
    }

    function onResult(code as Lang.Number, data) as Void {
        var outcome = TickQueue.classifyFlushResult(code, data != null);
        if (outcome == :retry) {
            // A direct TickLogger request for this same UUID may already have
            // succeeded while our duplicate exit-flush request failed. If so,
            // continue with the next tick instead of ending the drain early.
            if (_currentUuid != null && !TickQueue.containsUuid(_currentUuid)) {
                _currentUuid = null;
                _step();
                return;
            }
            // Still pending: keep the queue and try again on the next flush.
            _finish();
            return;
        }
        // :success (accepted) or :drop (permanent failure) — remove the exact
        // request, not whichever tick is currently first after concurrent logs.
        if (_currentUuid != null) {
            TickQueue.removeUuid(_currentUuid);
        }
        _currentUuid = null;
        _step();
    }

    private function _finish() as Void {
        if (_onComplete != null) {
            _onComplete.invoke();
        }
    }
}
