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

  var heroMark = document.querySelector(".hero-mark");
  var heroVideoWrap = document.querySelector(".hero-video-wrap");
  if (!reduceMotion && heroMark) {
    var ticking = false;
    var onHeroScroll = function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          var scrollY = window.scrollY;
          heroMark.style.setProperty("--parallax", Math.min(scrollY * 0.16, 70) + "px");
          if (heroVideoWrap) heroVideoWrap.style.setProperty("--parallax-video", Math.min(scrollY * 0.05, 25) + "px");
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

})();
