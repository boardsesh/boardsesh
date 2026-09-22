using Toybox.Time;
using Toybox.Time.Gregorian;
using Toybox.Lang;

module TimeUtil {

    // Unsigned elapsed milliseconds across the signed uptime rollover.
    // Supports intervals shorter than one full counter period (~50 days).
    function elapsedTimerMs(startMs as Lang.Number, nowMs as Lang.Number) as Lang.Long {
        return (nowMs.toLong() - startMs.toLong()) & 0xffffffffl;
    }

    // Current UTC time as an ISO-8601 string, e.g. "2026-07-05T14:03:09Z".
    //
    // Gregorian.utcInfo with FORMAT_SHORT yields numeric fields. The backend
    // expects an ISO-8601 instant for SaveTickInput.climbedAt.
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
