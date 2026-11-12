using Toybox.Application;
using Toybox.Lang;

// One SDK write per envelope. Callers handle every exception and publish only
// after success; this does not promise power-loss atomicity across keys.
class WatchObjectStore {
    function initialize() {}
    function read(key as Lang.String) { return Application.Storage.getValue(key); }
    function write(key as Lang.String, contents) as Void { Application.Storage.setValue(key, contents); }
}
module WatchStore {
    var backend = new WatchObjectStore();
    function read(key as Lang.String) { return backend.read(key); }
    function write(key as Lang.String, contents) as Void { backend.write(key, contents); }
}
