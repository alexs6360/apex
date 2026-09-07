/* Syncs the diagram's numbered markers with the accordion list —
   clicking either one opens that layer's description and closes
   the rest, and highlights the matching marker on the diagram. */
(function () {
  "use strict";

  var triggers = document.querySelectorAll(".rs-accordion-trigger");
  var markers = document.querySelectorAll(".rs-marker");
  if (!triggers.length) return;

  function setActive(layer) {
    triggers.forEach(function (trigger) {
      var item = trigger.closest(".rs-accordion-item");
      var panel = document.getElementById(trigger.getAttribute("aria-controls"));
      var isMatch = item.dataset.layer === layer;
      trigger.setAttribute("aria-expanded", isMatch ? "true" : "false");
      panel.hidden = !isMatch;
      item.classList.toggle("is-open", isMatch);
    });
    markers.forEach(function (marker) {
      marker.classList.toggle("is-active", marker.dataset.layer === layer);
    });
  }

  triggers.forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      var item = trigger.closest(".rs-accordion-item");
      var alreadyOpen = item.classList.contains("is-open");
      setActive(alreadyOpen ? null : item.dataset.layer);
    });
  });

  markers.forEach(function (marker) {
    marker.addEventListener("click", function () {
      setActive(marker.dataset.layer);
      var item = document.querySelector('.rs-accordion-item[data-layer="' + marker.dataset.layer + '"]');
      if (item) item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    marker.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        marker.click();
      }
    });
  });

  // Hovering an item highlights its marker, and hovering a marker
  // highlights its item — independent of which layer is open.
  triggers.forEach(function (trigger) {
    var item = trigger.closest(".rs-accordion-item");
    var marker = document.querySelector('.rs-marker[data-layer="' + item.dataset.layer + '"]');
    if (!marker) return;
    item.addEventListener("mouseenter", function () {
      marker.classList.add("is-item-hovered");
    });
    item.addEventListener("mouseleave", function () {
      marker.classList.remove("is-item-hovered");
    });
  });

  markers.forEach(function (marker) {
    var item = document.querySelector('.rs-accordion-item[data-layer="' + marker.dataset.layer + '"]');
    if (!item) return;
    marker.addEventListener("mouseenter", function () {
      item.classList.add("is-marker-hovered");
    });
    marker.addEventListener("mouseleave", function () {
      item.classList.remove("is-marker-hovered");
    });
  });

  setActive("1");
})();
