using Toybox.Test;
using Toybox.Lang;

(:test)
function testElapsedTimerSignedRollover(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(TimeUtil.elapsedTimerMs(2147483547, -2147483549), 200l);
    Test.assertEqual(TimeUtil.elapsedTimerMs(-100, 100), 200l);
    Test.assertEqual(TimeUtil.elapsedTimerMs(100, 700), 600l);
    return true;
}

(:test)
function testElapsedTimerLongInterval(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(TimeUtil.elapsedTimerMs(0, -2147483647), 2147483649l);
    return true;
}
