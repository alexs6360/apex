(function () {
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Fixed glass header, site-wide: firms up past 40px scroll on every
     page (the old is-scrolled toggle, now also mirrored onto <html> as
     .scrolled). .hero-only concerns — the sticky hero's own --p
     progress and the nav's retreat-on-scroll-down / past-hero CTA swap
     — only ever activate on pages that actually have a .hero, so every
     other page's header just stays put, same as before this hero
     redesign. */
  (function () {
    var nav = document.getElementById("nav");
    var hero = document.querySelector(".hero");
    var root = document.documentElement;
    if (!nav) return;
    var ticking = false,
      lastY = 0;
    var apply = function () {
      ticking = false;
      var y = window.scrollY;
      nav.classList.toggle("is-scrolled", y > 40);
      root.classList.toggle("scrolled", y > 40);
      if (hero) {
        var h = hero.offsetHeight || 1;
        hero.style.setProperty("--p", Math.min(Math.max(y / h, 0), 1).toFixed(4));
        root.classList.toggle("past-hero", y > h - 90);
        if (!reduceMotion) {
          var dy = y - lastY;
          if (y > h && dy > 4) root.classList.add("nav-hidden");
          else if (dy < -4 || y < 40) root.classList.remove("nav-hidden");
        }
      }
      lastY = y;
    };
    apply();
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(apply);
        }
      },
      { passive: true }
    );
    window.addEventListener("resize", apply, { passive: true });
  })();

  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    document.documentElement.classList.add("js-reveal");
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  /* Same drift effect as the hero mark/video, generalized: any image
     opted in via [data-parallax] shifts a few pixels based on how far its
     own center sits from the viewport's center, rather than hero's
     page-scroll-position math (which only makes sense for an element
     pinned at the top of the page). The matching transform: scale(1.12)
     in styles.css gives it cropped-but-hidden edges to draw from. */
  var parallaxEls = document.querySelectorAll("[data-parallax]");
  if (!reduceMotion && parallaxEls.length) {
    var tickingParallax = false;
    var onParallaxScroll = function () {
      if (tickingParallax) return;
      window.requestAnimationFrame(function () {
        var viewportMid = window.innerHeight / 2;
        parallaxEls.forEach(function (el) {
          var rect = el.getBoundingClientRect();
          var elMid = rect.top + rect.height / 2;
          var offset = Math.max(Math.min((elMid - viewportMid) * 0.06, 14), -14);
          el.style.transform = "translateY(" + offset.toFixed(1) + "px) scale(1.12)";
        });
        tickingParallax = false;
      });
      tickingParallax = true;
    };
    window.addEventListener("scroll", onParallaxScroll, { passive: true });
    onParallaxScroll();
  }

  /* Highlights whichever section's content occupies the middle of the
     viewport right now. rootMargin shrinks the intersection root to a
     thin band around vertical center, so "active" tracks what's actually
     being read rather than flipping the moment any sliver of the next
     section peeks into view at the bottom of the screen. */
  var navSectionLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  if (navSectionLinks.length && "IntersectionObserver" in window) {
    var linkForSection = {};
    navSectionLinks.forEach(function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = document.getElementById(id);
      if (section) linkForSection[id] = link;
    });
    var sectionIds = Object.keys(linkForSection);
    if (sectionIds.length) {
      var navObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            var link = linkForSection[entry.target.id];
            if (link) link.classList.toggle("is-active", entry.isIntersecting);
          });
        },
        { rootMargin: "-45% 0px -45% 0px" }
      );
      sectionIds.forEach(function (id) {
        navObserver.observe(document.getElementById(id));
      });
    }
  }

  var navToggle = document.getElementById("navToggle");
  var mobileMenu = document.getElementById("mobileMenu");
  if (navToggle && mobileMenu) {
    var closeMenu = function () {
      navToggle.setAttribute("aria-expanded", "false");
      mobileMenu.classList.remove("is-open");
      document.body.style.overflow = "";
    };
    var openMenu = function () {
      navToggle.setAttribute("aria-expanded", "true");
      mobileMenu.classList.add("is-open");
      document.body.style.overflow = "hidden";
    };
    navToggle.addEventListener("click", function () {
      var isOpen = navToggle.getAttribute("aria-expanded") === "true";
      if (isOpen) {
        closeMenu();
      } else {
        openMenu();
      }
    });
    mobileMenu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth >= 720) closeMenu();
    });
  }

  /* Each service card hands off to the hero form rather than the bottom
     estimate form — it's the one already on screen for anyone who hasn't
     scrolled yet, and prefilling "What do you need?" turns a card pick
     into most of the form being done already. The <a> keeps a real href
     so it still works with JS disabled or via keyboard/screen reader;
     the click handler on the card just adds the prefill + focus on top. */
  document.querySelectorAll(".service-tile").forEach(function (tile) {
    var link = tile.querySelector("a[data-need]");
    if (!link) return;
    tile.addEventListener("click", function (e) {
      e.preventDefault();
      var target = document.getElementById("hero-form");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      var select = document.getElementById("hero-need");
      if (select) select.value = link.dataset.need;
      var nameField = document.getElementById("hero-name");
      if (nameField) nameField.focus({ preventScroll: true });
    });
  });

  /* Town pills hand off to the bottom estimate form (the nearer of the
     two forms to this section) with the address field prefilled to that
     town, rather than linking to a per-town landing page that doesn't
     exist yet. Same real-href-plus-click-handler pattern as the service
     tiles above, for the same reason: works with JS disabled too. */
  document.querySelectorAll(".area-cities a[data-town]").forEach(function (pill) {
    pill.addEventListener("click", function (e) {
      e.preventDefault();
      var target = document.getElementById("estimate");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      var cityField = document.getElementById("city");
      if (cityField) cityField.value = pill.dataset.town;
      var nameField = document.getElementById("name");
      if (nameField) nameField.focus({ preventScroll: true });
    });
  });

  /* Storm sky treatment: falling rain streaks, drifting clouds, and
     occasional lightning — shared between storm-history.html's page
     header (.sh-intro) and the homepage's storm-check section
     (.storm-sky); storm-weather.css has the CSS half. Generated here
     rather than hand-written in markup since dozens of randomized
     positions/speeds aren't maintainable as HTML. No-ops entirely on
     every other page (elements just don't exist). Rain and the cloud
     drift are ambient and run under prefers-reduced-motion's exclusion
     like everything else here; the clouds photo itself still loads
     either way (see the --defer branch below) since fetching an image
     isn't motion. */
  (function () {
    var cloudsEl = document.querySelector(".sh-clouds");
    var rainContainer = document.querySelector(".sh-rain");
    var lightningEl = document.querySelector(".sh-lightning");
    var boltEl = document.querySelector(".sh-bolt");
    var boltPath = boltEl ? boltEl.querySelector("path") : null;

    if (rainContainer && !reduceMotion) {
      var dropCount = 70;
      for (var i = 0; i < dropCount; i++) {
        var drop = document.createElement("span");
        drop.className = "sh-raindrop";
        drop.style.setProperty("--x", (Math.random() * 100).toFixed(1) + "%");
        drop.style.setProperty("--h", (40 + Math.random() * 60).toFixed(0) + "px");
        drop.style.setProperty("--w", (1 + Math.random() * 1).toFixed(2) + "px");
        drop.style.setProperty("--o", (0.35 + Math.random() * 0.4).toFixed(2));
        drop.style.setProperty("--duration", (0.6 + Math.random() * 0.9).toFixed(2) + "s");
        drop.style.setProperty("--delay", (Math.random() * -2).toFixed(2) + "s");
        rainContainer.appendChild(drop);
      }
    }

    /* --defer (storm-weather.css): the clouds photo loads only once this
       element is near the viewport, for a section that sits below its
       own page's other hero media (the homepage's video) rather than
       being the page's own header the way storm-history.html's is. A
       bandwidth choice, independent of prefers-reduced-motion — the
       photo still loads under reduced motion, it just doesn't drift. */
    if (cloudsEl && cloudsEl.classList.contains("sh-clouds--defer")) {
      if ("IntersectionObserver" in window) {
        /* A negative bottom margin, not 0 or a positive lead-in. .hero is
           exactly 100vh, so storm-check's top edge sits precisely at the
           fold on every device — a touching-but-zero-height "overlap"
           that both a positive margin (tried 200px first) and 0px itself
           still count as intersecting (confirmed live: it fired at
           scroll position 0, before any actual scrolling). Shrinking the
           effective viewport by 150px instead means the section's real
           edge has to cross 150px inside the actual viewport — i.e. the
           visitor has genuinely scrolled toward it — before this loads. */
        var cloudsObserver = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            cloudsEl.classList.add("is-loaded");
            cloudsObserver.disconnect();
          });
        }, { rootMargin: "0px 0px -150px 0px" });
        cloudsObserver.observe(cloudsEl);
      } else {
        cloudsEl.classList.add("is-loaded");
      }
    }

    /* Lightning: a visible bolt plus a soft ambient flash. Each flicker
       resolves in under a second via the CSS animations, and
       animationend removes the trigger classes so they can fire again
       later instead of looping — never a rapid strobe either way this
       fires. Three jagged path variants (viewBox 0 0 100 400, so they
       scale with .sh-bolt's own height) picked at random each strike so
       it isn't the same bolt every time. */
    var boltVariants = [
      "M52,0 L38,90 L56,96 L26,220 L44,226 L14,400",
      "M30,0 L47,80 L27,87 L58,205 L36,212 L64,400",
      "M62,0 L46,60 L66,67 L32,180 L52,187 L20,320 L40,327 L10,400"
    ];
    var strikeOnce = function () {
      if (boltEl && boltPath) {
        boltPath.setAttribute("d", boltVariants[Math.floor(Math.random() * boltVariants.length)]);
        boltEl.style.setProperty("--bolt-x", (15 + Math.random() * 70).toFixed(0) + "%");
        boltEl.classList.add("is-striking");
        boltEl.addEventListener("animationend", function onBoltEnd() {
          boltEl.classList.remove("is-striking");
          boltEl.removeEventListener("animationend", onBoltEnd);
        });
      }
      if (lightningEl) {
        lightningEl.classList.add("is-flashing");
        lightningEl.addEventListener("animationend", function onFlashEnd() {
          lightningEl.classList.remove("is-flashing");
          lightningEl.removeEventListener("animationend", onFlashEnd);
        });
      }
    };

    if ((lightningEl || boltEl) && !reduceMotion) {
      var root = (boltEl || lightningEl).closest(".sh-intro, .storm-sky");

      if (root && root.classList.contains("storm-sky")) {
        /* Homepage: one strike when the section first arrives, then
           stopped for good — repeating every 3-8s would mean it's still
           flashing while a visitor is reading the headline and typing
           their address. One strike catches the eye on arrival and then
           leaves them alone to do that. */
        if ("IntersectionObserver" in window) {
          var lightningObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (!entry.isIntersecting) return;
              strikeOnce();
              lightningObserver.disconnect();
            });
          }, { threshold: 0.3 });
          lightningObserver.observe(root);
        } else {
          strikeOnce();
        }
      } else {
        /* storm-history.html's page header: repeats every 3-8s for as
           long as the visitor is on the page — this page's own subject
           is the storm tool itself, so continuous atmosphere is earned
           here in a way it isn't on a homepage teaser section. */
        var scheduleLightning = function () {
          var delay = 3000 + Math.random() * 5000;
          setTimeout(function () {
            strikeOnce();
            scheduleLightning();
          }, delay);
        };
        scheduleLightning();
      }
    }
  })();

  /* Estimate form: inline validation on blur (not just on submit), and
     the submit button disables itself with a spinner so a slow
     connection can't be double-tapped into two submissions. The form
     carries novalidate specifically so the browser's own validation UI
     never fights with this one — checkValidity()/.validity still work
     fine with novalidate present, it only suppresses the native popup
     and auto-block-on-submit behavior. */
  var estimateForm = document.querySelector(".form-card");
  if (estimateForm) {
    var estimateFields = estimateForm.querySelectorAll("#name, #phone, #email, #service");

    var validateField = function (el) {
      var field = el.closest(".field");
      var error = field ? field.querySelector(".field-error") : null;
      var valid = el.checkValidity();
      if (field) field.classList.toggle("is-invalid", !valid);
      if (error) error.hidden = valid;
      return valid;
    };

    estimateFields.forEach(function (el) {
      el.addEventListener("blur", function () {
        validateField(el);
      });
    });

    estimateForm.addEventListener("submit", function (e) {
      var allValid = true;
      estimateFields.forEach(function (el) {
        if (!validateField(el)) allValid = false;
      });
      if (!allValid) {
        e.preventDefault();
        var firstInvalid = estimateForm.querySelector(".field.is-invalid input, .field.is-invalid select");
        if (firstInvalid) firstInvalid.focus();
        return;
      }
      var submitBtn = estimateForm.querySelector(".form-submit");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add("is-submitting");
      }
    });
  }

  /* Homepage hero entrance: the sticky hero's .fx elements (badge, h1,
     lede, cta, chips, panel, band) start at opacity:0 and only reveal
     via the body.anim/body.go keyframes in styles.css. No-ops on every
     page but index.html, since <body class="anim"> is only set there. */
  if (document.body.classList.contains("anim")) {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        document.body.classList.add("go");
      });
    });
    // animation-fill-mode:both pins the final opacity/transform once the
    // entrance finishes — dropping the classes afterward frees those
    // properties again instead of leaving them pinned forever.
    window.setTimeout(function () {
      document.body.classList.remove("anim", "go");
    }, 2200);
  }

  /* Hero video handoff: the long "story" clip (inspection through
     finished house) plays once, then crossfades into a short looping
     clip of the finished house. Both <video> elements carry data-src,
     not src — set here rather than in markup so a phone can skip
     straight to the light loop instead of fetching the heavy story
     file it's about to discard anyway. No-ops everywhere but the
     homepage, since #bg/#bgloop only exist in the hero. */
  (function () {
    var v = document.getElementById("bg"),
      lv = document.getElementById("bgloop");
    if (!v || !lv) return;

    var handed = false;
    function startLoop() {
      if (handed) return;
      handed = true;
      if (!lv.src) lv.src = lv.dataset.src;
      var p = lv.play();
      if (p && p.catch) p.catch(function () {});
      lv.classList.add("on");
    }

    // Phones: skip the long story file and run the short loop only.
    var light =
      window.matchMedia("(max-width:640px)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (light) {
      startLoop();
      return;
    }

    lv.src = lv.dataset.src; // warm the loop so the handoff never stalls
    v.src = v.dataset.src;
    var p = v.play();
    if (p && p.catch) p.catch(function () { startLoop(); });

    v.addEventListener("timeupdate", function () {
      if (!v.duration) return;
      // begin the crossfade just before the story ends
      if (v.currentTime > v.duration - 1.1) startLoop();
    });
    v.addEventListener("ended", startLoop);
    v.addEventListener("error", startLoop);
  })();

})();
