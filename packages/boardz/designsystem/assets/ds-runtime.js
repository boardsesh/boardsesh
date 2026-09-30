/* Boardz runtime: resolves the compiled DS bundle namespace, or compiles components from source as a fallback.
   Usage: <script src="assets/ds-runtime.js"></script> then BoardzReady.then(ns => { const { Button } = ns; ... }) */
(function () {
  var FILES = ["components/core/Icon.jsx","components/core/Button.jsx","components/core/IconButton.jsx","components/core/Badge.jsx","components/core/Chip.jsx","components/core/Card.jsx","components/core/Avatar.jsx","components/forms/TextField.jsx","components/forms/Select.jsx","components/forms/Checkbox.jsx","components/forms/Radio.jsx","components/forms/Switch.jsx","components/forms/SegmentedControl.jsx","components/forms/Stepper.jsx","components/navigation/Tabs.jsx","components/navigation/TabBar.jsx","components/navigation/NavItem.jsx","components/feedback/Toast.jsx","components/feedback/Tooltip.jsx","components/feedback/Sheet.jsx","components/climbing/GradeBadge.jsx","components/climbing/StarRating.jsx","components/climbing/HoldMarker.jsx","components/climbing/BoardView.jsx","components/climbing/ProblemRow.jsx","components/climbing/ConnectionPill.jsx","components/climbing/StatTile.jsx","components/climbing/VideoThumb.jsx"];
  var me = document.currentScript && document.currentScript.src;
  var root = me ? me.replace(/assets\/ds-runtime\.js.*$/, '') : './';
  function findNs() {
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      try { var v = window[keys[i]]; if (v && typeof v === 'object' && v.BoardView && v.Button && v.ProblemRow) return v; } catch (e) {}
    }
    return null;
  }
  window.BoardzReady = (async function () {
    var ns = findNs();
    if (ns) { window.Boardz = ns; return ns; }
    var srcs = await Promise.all(FILES.map(function (f) { return fetch(root + f).then(function (r) { return r.text(); }); }));
    var joined = srcs.join('\n');
    var names = []; var re = /^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm; var m;
    while ((m = re.exec(joined))) if (names.indexOf(m[1]) < 0) names.push(m[1]);
    var code = srcs.map(function (s) { return s.replace(/^\s*import[^\n]*$/gm, '').replace(/^export\s+(function|const)/gm, '$1'); }).join('\n');
    var out = Babel.transform(code, { presets: ['react'] }).code;
    ns = new Function('React', out + '\nreturn {' + names.join(',') + '};')(window.React);
    window.Boardz = ns; return ns;
  })();
})();
