using Toybox.Time;
using Toybox.Time.Gregorian;
using Toybox.Lang;

module TimeUtil {

    // Current UTC time as an ISO-8601 string, e.g. "2026-07-05T14:03:09Z".
    //
    // VERIFY: the exact format string / that Gregorian.utcInfo(moment,
    // Time.FORMAT_SHORT) yields NUMERIC month/day/hour/min/sec fields (FORMAT_LONG
    // would give localized month strings). The backend expects an ISO-8601
    // instant for SaveTickInput.climbedAt.
    function nowIso() as Lang.String {
        var info = Gregorian.utcInfo(Time.now(), Time.FORMAT_SHORT);
        return Lang.format("$1$-$2$-$3$T$4$:$5$:$6$Z", [
            info.year.format("%04d"),
            info.month.format("%02d"),
            info.day.format("%02d"),
            info.hour.format("%02d"),
            info.min.format("%02d"),
            info.sec.format("%02d")
        ]);
    }
}
