using Toybox.Test;
using Toybox.Lang;

// Tests for the per-session climb log: attempt counting, flash eligibility,
// send/aggregate tracking, reset, and null-uuid safety. SessionLog is a
// process-wide singleton, so each test resets it first for isolation.

(:test)
function testFlashEligibleWhenUntouched(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    Test.assertEqual(SessionLog.isFlashEligible("c1"), true);
    Test.assertEqual(SessionLog.attemptsFor("c1"), 0);
    Test.assertEqual(SessionLog.isSent("c1"), false);
    return true;
}

(:test)
function testAttemptsIncrementPerClimb(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    SessionLog.incAttempt("c1");
    SessionLog.incAttempt("c1");
    SessionLog.incAttempt("c2");
    Test.assertEqual(SessionLog.attemptsFor("c1"), 2);
    Test.assertEqual(SessionLog.attemptsFor("c2"), 1);
    // Attempts make a climb no longer flash-eligible.
    Test.assertEqual(SessionLog.isFlashEligible("c1"), false);
    // Aggregates.
    Test.assertEqual(SessionLog.attempts(), 3);
    Test.assertEqual(SessionLog.problems(), 2);
    Test.assertEqual(SessionLog.sends(), 0);
    return true;
}

(:test)
function testMarkSendAndFlash(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    // A first-go send is a flash.
    SessionLog.markSend("c1", true, "V5");
    Test.assertEqual(SessionLog.isSent("c1"), true);
    Test.assertEqual(SessionLog.isFlash("c1"), true);
    Test.assertEqual(SessionLog.sends(), 1);
    Test.assertEqual(SessionLog.lastSendGrade(), "V5");
    // Already sent -> no longer flash-eligible.
    Test.assertEqual(SessionLog.isFlashEligible("c1"), false);
    return true;
}

(:test)
function testSendAfterAttemptsIsNotFlash(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    SessionLog.incAttempt("c1");
    SessionLog.incAttempt("c1");
    Test.assertEqual(SessionLog.isFlashEligible("c1"), false);
    SessionLog.markSend("c1", false, "V6");
    Test.assertEqual(SessionLog.isSent("c1"), true);
    Test.assertEqual(SessionLog.isFlash("c1"), false);
    // A climb's send is counted once, even if START is pressed again.
    SessionLog.markSend("c1", false, "V6");
    Test.assertEqual(SessionLog.sends(), 1);
    // Two attempts + this climb is still one problem.
    Test.assertEqual(SessionLog.problems(), 1);
    return true;
}

(:test)
function testResetClears(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    SessionLog.incAttempt("c1");
    SessionLog.markSend("c2", true, "V3");
    SessionLog.reset();
    Test.assertEqual(SessionLog.attempts(), 0);
    Test.assertEqual(SessionLog.sends(), 0);
    Test.assertEqual(SessionLog.problems(), 0);
    Test.assertEqual(SessionLog.attemptsFor("c1"), 0);
    Test.assertEqual(SessionLog.isSent("c2"), false);
    Test.assert(SessionLog.lastSendGrade() == null);
    return true;
}

(:test)
function testNullUuidSafe(logger as Test.Logger) as Lang.Boolean {
    SessionLog.reset();
    SessionLog.incAttempt(null);
    SessionLog.markSend(null, true, "V1");
    Test.assertEqual(SessionLog.attemptsFor(null), 0);
    Test.assertEqual(SessionLog.isSent(null), false);
    Test.assertEqual(SessionLog.isFlashEligible(null), false);
    Test.assertEqual(SessionLog.problems(), 0);
    return true;
}
