/* Address autocomplete for the storm history lookup.
   Ported from riseroofingms.com's shared AddressAutocomplete module — the
   storm history logic depends on it, but it is otherwise generic and carries
   no branding. */
window.AddressAutocomplete = (function () {
  /* The service area, in one place. Suggestions outside it are not offered at
     all, which is cheaper and kinder than offering an address we have no data
     for and then explaining that we have no data for it. Memphis metro:
     Shelby/Fayette/Tipton TN, DeSoto/Marshall/Tate/Tunica MS, Crittenden AR. */
  var AREA = { minLon: -90.8, minLat: 34.4, maxLon: -89.0, maxLat: 35.6 };
  var MEMPHIS = [-90.0490, 35.1495];

  function newSession() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now() + "-" + Math.round(Math.random() * 1e9);
  }

  function attach(opts) {
    var input = opts.input;
    var listEl = opts.listEl;
    var token = opts.token;
    var minChars = opts.minChars || 3;
    var debounceMs = Math.max(opts.debounceMs || 300, 300);
    var prefix = opts.idPrefix || "ac";
    var onChoose = opts.onChoose;
    if (!input || !listEl || !token) return null;

    var session = newSession();
    var timer = null;
    var items = [];
    var activeIndex = -1;

    function close() {
      items = [];
      activeIndex = -1;
      listEl.hidden = true;
      listEl.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function highlight(i) {
      activeIndex = i;
      Array.prototype.forEach.call(listEl.children, function (li, n) {
        var on = n === i;
        li.classList.toggle("is-active", on);
        li.setAttribute("aria-selected", String(on));
      });
      if (i >= 0 && listEl.children[i]) {
        input.setAttribute("aria-activedescendant", listEl.children[i].id);
        listEl.children[i].scrollIntoView({ block: "nearest" });
      }
    }

    function label(item) {
      return item.name + (item.place_formatted ? ", " + item.place_formatted : "");
    }

    function draw(list) {
      items = list;
      listEl.innerHTML = "";
      if (!list.length) { close(); return; }

      list.forEach(function (item, i) {
        var li = document.createElement("li");
        li.className = "sh-suggestion";
        li.id = prefix + "-suggestion-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");

        var name = document.createElement("span");
        name.className = "sh-suggestion-name";
        name.textContent = item.name;
        var ctx = document.createElement("span");
        ctx.className = "sh-suggestion-context";
        ctx.textContent = item.place_formatted || "";
        li.appendChild(name);
        li.appendChild(ctx);

        /* mousedown, not click: blur would close the list first. */
        li.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          pick(i);
        });
        listEl.appendChild(li);
      });

      listEl.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
    }

    function suggest(q) {
      if (q.length < minChars) { close(); return; }
      var url =
        "https://api.mapbox.com/search/searchbox/v1/suggest?q=" + encodeURIComponent(q) +
        "&session_token=" + encodeURIComponent(session) +
        "&country=us&types=address&limit=6" +
        "&proximity=" + MEMPHIS.join(",") +
        "&bbox=" + [AREA.minLon, AREA.minLat, AREA.maxLon, AREA.maxLat].join(",") +
        "&access_token=" + token;

      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (data) { draw((data && data.suggestions) || []); })
        .catch(close);
    }

    function pick(i) {
      var item = items[i];
      if (!item) return;
      var typed = label(item);
      input.value = typed;
      close();
      onChoose(item, typed, api);
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(function () { suggest(q); }, debounceMs);
    });

    input.addEventListener("keydown", function (e) {
      if (listEl.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlight((activeIndex + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlight((activeIndex - 1 + items.length) % items.length);
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        pick(activeIndex);
      } else if (e.key === "Escape") {
        close();
      }
    });

    input.addEventListener("blur", function () {
      setTimeout(close, 120);
    });

    var api = {
      close: close,
      hasActive: function () { return activeIndex >= 0 && !listEl.hidden; },
      chooseActive: function () { pick(activeIndex); },
      sessionToken: function () { return session; },
      /* A retrieve ends the session; the next search starts a new one. */
      resetSession: function () { session = newSession(); },
    };
    return api;
  }

  return { attach: attach, AREA: AREA, MEMPHIS: MEMPHIS };
})();
