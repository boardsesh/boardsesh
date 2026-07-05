using Toybox.Application;
using Toybox.Lang;

// Bounded FIFO of SaveTickInput dictionaries that failed to save, persisted in
// Application.Storage under `bs.pendingTicks`.
//
// A tick is only queued on a FAILED save (offline / backend error). The queue
// is flushed on the next successful moment (activity end) by TickFlusher.
// When full, the oldest entry is dropped.
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
        while (result.size() > maxSize) {
            var trimmed = [];
            for (var j = 1; j < result.size(); j += 1) {
                trimmed.add(result[j]);
            }
            result = trimmed;
        }
        return result;
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
        var next = boundedAppend(all(), input, BuildConfig.TICK_QUEUE_MAX);
        Application.Storage.setValue(KEY, next);
    }

    function peekFront() {
        var pending = all();
        if (pending.size() == 0) {
            return null;
        }
        return pending[0];
    }

    // Remove and persist without the first element.
    function popFront() as Void {
        var pending = all();
        if (pending.size() == 0) {
            return;
        }
        var rest = [];
        for (var i = 1; i < pending.size(); i += 1) {
            rest.add(pending[i]);
        }
        Application.Storage.setValue(KEY, rest);
    }

    function clear() as Void {
        Application.Storage.setValue(KEY, []);
    }
}

// Drains TickQueue sequentially: save the front item, and only pop it once the
// backend accepts it. Stops on the first failure (leaving the rest for later)
// and invokes onComplete when the queue is drained or a save fails.
class TickFlusher {
    private var _client as BsClient or Null;
    private var _onComplete;   // Method() or Null

    function initialize(client as BsClient or Null) {
        _client = client;
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
        var first = TickQueue.peekFront();
        if (first == null) {
            _finish();
            return;
        }
        client.saveTick(first, method(:onResult));
    }

    function onResult(code as Lang.Number, data) as Void {
        if (code >= 200 && code < 300 && data != null) {
            TickQueue.popFront();   // accepted -> drop it, continue
            _step();
        } else {
            _finish();              // still failing -> keep the rest for later
        }
    }

    private function _finish() as Void {
        if (_onComplete != null) {
            _onComplete.invoke();
        }
    }
}
