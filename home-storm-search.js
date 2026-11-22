/* Storm radar teaser on the homepage.

   Used to hand off to /storm-history the moment an address was chosen —
   now it runs the lookup in place and draws a live radar: one dot per
   distinct coordinate from the last five years, centered on the searched
   address. Position math (kmFrame) and event matching (eventsAt,
   groupByDate, bucketOf) are shared with storm-history.js via storm-grid.js
   and storm-events.js — nothing here re-derives either. Still no lead is
   recorded from this page: that stays storm-history.js's job, after its
   own privacy disclosure, so an address is never captured twice. "Browse
   the full storm map" still hands off to the ten-year tool. */
(function () {
  "use strict";

  /* Same substitution as storm-history.js — see tools/deploy.sh. */
  var MAPBOX_TOKEN = "__MAPBOX_TOKEN__";

  function hasToken() {
    return MAPBOX_TOKEN && MAPBOX_TOKEN.indexOf("__MAPBOX") !== 0;
  }

  var form = document.getElementById("storm-check-form");
  if (!form) return;

  var input = document.getElementById("storm-check-address");
  var listEl = document.getElementById("storm-check-suggest");
  var errorEl = document.getElementById("storm-check-error");

  var placeholderEl = document.getElementById("storm-check-placeholder");
  var radarEl = document.getElementById("storm-radar");
  var countEl = document.getElementById("storm-radar-count");
  var panelEl = document.getElementById("storm-radar-panel");
  var dotsG = document.getElementById("storm-radar-dots");
  var radarListEl = document.getElementById("storm-radar-list");
  var calloutEl = document.getElementById("storm-radar-callout");
  var calloutDateEl = document.getElementById("storm-radar-callout-date");
  var calloutLabelEl = document.getElementById("storm-radar-callout-label");

  if (!radarEl || !dotsG || !radarListEl) return;

  var AREA = (window.AddressAutocomplete && window.AddressAutocomplete.AREA) ||
    { minLon: -90.8, minLat: 34.4, maxLon: -89.0, maxLat: 35.6 };
  var MEMPHIS = (window.AddressAutocomplete && window.AddressAutocomplete.MEMPHIS) || [-90.0490, 35.1495];

  var YEARS_BACK = 5;
  var REPORT_RADIUS_KM = (window.StormEvents && window.StormEvents.REPORT_RADIUS_KM) || 5;

  /* Panel geometry — matches the SVG viewBox/ring radius in index.html.
     PANEL_R_SVG is what REPORT_RADIUS_KM is drawn at, so a dot's distance
     from center in km converts straight to viewBox units. */
  var PANEL_R_SVG = 55;
  var SCALE = PANEL_R_SVG / REPORT_RADIUS_KM;
  /* How far a co-located stack's members spread out once opened, in the
     same viewBox units — small enough to stay inside the ring, large
     enough to read as separate dots rather than a thicker one. */
  var FAN_R = 9;

  /* Entrance timing — approved before this was built. Total envelope is
     measured from the section's own appearance (t=0), not from when dots
     start, so dots only get what's left after the container and the
     answer (count + list) have landed. The container's own 220ms fade
     lives only in CSS (.storm-radar's transition) since it needs no JS
     coordination — it starts at delay 0 and nothing downstream waits on
     it finishing. */
  var LIST_DELAY_MS = 80;
  var LIST_MS = 220;
  var DOTS_START_MS = LIST_DELAY_MS + LIST_MS; // 300
  var TOTAL_BUDGET_MS = 2450;
  var DOT_DURATION_MS = 280;
  var MAX_STAGGER_MS = 90;

  var reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function say(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  function inServiceArea(lon, lat) {
    return lon >= AREA.minLon && lon <= AREA.maxLon && lat >= AREA.minLat && lat <= AREA.maxLat;
  }

  /* ---- data -------------------------------------------------------------- */

  var hail = null;
  var reports = null;
  var warnings = null;
  var dataPromise = null;

  function loadData() {
    if (dataPromise) return dataPromise;
    dataPromise = fetch("/data/storm-index.json")
      .then(function (r) { return r.json(); })
      .then(function (idx) {
        var jobs = [];
        idx.years.forEach(function (y) {
          jobs.push(fetch("/data/hail-" + y + ".json").then(function (r) { return r.json(); }));
          jobs.push(fetch("/data/reports-" + y + ".json").then(function (r) { return r.json(); }));
        });
        var warningsJob = fetch("/data/warnings.json")
          .then(function (r) { return r.ok ? r.json() : []; })
          .catch(function () { return []; });
        return Promise.all([warningsJob, Promise.all(jobs)]);
      })
      .then(function (results) {
        warnings = results[0];
        var parts = results[1];
        var cells = [];
        var reps = [];
        parts.forEach(function (p) {
          if (p.cells) cells = cells.concat(p.cells);
          if (p.reports) reps = reps.concat(p.reports);
        });
        hail = { cells: cells };
        reports = {
          features: reps.map(function (r) {
            return {
              type: "Feature",
              geometry: { type: "Point", coordinates: [r[3], r[4]] },
              properties: { date: r[0], kind: r[1], val: r[2], src: r[5] },
            };
          }),
        };
      });
    return dataPromise;
  }

  /* ---- geocoding ----------------------------------------------------------
     Same two paths storm-history.js uses: a Searchbox /retrieve when a
     suggestion was picked, a Geocoding v6 /forward when the reader typed
     the whole thing and hit enter. */

  var ac = window.AddressAutocomplete && hasToken() && window.AddressAutocomplete.attach({
    input: input,
    listEl: listEl,
    token: MAPBOX_TOKEN,
    minChars: 3,
    debounceMs: 300,
    idPrefix: "home-storm",
    onChoose: function (item, typed, self) {
      say("");
      form.classList.add("is-busy");
      var url =
        "https://api.mapbox.com/search/searchbox/v1/retrieve/" +
        encodeURIComponent(item.mapbox_id) +
        "?session_token=" + encodeURIComponent(self.sessionToken()) +
        "&access_token=" + MAPBOX_TOKEN;

      loadData()
        .then(function () { return fetch(url); })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var f = data && data.features && data.features[0];
          if (!f) { say("We couldn't place that address. Call us and we'll look it up."); return; }
          var c = f.geometry.coordinates;
          runSearch(c[0], c[1], typed);
        })
        .catch(function () {
          say("Something went wrong looking that up. Call us and we'll check it for you.");
        })
        .then(function () {
          form.classList.remove("is-busy");
          self.resetSession();
        });
    },
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (ac && ac.hasActive()) { ac.chooseActive(); return; }

    var address = (input.value || "").trim();
    if (!address) return;
    say("");
    if (ac) ac.close();

    if (!hasToken()) {
      say("Address lookup is not configured yet. Call us and we'll check it for you.");
      return;
    }

    var url =
      "https://api.mapbox.com/search/geocode/v6/forward?q=" + encodeURIComponent(address) +
      "&country=us&types=address&limit=1&autocomplete=false" +
      "&proximity=" + MEMPHIS.join(",") +
      "&access_token=" + MAPBOX_TOKEN;

    form.classList.add("is-busy");
    loadData()
      .then(function () { return fetch(url); })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var f = data && data.features && data.features[0];
        if (!f) {
          say("We couldn't find that address. Check the spelling, or call us and we'll look it up.");
          return;
        }
        var c = f.properties.coordinates;
        runSearch(c.longitude, c.latitude, f.properties.full_address || f.properties.name || address);
      })
      .catch(function () {
        say("Something went wrong looking that up. Call us and we'll check it for you.");
      })
      .then(function () {
        form.classList.remove("is-busy");
      });
  });

  /* ---- search → render ---------------------------------------------------- */

  function runSearch(lon, lat, label) {
    if (!window.StormEvents || !window.StormGrid) {
      say("Something didn't load on this page. Refresh, or call us and we'll check the address for you.");
      return;
    }
    if (!inServiceArea(lon, lat)) {
      say("That address is outside our coverage area, so we don't have storm history for it. " +
          "We cover the Memphis metro — call us and we'll tell you whether we can still help.");
      return;
    }

    var addrBucket = window.StormEvents.bucketOf(lat, lon);
    var allEvents = window.StormEvents.eventsAt(lon, lat, addrBucket, hail, reports, warnings, REPORT_RADIUS_KM);

    var cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - YEARS_BACK);
    var cutoffIso = cutoff.toISOString().slice(0, 10);
    var recent = allEvents.filter(function (e) { return e.date >= cutoffIso; });

    var rows = window.StormEvents.groupByDate(recent);
    rows.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    rows.forEach(function (r, i) { r.id = "r" + i; });

    render(rows, lon, lat);
  }

  /* ---- rendering ----------------------------------------------------------- */

  var stacks = null;     // stackKeyFor(row) -> { el, members: [row, ...] }
  var openStackKey = null;

  function stackKeyFor(row) {
    if (row.here) return "HERE";
    if (row.lon == null || row.lat == null) return "HERE"; // warnings carry the address itself
    return row.lon.toFixed(4) + "," + row.lat.toFixed(4);
  }

  function render(rows, lon, lat) {
    _rowsCache = rows;
    if (placeholderEl) placeholderEl.hidden = true;
    radarEl.hidden = false;

    var fromYear = new Date().getUTCFullYear() - YEARS_BACK;
    countEl.textContent = rows.length
      ? rows.length + (rows.length === 1 ? " storm" : " storms") + " since " + fromYear
      : "No recorded storms since " + fromYear;

    renderList(rows);
    renderDots(lon, lat, rows);

    if (rows.length) selectRow(rows[0].id);
  }

  function renderList(rows) {
    radarListEl.innerHTML = "";
    rows.forEach(function (row) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "storm-radar-row";
      btn.dataset.id = row.id;

      var d = document.createElement("span");
      d.className = "storm-radar-row-date";
      d.textContent = window.StormEvents.prettyDate(row.date);
      var v = document.createElement("span");
      v.className = "storm-radar-row-label";
      v.textContent = row.label;
      btn.appendChild(d);
      btn.appendChild(v);
      btn.addEventListener("click", function () { selectRow(row.id); });

      li.appendChild(btn);
      radarListEl.appendChild(li);
    });
  }

  function svgEl(tag) {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  /* kmFrame's fwd() returns [eastKm, northKm]; SVG y grows downward, so the
     panel's y is the negated north component. "Here" events land exactly on
     (0,0) — the address IS the center, never offset — same honesty
     constraint that keeps every other dot's own cell center un-jittered. */
  function project(row, frame) {
    if (row.here || row.lon == null || row.lat == null) return [0, 0];
    var km = frame.fwd([row.lon, row.lat]);
    var dist = Math.hypot(km[0], km[1]);
    if (dist > REPORT_RADIUS_KM) {
      var k = REPORT_RADIUS_KM / dist;
      km[0] *= k; km[1] *= k;
    }
    return [km[0] * SCALE, -km[1] * SCALE];
  }

  function renderDots(lon, lat, rows) {
    dotsG.innerHTML = "";
    stacks = {};

    var frame = window.StormGrid.kmFrame(lon, lat);
    var order = []; // stack keys in first-occurrence (newest-first) order

    rows.forEach(function (row) {
      var key = stackKeyFor(row);
      if (!stacks[key]) {
        stacks[key] = { members: [] };
        order.push(key);
      }
      stacks[key].members.push(row);
    });

    order.forEach(function (key) {
      var stack = stacks[key];
      var pos = project(stack.members[0], frame);
      var g = svgEl("g");
      g.setAttribute("class", "storm-dot-stack");
      g.setAttribute("transform", "translate(" + pos[0].toFixed(2) + "," + pos[1].toFixed(2) + ")");
      stack.el = g;

      if (stack.members.length > 1) {
        var badge = svgEl("g");
        badge.setAttribute("class", "storm-dot-badge");
        var ring = svgEl("circle");
        ring.setAttribute("class", "storm-dot-ring");
        ring.setAttribute("r", "5.5");
        var count = svgEl("text");
        count.setAttribute("class", "storm-dot-count");
        count.setAttribute("x", "9");
        count.setAttribute("y", "-7");
        count.textContent = String(stack.members.length);
        badge.appendChild(ring);
        badge.appendChild(count);
        g.appendChild(badge);
      }

      stack.members.forEach(function (row) {
        var group = svgEl("g");
        group.setAttribute("class", "storm-dot-group");
        if (!reducedMotion) group.classList.add("is-entering");
        group.dataset.id = row.id;

        var halo = svgEl("circle");
        halo.setAttribute("class", "storm-dot-halo");
        halo.setAttribute("r", "3");
        var core = svgEl("circle");
        core.setAttribute("class", "storm-dot-core");
        core.setAttribute("r", "3");

        group.appendChild(halo);
        group.appendChild(core);
        group.addEventListener("click", function () { selectRow(row.id); });

        g.appendChild(group);
        row._groupEl = group;
        row._stackKey = key;
      });

      dotsG.appendChild(g);
    });

    scheduleEntrance(order);
  }

  /* Cap-not-scale stagger, approved before this was built: dots only get
     the budget left after the container and the answer (count + list) have
     already landed, so the WHOLE sequence — not just the dots — finishes
     inside TOTAL_BUDGET_MS. Falls back to the full, uncompressed
     MAX_STAGGER_MS whenever N is small enough that doing so still fits. */
  function scheduleEntrance(order) {
    if (reducedMotion) return;

    radarEl.classList.add("is-entering");
    countEl.classList.add("is-entering");
    radarListEl.classList.add("is-entering");
    requestAnimationFrame(function () {
      radarEl.classList.remove("is-entering");
      countEl.classList.remove("is-entering");
      radarListEl.classList.remove("is-entering");
    });

    var n = order.reduce(function (sum, key) { return sum + stacks[key].members.length; }, 0);
    if (!n) return;

    var remaining = TOTAL_BUDGET_MS - DOTS_START_MS;
    var naive = (n - 1) * MAX_STAGGER_MS + DOT_DURATION_MS;
    var stagger = naive <= remaining ? MAX_STAGGER_MS : (remaining - DOT_DURATION_MS) / Math.max(n - 1, 1);

    var i = 0;
    order.forEach(function (key) {
      stacks[key].members.forEach(function (row) {
        var delay = DOTS_START_MS + i * stagger;
        row._groupEl.style.transitionDelay = delay.toFixed(0) + "ms";
        i++;
      });
    });

    requestAnimationFrame(function () {
      order.forEach(function (key) {
        stacks[key].members.forEach(function (row) {
          row._groupEl.classList.remove("is-entering");
        });
      });
    });
  }

  /* ---- selection ------------------------------------------------------- */

  function closeOpenStack() {
    if (!openStackKey || !stacks[openStackKey]) { openStackKey = null; return; }
    var stack = stacks[openStackKey];
    stack.el.classList.remove("is-open");
    stack.members.forEach(function (row) {
      row._groupEl.style.removeProperty("--fx");
      row._groupEl.style.removeProperty("--fy");
    });
    openStackKey = null;
  }

  function openStack(key) {
    var stack = stacks[key];
    if (!stack || stack.members.length < 2) return;
    stack.el.classList.add("is-open");
    var n = stack.members.length;
    stack.members.forEach(function (row, i) {
      var angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      row._groupEl.style.setProperty("--fx", (Math.cos(angle) * FAN_R).toFixed(2) + "px");
      row._groupEl.style.setProperty("--fy", (Math.sin(angle) * FAN_R).toFixed(2) + "px");
    });
    openStackKey = key;
  }

  function selectRow(id) {
    var rows = Array.prototype.slice.call(radarListEl.querySelectorAll(".storm-radar-row"));
    rows.forEach(function (b) { b.classList.toggle("is-selected", b.dataset.id === id); });

    var allGroups = Array.prototype.slice.call(dotsG.querySelectorAll(".storm-dot-group"));
    var selectedGroup = null;
    allGroups.forEach(function (g) {
      var on = g.dataset.id === id;
      g.classList.toggle("is-selected", on);
      if (on) selectedGroup = g;
    });
    if (!selectedGroup) return;

    var selectedRow = findRowById(id);
    var key = selectedRow ? selectedRow._stackKey : null;

    if (key !== openStackKey) closeOpenStack();
    if (key && stacks[key] && stacks[key].members.length > 1) openStack(key);

    /* Raise the whole stack to the end of #storm-radar-dots so the
       selected dot (and its fanned siblings, if any) paint above every
       other stack on the panel — never hidden under a neighbour. */
    if (key && stacks[key]) dotsG.appendChild(stacks[key].el);

    positionCallout(id, selectedGroup);
  }

  function positionCallout(id, groupEl) {
    var row = findRowById(id);
    if (!row || !calloutEl) return;
    calloutDateEl.textContent = window.StormEvents.prettyDate(row.date);
    calloutLabelEl.textContent = row.label;

    /* The panel is a 120x120 viewBox; translate the dot's own transform
       (stack position) plus its current fan offset into the same 0-100%
       space the callout's absolutely-positioned box sits in. */
    var stackTransform = groupEl.closest(".storm-dot-stack").getAttribute("transform");
    var m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(stackTransform || "");
    var baseX = m ? parseFloat(m[1]) : 0;
    var baseY = m ? parseFloat(m[2]) : 0;
    var fx = parseFloat(getComputedStyle(groupEl).getPropertyValue("--fx")) || 0;
    var fy = parseFloat(getComputedStyle(groupEl).getPropertyValue("--fy")) || 0;

    var x = baseX + fx;
    var y = baseY + fy;
    var leftPct = ((x + 60) / 120) * 100;
    var topPct = ((y + 60) / 120) * 100;

    calloutEl.style.left = leftPct + "%";
    calloutEl.style.top = topPct + "%";
    calloutEl.style.removeProperty("--clampx");
    calloutEl.classList.remove("storm-radar-callout--below");
    calloutEl.hidden = false;

    /* The box is centered and sits above the point by default, which
       overflows the panel — into the count line above, or past either
       side — whenever the selected dot is near that edge of the circle.
       Measured and nudged back inside after layout rather than guessed in
       advance, since the overflow depends on the callout's own rendered
       size (the label text varies) as much as the dot's position. */
    var panelBox = panelEl.getBoundingClientRect();
    var calloutBox = calloutEl.getBoundingClientRect();
    if (calloutBox.top < panelBox.top) {
      calloutEl.classList.add("storm-radar-callout--below");
      calloutBox = calloutEl.getBoundingClientRect();
    }
    var dx = 0;
    if (calloutBox.left < panelBox.left) dx = panelBox.left - calloutBox.left;
    else if (calloutBox.right > panelBox.right) dx = panelBox.right - calloutBox.right;
    if (dx) calloutEl.style.setProperty("--clampx", dx + "px");
  }

  var _rowsCache = [];
  function findRowById(id) {
    for (var i = 0; i < _rowsCache.length; i++) {
      if (_rowsCache[i].id === id) return _rowsCache[i];
    }
    return null;
  }
})();
