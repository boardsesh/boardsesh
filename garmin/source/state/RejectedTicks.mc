using Toybox.Lang;

// Dead-letter store for ticks the server permanently refused (copy-on-write,
// pure). It lives in its own storage value so the outbox format an older
// build reads stays unchanged, and so its 32KB budget is separate.
//
// Every entry keeps the owner the tick was queued under and the server's
// reason. Nothing here is sent again or dropped on its own: a valid tick can
// be refused when its wall's or climb's visibility changed between logging
// and the drain, so an entry may be a real send. (An unlisted spray wall
// never hands its uuid to a session, so the watch cannot log there at all;
// the climber logs those on the phone.) Only the signed-in owner's explicit
// Retry (requeue) or Delete (withoutOwner) on the watch moves an entry out,
// plus one exit for a full store: the signed-in climber may confirm deleting
// other accounts' entries (onlyOwner), offered only at the cap.
// A full store refuses the next tick, and the caller keeps it at the head of
// the outbox.
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

    // This owner's entries, oldest first, as copies. Empty for invalid input.
    function forOwner(store, owner) as Lang.Array {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner)) { return []; }
        var entries = store["entries"];
        var owned = [];
        for (var index = 0; index < entries.size(); index += 1) {
            if (entries[index]["owner"].equals(owner)) { owned.add(OwnedTickOutbox._copyTree(entries[index])); }
        }
        return owned;
    }

    // The store without this owner's entries; null for invalid input. Other
    // accounts' entries are never touched: they are not this login's to drop.
    function withoutOwner(store, owner) {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner)) { return null; }
        var entries = store["entries"];
        var kept = [];
        for (var index = 0; index < entries.size(); index += 1) {
            if (!entries[index]["owner"].equals(owner)) { kept.add(OwnedTickOutbox._copyTree(entries[index])); }
        }
        return { "version" => VERSION, "entries" => kept };
    }

    // Moves this owner's refused ticks back to the END of their outbox queue,
    // oldest first, unchanged (same UUID): at most `limit` of them, and only
    // while the shared queue stays within `capacity`. The caller passes a
    // capacity below the real queue bound, so a batch the server refuses again
    // can never fill the queue and block new logs (a drain dead-letters only
    // one tick per reason). TICK_UUID_CONFLICT entries never move: another
    // account owns that UUID, so a resend can only be refused again.
    // An entry whose UUID is already queued (a crash between the two writes
    // left a copy in each) only leaves the store. Returns
    // { "envelope", "store", "moved" }, or null when nothing moves or the
    // input is invalid. Entries that do not move stay here.
    //
    // A resent UUID cannot become a second logbook entry: saveTick answers a
    // UUID the account already saved with the stored tick.
    function requeue(envelope, store, owner, capacity as Lang.Number, limit as Lang.Number) {
        if (!OwnedTickOutbox._validEnvelope(envelope) || !_valid(store) ||
                !OwnedTickOutbox._validOwner(owner) || capacity < 1 || limit < 1) {
            return null;
        }
        // One validated copy of the owner's queue, not one per entry: the
        // watch's bytecode watchdog bounds work per event.
        var queue = OwnedTickOutbox.forOwner(envelope, owner);
        var room = capacity - OwnedTickOutbox.ownedCount(envelope);
        if (room > limit) { room = limit; }
        var entries = store["entries"];
        var kept = [];
        var moved = 0;
        for (var index = 0; index < entries.size(); index += 1) {
            var entry = entries[index];
            if (!entry["owner"].equals(owner) || "TICK_UUID_CONFLICT".equals(entry["reason"])) {
                kept.add(OwnedTickOutbox._copyTree(entry));
            } else if (OwnedTickOutbox._findIn(queue, entry["tick"]["uuid"]) != null) {
                moved += 1;
            } else if (room > 0) {
                queue.add(OwnedTickOutbox._copyTree(entry["tick"]));
                room -= 1;
                moved += 1;
            } else {
                kept.add(OwnedTickOutbox._copyTree(entry));
            }
        }
        if (moved == 0) { return null; }
        var nextEnvelope = OwnedTickOutbox._copyTree(envelope);
        nextEnvelope["owners"][owner] = queue;
        return {
            "envelope" => nextEnvelope,
            "store" => { "version" => VERSION, "entries" => kept },
            "moved" => moved
        };
    }

    // Entries other owners hold, counted only while the store is at
    // `capacity`: 0 below it or for invalid input (#7636 decision 2). One
    // validation pass, since the session menu reads it.
    function countOthersWhenFull(store, owner, capacity as Lang.Number) as Lang.Number {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner)) { return 0; }
        var entries = store["entries"];
        if (entries.size() < capacity) { return 0; }
        var count = 0;
        for (var index = 0; index < entries.size(); index += 1) {
            if (!entries[index]["owner"].equals(owner)) { count += 1; }
        }
        return count;
    }

    // The store with only this owner's entries, in order; null for invalid
    // input. The mirror of withoutOwner, for the confirmed "delete other
    // accounts' refused ticks" action that exists only while the store is full.
    function onlyOwner(store, owner) {
        if (!_valid(store) || !OwnedTickOutbox._validOwner(owner)) { return null; }
        return { "version" => VERSION, "entries" => forOwner(store, owner) };
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
