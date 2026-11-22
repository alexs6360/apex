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
  var dotsG = document.getElementById("storm-radar-dots");
  var radarListEl = document.getElementById("storm-radar-list");
  var backdropEl = document.getElementById("storm-radar-backdrop");

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
     same viewBox units. Fixed at 9 units originally clears a 4-member fan
     against the ignite halo's full 11-unit reach (spacing 12.7) but not a
     7-member one (spacing 7.8) — full clearance at 7 would need ~12.7
     units, over a kilometre of apparent displacement on this 5km panel,
     which misrepresents the data worse than a little overlap would.
     Scaled modestly instead (9-11 units) and paired with a SEPARATE,
     smaller halo reach specifically for fanned members (see
     stormDotPulseFanned in styles.css) — between the two, every member
     count through at least 7 clears with margin to spare; see the
     comment on openStack() below for the actual numbers. */
  function fanRadiusFor(n) {
    if (n <= 4) return 9;
    if (n >= 7) return 11;
    return 9 + (n - 4) * (2 / 3);
  }

  /* The fan exists to make co-located dots individually clickable. Past
     this many members the ring runs out of circumference no matter the
     radius — the real archive has grid cells with up to 18 distinct
     storm dates, and 8 is where the ring still comfortably works, not
     where it merely survives (checked against bare dot-core overlap, not
     just the halo). Past it, the dot stays a single point carrying a
     prominent count; which specific date is selected becomes the list's
     job, not the map's — see renderList's group-row handling below. */
  var LARGE_STACK_THRESHOLD = 8;

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

      fetch(url)
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
    fetch(url)
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

    /* Fired here, not awaited: the backdrop is a separate request on a
       separate failure path from the data this page actually needs to
       answer the question. It must never gate or slow the count, the
       list, or the dot entrance — see loadBackdrop's own comment for the
       fallback it degrades to. */
    loadBackdrop(lon, lat);

    loadData().then(function () {
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
    });
  }

  /* ---- backdrop ------------------------------------------------------------
     A real Mapbox Static Images API export (dark-v11 — the Standard style
     GL JS uses on storm-history.html isn't supported by this API), bbox'd
     to the exact same ±REPORT_RADIUS_KM square the dots are projected
     into via kmFrame, so the two agree without any separate projection
     math. One request per search, square (the circular crop in CSS takes
     care of the rest), @2x for retina.

     Entirely independent of the data path above: no render() call waits
     on this, and its own fade-in (CSS, triggered on the <img>'s load
     event) runs on its own clock, whenever the network delivers it —
     before the dot entrance, mid-way through it, or well after. A 403, a
     timeout, a rate limit, or a plain network failure all land on
     the same onerror path, which does nothing: the backdrop <img> simply
     never gains .is-loaded and the panel stays exactly what it already
     was before this existed — rings and dots on the dark card. No broken-
     image icon (the element stays at opacity:0, never shown unstyled)
     and no error text (this failure is invisible to a visitor on
     purpose — the radar still answers the question without it). */
  var BACKDROP_SIZE = 200;
  var backdropSeq = 0;

  function loadBackdrop(lon, lat) {
    if (!backdropEl || !hasToken()) return;
    var seq = ++backdropSeq;
    backdropEl.classList.remove("is-loaded");

    var frame = window.StormGrid.kmFrame(lon, lat);
    var sw = frame.inv([-REPORT_RADIUS_KM, -REPORT_RADIUS_KM]);
    var ne = frame.inv([REPORT_RADIUS_KM, REPORT_RADIUS_KM]);
    var bbox = "[" + sw[0].toFixed(5) + "," + sw[1].toFixed(5) + "," +
      ne[0].toFixed(5) + "," + ne[1].toFixed(5) + "]";
    var url = "https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/" + bbox +
      "/" + BACKDROP_SIZE + "x" + BACKDROP_SIZE + "@2x?access_token=" + MAPBOX_TOKEN;

    backdropEl.onload = function () {
      /* A slow response from a superseded search landing after a newer
         one must not paint over the newer address's dots. */
      if (seq !== backdropSeq) return;
      backdropEl.classList.add("is-loaded");
    };
    backdropEl.onerror = function () { /* stays hidden — see comment above */ };
    backdropEl.src = url;
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

    var built = buildStacks(rows);
    var locations = built.order.length;

    /* States the count-vs-dots relationship up front rather than leaving
       it for a badge to explain after the fact — a visitor shouldn't have
       to reconcile "27 storms" against "12ish dots" by counting. Only
       said when they differ: a single-event-per-location address has
       nothing to reconcile, so the plain count stands on its own. */
    var fromYear = new Date().getUTCFullYear() - YEARS_BACK;
    if (!rows.length) {
      countEl.textContent = "No recorded storms since " + fromYear;
    } else if (locations === rows.length) {
      countEl.textContent = rows.length + (rows.length === 1 ? " storm" : " storms") + " since " + fromYear;
    } else {
      countEl.textContent = rows.length + " storms across " + locations +
        (locations === 1 ? " location" : " locations") + " since " + fromYear;
    }

    renderList(rows, built);
    renderDots(lon, lat, built);

    if (rows.length) selectRow(rows[0].id);
  }

  function rowButton(row, extraClass) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "storm-radar-row" + (extraClass ? " " + extraClass : "");
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
    return btn;
  }

  /* Past LARGE_STACK_THRESHOLD, the map dot stops distinguishing members
     (see renderDots) — this is where that distinction actually lives
     instead. One row for the whole location, collapsed by default,
     expanding to its own dates on click. Rendered at the position of its
     newest member (the first one reached walking rows newest-first), so
     the list's overall chronological order doesn't change for a visitor
     who never expands anything. */
  function renderGroupRow(stack) {
    var li = document.createElement("li");
    li.className = "storm-radar-group";

    var header = document.createElement("button");
    header.type = "button";
    header.className = "storm-radar-row storm-radar-row--group";
    var count = document.createElement("span");
    count.className = "storm-radar-row-date";
    count.textContent = stack.members.length + " storms at this location";
    var hint = document.createElement("span");
    hint.className = "storm-radar-row-label storm-radar-group-hint";
    hint.textContent = "Same spot, different dates — tap to see each one";
    header.appendChild(count);
    header.appendChild(hint);

    var sub = document.createElement("ol");
    sub.className = "storm-radar-sublist";
    stack.members.forEach(function (row) {
      var subLi = document.createElement("li");
      subLi.appendChild(rowButton(row, "storm-radar-row--sub"));
      sub.appendChild(subLi);
    });

    header.addEventListener("click", function () {
      li.classList.toggle("is-expanded");
    });

    li.appendChild(header);
    li.appendChild(sub);
    stack.groupEl = li;
    radarListEl.appendChild(li);
  }

  function renderList(rows, built) {
    radarListEl.innerHTML = "";
    var renderedGroup = {};

    rows.forEach(function (row) {
      var key = stackKeyFor(row);
      var stack = built.byKey[key];

      if (stack && stack.isLarge) {
        if (renderedGroup[key]) return;
        renderedGroup[key] = true;
        renderGroupRow(stack);
        return;
      }

      var li = document.createElement("li");
      li.appendChild(rowButton(row));
      radarListEl.appendChild(li);
    });

    updateListScrollState();
  }

  /* The list clips with no visible affordance otherwise — can-scroll shows
     the bottom-edge fade (CSS) only while there's actually more to see,
     is-at-bottom drops it once scrolled all the way down. Re-checked on
     every scroll and every re-render (row count changes per search). */
  function updateListScrollState() {
    var canScroll = radarListEl.scrollHeight > radarListEl.clientHeight + 1;
    radarListEl.classList.toggle("can-scroll", canScroll);
    var atBottom = radarListEl.scrollTop + radarListEl.clientHeight >= radarListEl.scrollHeight - 2;
    radarListEl.classList.toggle("is-at-bottom", atBottom);
  }

  radarListEl.addEventListener("scroll", updateListScrollState);

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

  /* Distinct coordinates, not events — the thing the headline restatement
     and the dot count both need before any SVG exists. Newest-first
     first-occurrence order, same as the dots themselves end up in. */
  function buildStacks(rows) {
    var byKey = {};
    var order = [];
    rows.forEach(function (row) {
      var key = stackKeyFor(row);
      if (!byKey[key]) {
        byKey[key] = { members: [] };
        order.push(key);
      }
      byKey[key].members.push(row);
    });
    order.forEach(function (key) {
      byKey[key].isLarge = byKey[key].members.length > LARGE_STACK_THRESHOLD;
    });
    return { byKey: byKey, order: order };
  }

  function renderDots(lon, lat, built) {
    dotsG.innerHTML = "";
    stacks = built.byKey;
    var order = built.order;

    var frame = window.StormGrid.kmFrame(lon, lat);

    order.forEach(function (key) {
      var stack = stacks[key];
      var pos = project(stack.members[0], frame);
      var g = svgEl("g");
      g.setAttribute("class", "storm-dot-stack");
      g.setAttribute("transform", "translate(" + pos[0].toFixed(2) + "," + pos[1].toFixed(2) + ")");
      stack.el = g;

      if (stack.members.length > 1) {
        var badge = svgEl("g");
        badge.setAttribute("class", "storm-dot-badge" + (stack.isLarge ? " storm-dot-badge--large" : ""));
        var ring = svgEl("circle");
        ring.setAttribute("class", "storm-dot-ring");
        var count = svgEl("text");
        count.setAttribute("class", "storm-dot-count");
        if (stack.isLarge) {
          /* Bigger ring, further-out count position (same offset
             direction as the small badge, just scaled so the number
             clears the larger ring) — "18 storms at this one spot" is
             the strongest fact this tool shows a homeowner, so this one
             is sized to read instantly, not matched to the small badge. */
          ring.setAttribute("r", "9");
          count.setAttribute("x", "14");
          count.setAttribute("y", "-11");
        } else {
          ring.setAttribute("r", "5.5");
          count.setAttribute("x", "9");
          count.setAttribute("y", "-7");
        }
        count.textContent = String(stack.members.length);
        badge.appendChild(ring);
        badge.appendChild(count);
        g.appendChild(badge);

        /* Tethers + anchor only below the large-stack threshold: past it
           the fan never opens (see selectRow), so there is no spread to
           tether back to — the badge alone carries "one place, N dates"
           at that size. These sit under the dots (appended first) and
           are hidden except while the stack is open (see
           .storm-dot-stack.is-open in styles.css). One tether per member,
           positioned in openStack() once the fan angles are known. */
        if (!stack.isLarge) {
          stack.anchorEl = svgEl("circle");
          stack.anchorEl.setAttribute("class", "storm-dot-anchor");
          stack.anchorEl.setAttribute("r", "1.5");
          g.appendChild(stack.anchorEl);

          stack.tetherEls = stack.members.map(function () {
            var line = svgEl("line");
            line.setAttribute("class", "storm-dot-tether");
            line.setAttribute("x1", "0");
            line.setAttribute("y1", "0");
            line.setAttribute("x2", "0");
            line.setAttribute("y2", "0");
            g.appendChild(line);
            return line;
          });
        }
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

  /* Newest member always lands at angle 0 (12 o'clock in screen terms,
     since SVG y grows downward); later members proceed clockwise from
     there. That fixed origin is what makes the fan read as a direction
     ("time, radiating out") rather than an arbitrary scatter — members
     arrive in newest-first order already (see buildStacks), so index 0
     is always the newest regardless of which coordinate this is. */
  function openStack(key) {
    var stack = stacks[key];
    if (!stack || stack.members.length < 2) return;
    stack.el.classList.add("is-open");
    var n = stack.members.length;
    var r = fanRadiusFor(n);
    stack.members.forEach(function (row, i) {
      var angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      var fx = Math.cos(angle) * r;
      var fy = Math.sin(angle) * r;
      row._groupEl.style.setProperty("--fx", fx.toFixed(2) + "px");
      row._groupEl.style.setProperty("--fy", fy.toFixed(2) + "px");
      var tether = stack.tetherEls[i];
      tether.setAttribute("x2", fx.toFixed(2));
      tether.setAttribute("y2", fy.toFixed(2));
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
    if (key && stacks[key] && !stacks[key].isLarge && stacks[key].members.length > 1) openStack(key);

    /* A large stack's selected member lives inside a collapsed group row
       (see renderList) — expand it so the answer is visible without an
       extra click, same reasoning as the newest event arriving already
       ignited on load. Never auto-collapses a group the visitor opened
       themselves; only ever opens the one that now needs to be seen. */
    if (key && stacks[key] && stacks[key].isLarge && stacks[key].groupEl) {
      stacks[key].groupEl.classList.add("is-expanded");
    }

    /* Raise the whole stack to the end of #storm-radar-dots so the
       selected dot (and its fanned siblings, if any) paint above every
       other stack on the panel — never hidden under a neighbour. */
    if (key && stacks[key]) dotsG.appendChild(stacks[key].el);
  }

  var _rowsCache = [];
  function findRowById(id) {
    for (var i = 0; i < _rowsCache.length; i++) {
      if (_rowsCache[i].id === id) return _rowsCache[i];
    }
    return null;
  }
})();
