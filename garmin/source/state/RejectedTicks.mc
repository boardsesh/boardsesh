using Toybox.Lang;

// Dead-letter store for ticks the server permanently refused (copy-on-write,
// pure). It lives in its own storage value so the outbox format an older
// build reads stays unchanged, and so its 32KB budget is separate.
//
// Every entry keeps the owner the tick was queued under and the server's
// reason. Nothing here is ever sent again, and nothing is ever dropped: a
// valid tick can be refused because of a watch-side gap (no boardUuid on a
// share-link spray wall), so an entry may be a real send. A full store
// refuses the next tick, and the caller keeps it at the head of the outbox.
module RejectedTicks {
    const VERSION = 1;

    function empty() {
        return { "version" => VERSION, "entries" => [] };
    }

    function _validReason(reason) as Lang.Boolean {
        return reason instanceof Lang.String && reason.length() > 0 && reason.length() <= 64;
    }

    function _validEntry(entry) as Lang.Boolean {
        return entry instanceof Lang.Dictionary && OwnedTickOutbox._validOwner(entry["owner"]) &&
            OwnedTickOutbox._validTick(entry["tick"]) && _validReason(entry["reason"]);
    }

    function _valid(store) as Lang.Boolean {
        if (!(store instanceof Lang.Dictionary) || store["version"] != VERSION ||
                !OwnedTickOutbox._validTree(store, 0)) { return false; }
        var entries = store["entries"];
        if (!(entries instanceof Lang.Array)) { return false; }
        for (var index = 0; index < entries.size(); index += 1) {
            if (!_validEntry(entries[index])) { return false; }
        }
        return true;
    }

    // Absent storage is an empty store. Unknown versions and corrupt values are
    // refused, never replaced with an empty store.
    function load(stored) {
        if (stored == null) { return empty(); }
        return _valid(stored) ? OwnedTickOutbox._copyTree(stored) : null;
    }

    function _matches(entry, owner, uuid) as Lang.Boolean {
        return entry["owner"].equals(owner) && entry["tick"]["uuid"].equals(uuid);
    }

    function contains(store, owner, uuid) as Lang.Boolean {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner) || !(uuid instanceof Lang.String)) { return false; }
        var entries = store["entries"];
        for (var index = 0; index < entries.size(); index += 1) {
            if (_matches(entries[index], owner, uuid)) { return true; }
        }
        return false;
    }

    // Returns the next store, or null when the tick cannot be kept here
    // (invalid input, or the store is full). A repeated owner/UUID returns
    // the store unchanged even when full: a crash between this write and the
    // outbox removal leaves one copy in each, and the next drain's identical
    // rejection must not add a second entry.
    function add(store, owner, tick, reason, capacity as Lang.Number) {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner) || !OwnedTickOutbox._validTick(tick) ||
                !OwnedTickOutbox._validTree(tick, 3) || !_validReason(reason) || capacity < 1) {
            return null;
        }
        if (contains(store, owner, tick["uuid"])) { return OwnedTickOutbox._copyTree(store); }
        if (store["entries"].size() >= capacity) { return null; }
        var next = OwnedTickOutbox._copyTree(store);
        next["entries"].add({ "owner" => owner, "tick" => OwnedTickOutbox._copyTree(tick), "reason" => reason });
        return next;
    }

    function isFull(store, capacity as Lang.Number) as Lang.Boolean {
        return _valid(store) && store["entries"].size() >= capacity;
    }

    function countFor(store, owner) as Lang.Number {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner)) { return 0; }
        var entries = store["entries"];
        var count = 0;
        for (var index = 0; index < entries.size(); index += 1) {
            if (entries[index]["owner"].equals(owner)) { count += 1; }
        }
        return count;
    }
}
