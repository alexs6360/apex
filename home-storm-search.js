/* Storm history teaser search on the homepage.
   Hands off to the full lookup tool rather than duplicating it: picking a
   suggestion (or submitting the typed address) sends the reader to
   /storm-history with ?address=, which geocodes it, runs the lookup, and
   scrolls to the results itself on load — see prefillFromQuery() in
   storm-history.js. No token scoping or geocoding happens here beyond what
   the autocomplete needs to show suggestions, and no lead is recorded from
   this page — the storm-history page is the one place that happens, after
   its own privacy disclosure, so an address is never captured twice. */
(function () {
  "use strict";

  /* Same substitution as storm-history.js — see tools/deploy.sh. */
  var MAPBOX_TOKEN = "__MAPBOX_TOKEN__";

  var form = document.getElementById("storm-check-form");
  if (!form) return;

  var input = document.getElementById("storm-check-address");
  var listEl = document.getElementById("storm-check-suggest");

  function goToStormHistory(address) {
    window.location.href = "/storm-history?address=" + encodeURIComponent(address);
  }

  var hasToken = MAPBOX_TOKEN && MAPBOX_TOKEN.indexOf("__MAPBOX") !== 0;

  if (hasToken && window.AddressAutocomplete) {
    window.AddressAutocomplete.attach({
      input: input,
      listEl: listEl,
      token: MAPBOX_TOKEN,
      minChars: 3,
      debounceMs: 300,
      idPrefix: "home-storm",
      onChoose: function (item, typed) {
        goToStormHistory(typed);
      },
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var address = (input.value || "").trim();
    if (!address) return;
    goToStormHistory(address);
  });
})();
