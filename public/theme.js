// Light or dark, set before the page draws so it never flashes the wrong one.
// The choice is kept on this device; until one is made, the device's own setting is followed.
(function () {
  var KEY = 'hub-theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function choice() {
    try { var c = localStorage.getItem(KEY); return c === 'light' || c === 'dark' ? c : 'system'; } catch (e) { return 'system'; }
  }
  function apply() {
    var c = choice();
    var dark = c === 'dark' || (c === 'system' && !!media && media.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    // The browser's or installed app's bar matches the top of the hub: blue, or green for Promtek Africa.
    var sa = document.documentElement.classList.contains('theme-sa');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? (sa ? '#1e3814' : '#0a486c') : (sa ? '#2A4D1B' : '#0E6293'));
  }
  window.hubTheme = {
    choice: choice,
    refresh: apply,
    dark: function () { return document.documentElement.getAttribute('data-theme') === 'dark'; },
    set: function (c) {
      try { if (c === 'light' || c === 'dark') localStorage.setItem(KEY, c); else localStorage.removeItem(KEY); } catch (e) { /* this time only */ }
      apply();
    },
  };
  if (media) { if (media.addEventListener) media.addEventListener('change', apply); else if (media.addListener) media.addListener(apply); }
  apply();
})();
