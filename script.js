(function () {
  var nav = document.getElementById("nav");
  var onScroll = function () {
    nav.classList.toggle("is-scrolled", window.scrollY > 40);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  var reveals = document.querySelectorAll(".reveal, .process-item");
  if ("IntersectionObserver" in window) {
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

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var heroVideo = document.getElementById("heroVideo");
  if (heroVideo && reduceMotion) {
    heroVideo.pause();
    heroVideo.removeAttribute("autoplay");
  }

  var heroVideoWrap = document.querySelector(".hero-video-wrap");
  if (!reduceMotion && heroVideoWrap) {
    var ticking = false;
    var onHeroScroll = function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          var scrollY = window.scrollY;
          heroVideoWrap.style.setProperty("--parallax-video", Math.min(scrollY * 0.05, 25) + "px");
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener("scroll", onHeroScroll, { passive: true });
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

  /* Storm history hero: falling rain streaks plus an occasional lightning
     flash behind the headline — fits the page's subject (a storm-history
     lookup tool) better than a static hero. Generated here rather than
     hand-written in markup since dozens of randomized positions/speeds
     aren't maintainable as HTML. No-ops entirely on every other page
     (elements just don't exist) and under prefers-reduced-motion. */
  var rainContainer = document.querySelector(".sh-rain");
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

  /* Lightning: a visible bolt plus a soft ambient flash, at random
     intervals (6-16s apart), never a rapid strobe — each flicker resolves
     in under a second via the CSS animations, and animationend removes
     the trigger classes so they can fire again later instead of looping.
     Three jagged path variants (viewBox 0 0 100 400, so they scale with
     .sh-bolt's own height) picked at random each strike so it isn't the
     same bolt every time. */
  var lightningEl = document.querySelector(".sh-lightning");
  var boltEl = document.querySelector(".sh-bolt");
  var boltPath = boltEl ? boltEl.querySelector("path") : null;
  var boltVariants = [
    "M52,0 L38,90 L56,96 L26,220 L44,226 L14,400",
    "M30,0 L47,80 L27,87 L58,205 L36,212 L64,400",
    "M62,0 L46,60 L66,67 L32,180 L52,187 L20,320 L40,327 L10,400"
  ];
  if ((lightningEl || boltEl) && !reduceMotion) {
    var scheduleLightning = function () {
      var delay = 6000 + Math.random() * 10000;
      setTimeout(function () {
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
        scheduleLightning();
      }, delay);
    };
    scheduleLightning();
  }

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

})();
