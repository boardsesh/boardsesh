using Toybox.Lang;

// Copy-on-write state only. The storage adapter must persist the complete
// returned envelope in one operation before sending any tick.
module OwnedTickOutbox {
    const VERSION = 2;
    const MAX_DEPTH = 8;

    function _validOwner(owner) as Lang.Boolean {
        return owner instanceof Lang.String && owner.length() > 0 && owner.length() <= 256;
    }

    function _validTree(item, depth as Lang.Number) as Lang.Boolean {
        if (depth > MAX_DEPTH) { return false; }
        if (item instanceof Lang.Dictionary) {
            var keys = item.keys();
            for (var keyIndex = 0; keyIndex < keys.size(); keyIndex += 1) {
                var key = keys[keyIndex];
                if (!(key instanceof Lang.String) || !_validTree(item[key], depth + 1)) { return false; }
            }
            return true;
        }
        if (item instanceof Lang.Array) {
            for (var itemIndex = 0; itemIndex < item.size(); itemIndex += 1) {
                if (!_validTree(item[itemIndex], depth + 1)) { return false; }
            }
            return true;
        }
        return item == null || item instanceof Lang.String || item instanceof Lang.Number ||
            item instanceof Lang.Long || item instanceof Lang.Float || item instanceof Lang.Double ||
            item instanceof Lang.Boolean;
    }

    function _copyTree(item) {
        if (item instanceof Lang.Dictionary) {
            var copiedDictionary = {};
            var keys = item.keys();
            for (var keyIndex = 0; keyIndex < keys.size(); keyIndex += 1) {
                var key = keys[keyIndex];
                copiedDictionary[key] = _copyTree(item[key]);
            }
            return copiedDictionary;
        }
        if (item instanceof Lang.Array) {
            var copiedArray = [];
            for (var itemIndex = 0; itemIndex < item.size(); itemIndex += 1) {
                copiedArray.add(_copyTree(item[itemIndex]));
            }
            return copiedArray;
        }
        return item;
    }

    function _validTick(tick) as Lang.Boolean {
        if (!(tick instanceof Lang.Dictionary)) { return false; }
        var uuid = tick["uuid"];
        return uuid instanceof Lang.String && uuid.length() > 0 && uuid.length() <= 256;
    }

    function _validEnvelope(envelope) as Lang.Boolean {
        if (!(envelope instanceof Lang.Dictionary) || !_validTree(envelope, 0)) { return false; }
        if (envelope["version"] != VERSION) { return false; }
        var queues = envelope["owners"];
        var legacy = envelope["unowned"];
        if (!(queues instanceof Lang.Dictionary) || !(legacy instanceof Lang.Array)) { return false; }
        var owners = queues.keys();
        for (var ownerIndex = 0; ownerIndex < owners.size(); ownerIndex += 1) {
            var owner = owners[ownerIndex];
            var ticks = queues[owner];
            if (!_validOwner(owner) || !(ticks instanceof Lang.Array)) { return false; }
            for (var tickIndex = 0; tickIndex < ticks.size(); tickIndex += 1) {
                if (!_validTick(ticks[tickIndex])) { return false; }
            }
        }
        return true;
    }

    // Old entries have no trustworthy owner. Old pairing wrote new tokens
    // before clearing the old queue, so current credentials cannot label them.
    // Unknown versions/corrupt storage are refused, never converted to empty.
    function load(stored) {
        if (stored == null) {
            return { "version" => VERSION, "owners" => {}, "unowned" => [] };
        }
        if (stored instanceof Lang.Array && _validTree(stored, 1)) {
            return { "version" => VERSION, "owners" => {}, "unowned" => _copyTree(stored) };
        }
        return _validEnvelope(stored) ? _copyTree(stored) : null;
    }

    function forOwner(envelope, owner) as Lang.Array {
        if (!_validEnvelope(envelope) || !_validOwner(owner)) { return []; }
        var queues = envelope["owners"];
        var ticks = queues[owner];
        return ticks instanceof Lang.Array ? _copyTree(ticks) : [];
    }

    function ownedCount(envelope) as Lang.Number {
        if (!_validEnvelope(envelope)) { return 0; }
        var queues = envelope["owners"];
        var owners = queues.keys();
        var count = 0;
        for (var ownerIndex = 0; ownerIndex < owners.size(); ownerIndex += 1) {
            count += queues[owners[ownerIndex]].size();
        }
        return count;
    }

    function append(envelope, owner, tick, capacity as Lang.Number) {
        if (!_validEnvelope(envelope) || !_validOwner(owner) || !_validTick(tick) || !_validTree(tick, 3)) {
            return null;
        }
        var existing = forOwner(envelope, owner);
        for (var tickIndex = 0; tickIndex < existing.size(); tickIndex += 1) {
            if (existing[tickIndex]["uuid"].equals(tick["uuid"])) { return _copyTree(envelope); }
        }
        // Quarantined legacy data is retained separately. The live owner
        // partitions share one bound, so repeated account switches stay bounded.
        if (capacity < 1 || ownedCount(envelope) >= capacity) { return null; }
        var next = _copyTree(envelope);
        existing.add(_copyTree(tick));
        next["owners"][owner] = existing;
        return next;
    }

    function acknowledge(envelope, owner, uuid) {
        if (!_validEnvelope(envelope) || !_validOwner(owner) || !(uuid instanceof Lang.String)) { return null; }
        var next = _copyTree(envelope);
        var pending = forOwner(envelope, owner);
        var remaining = [];
        for (var tickIndex = 0; tickIndex < pending.size(); tickIndex += 1) {
            if (!pending[tickIndex]["uuid"].equals(uuid)) { remaining.add(pending[tickIndex]); }
        }
        if (remaining.size() == 0) {
            next["owners"].remove(owner);
        } else {
            next["owners"][owner] = remaining;
        }
        return next;
    }
}
