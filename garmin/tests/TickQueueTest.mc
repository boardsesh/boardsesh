using Toybox.Test;
using Toybox.Lang;

// Tests for the PURE bounded-FIFO math (TickQueue.boundedAppend). The
// Storage-backed wrappers (enqueue/popFront/peekFront) are thin adapters over
// this and aren't unit-tested here (they need Application.Storage).

(:test)
function testBoundedAppendGrows(logger as Test.Logger) as Lang.Boolean {
    var q = TickQueue.boundedAppend([], "a", 3);
    Test.assertEqual(q.size(), 1);
    Test.assertEqual(q[0], "a");

    q = TickQueue.boundedAppend(q, "b", 3);
    q = TickQueue.boundedAppend(q, "c", 3);
    Test.assertEqual(q.size(), 3);
    Test.assertEqual(q[0], "a");
    Test.assertEqual(q[2], "c");
    return true;
}

(:test)
function testBoundedAppendDropsOldest(logger as Test.Logger) as Lang.Boolean {
    var q = TickQueue.boundedAppend([], "a", 3);
    q = TickQueue.boundedAppend(q, "b", 3);
    q = TickQueue.boundedAppend(q, "c", 3);
    q = TickQueue.boundedAppend(q, "d", 3);   // over cap -> drop "a"

    Test.assertEqual(q.size(), 3);
    Test.assertEqual(q[0], "b");   // oldest survivor
    Test.assertEqual(q[1], "c");
    Test.assertEqual(q[2], "d");   // newest
    return true;
}

(:test)
function testBoundedAppendNullList(logger as Test.Logger) as Lang.Boolean {
    var q = TickQueue.boundedAppend(null, "x", 2);
    Test.assertEqual(q.size(), 1);
    Test.assertEqual(q[0], "x");
    return true;
}

(:test)
function testBoundedAppendDoesNotMutateInput(logger as Test.Logger) as Lang.Boolean {
    var original = TickQueue.boundedAppend([], "a", 3);
    var derived = TickQueue.boundedAppend(original, "b", 3);
    // original must be untouched (boundedAppend returns a new array).
    Test.assertEqual(original.size(), 1);
    Test.assertEqual(derived.size(), 2);
    return true;
}
