/**
 * StayBee — Map integration: Google Maps primary, Leaflet/OpenStreetMap fallback.
 *
 * • Google Maps JavaScript API is tried first (requires GOOGLE_MAPS_API_KEY).
 * • If Google Maps authentication fails (wrong key, missing API enable, referrer
 *   restriction, billing not set up), Leaflet + OpenStreetMap is loaded from CDN
 *   automatically — no error shown to the user, just a working map.
 */
(function (global) {
  "use strict";

  var GMAPS_SCRIPT_ID = "staybee-google-maps-js";
  var LEAFLET_SCRIPT_ID = "staybee-leaflet-js";
  var LEAFLET_CSS_ID = "staybee-leaflet-css";
  var LEAFLET_BASE = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/";

  // Stored so gm_authFailure can reject the pending load promise.
  var _mapsLoadReject = null;

  // ─── Leaflet fallback ────────────────────────────────────────────────────

  /**
   * Replaces the contents of canvasEl with a Leaflet map centred on [lat, lng].
   * Safe to call even after Google Maps has written its error overlay to the element.
   */
  function initLeafletFallback(canvasEl, lat, lng) {
    if (!canvasEl || !isFinite(lat) || !isFinite(lng)) return;

    var wrap = canvasEl.closest("[data-staybee-map-preview-wrap]");
    var loadingEl = wrap && wrap.querySelector("[data-staybee-map-preview-loading]");
    var errEl = wrap && wrap.querySelector("[data-staybee-map-preview-error]");

    // Wipe Google's error overlay and make sure the canvas is visible.
    canvasEl.innerHTML = "";
    canvasEl.style.display = "";
    if (loadingEl) loadingEl.classList.add("d-none");
    if (errEl) errEl.classList.add("d-none");

    function showFallbackError() {
      canvasEl.style.display = "none";
      if (errEl) {
        errEl.textContent =
          "Map could not be loaded. Use “Open in Google Maps” below.";
        errEl.classList.remove("d-none");
      }
    }

    function buildLeafletMap() {
      var L = global.L;
      if (!L || typeof L.map !== "function") {
        showFallbackError();
        return;
      }
      try {
        // Fix marker image paths — needed when Leaflet is loaded from a CDN
        // because the CSS-computed relative path points to the wrong origin.
        delete L.Icon.Default.prototype._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: LEAFLET_BASE + "images/marker-icon-2x.png",
          iconUrl:       LEAFLET_BASE + "images/marker-icon.png",
          shadowUrl:     LEAFLET_BASE + "images/marker-shadow.png",
        });

        var lmap = L.map(canvasEl, {
          scrollWheelZoom: false,
          zoomControl: true,
        }).setView([lat, lng], 15);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright" ' +
            'target="_blank" rel="noopener">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(lmap);

        L.marker([lat, lng]).addTo(lmap);
      } catch (e) {
        console.error("[StayBee Maps] Leaflet init error:", e);
        showFallbackError();
      }
    }

    // Inject Leaflet CSS once
    if (!document.getElementById(LEAFLET_CSS_ID)) {
      var link = document.createElement("link");
      link.id = LEAFLET_CSS_ID;
      link.rel = "stylesheet";
      link.href = LEAFLET_BASE + "leaflet.css";
      document.head.appendChild(link);
    }

    // If Leaflet JS is already loaded and ready, use it immediately.
    if (global.L && typeof global.L.map === "function") {
      buildLeafletMap();
      return;
    }

    // If a Leaflet script tag is already in the DOM (loading in progress), poll.
    if (document.getElementById(LEAFLET_SCRIPT_ID)) {
      var polls = 0;
      var iv = setInterval(function () {
        polls++;
        if (global.L && typeof global.L.map === "function") {
          clearInterval(iv);
          buildLeafletMap();
        } else if (polls > 120) {
          clearInterval(iv);
          showFallbackError();
        }
      }, 50);
      return;
    }

    // Load Leaflet JS from CDN.
    var s = document.createElement("script");
    s.id = LEAFLET_SCRIPT_ID;
    s.src = LEAFLET_BASE + "leaflet.js";
    s.onload = function () { buildLeafletMap(); };
    s.onerror = function () {
      console.error("[StayBee Maps] Failed to load Leaflet from CDN.");
      showFallbackError();
    };
    document.head.appendChild(s);
  }

  // Expose so the preview IIFE's .catch() can reach it.
  global.__stayBeeInitLeafletFallback = initLeafletFallback;

  // ─── Google Maps loader ──────────────────────────────────────────────────

  function ensureGoogleMapsLoaded(apiKey) {
    if (!apiKey || String(apiKey).trim() === "") {
      return Promise.reject(new Error("Google Maps API key is missing."));
    }

    if (
      global.google &&
      global.google.maps &&
      typeof global.google.maps.Map === "function"
    ) {
      return Promise.resolve();
    }

    if (global.__stayBeeMapsPromise) {
      return global.__stayBeeMapsPromise;
    }

    global.__stayBeeMapsPromise = new Promise(function (resolve, reject) {
      _mapsLoadReject = reject;

      var existing = document.getElementById(GMAPS_SCRIPT_ID);
      if (existing) {
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          if (
            global.google &&
            global.google.maps &&
            typeof global.google.maps.Map === "function"
          ) {
            clearInterval(iv);
            _mapsLoadReject = null;
            resolve();
          } else if (tries > 120) {
            clearInterval(iv);
            global.__stayBeeMapsPromise = null;
            _mapsLoadReject = null;
            reject(
              new Error(
                "Google Maps script tag is present but the API did not initialise.",
              ),
            );
          }
        }, 50);
        return;
      }

      var cbName = "__stayBeeGmapsCb_" + Date.now();
      global[cbName] = function () {
        _mapsLoadReject = null;
        try { delete global[cbName]; } catch (e) {}
        if (
          global.google &&
          global.google.maps &&
          typeof global.google.maps.Map === "function"
        ) {
          resolve();
        } else {
          global.__stayBeeMapsPromise = null;
          reject(new Error("Maps JavaScript API loaded but Map constructor is unavailable."));
        }
      };

      var s = document.createElement("script");
      s.id = GMAPS_SCRIPT_ID;
      s.async = true;
      s.src =
        "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(apiKey) +
        "&v=weekly&callback=" +
        cbName;
      s.onerror = function () {
        global.__stayBeeMapsPromise = null;
        _mapsLoadReject = null;
        try { delete global[cbName]; } catch (e) {}
        reject(new Error("Failed to fetch the Google Maps JavaScript API script."));
      };
      document.head.appendChild(s);
    });

    return global.__stayBeeMapsPromise;
  }

  global.__stayBeeEnsureGoogleMapsLoaded = ensureGoogleMapsLoaded;
  global.__stayBeeEnsureGoogleMapsWithPlaces = ensureGoogleMapsLoaded;

  // ─── gm_authFailure hook ─────────────────────────────────────────────────

  if (!global.__stayBeeGmAuthHooked) {
    global.__stayBeeGmAuthHooked = true;
    var prevAuthFail = global.gm_authFailure;

    global.gm_authFailure = function () {
      if (typeof prevAuthFail === "function") {
        try { prevAuthFail(); } catch (e) {}
      }

      console.error(
        "[StayBee Maps] Google Maps authentication failed.\n" +
          "  Possible causes:\n" +
          "  1. Maps JavaScript API not enabled — enable it at:\n" +
          "     https://console.cloud.google.com/apis/library/maps-backend.googleapis.com\n" +
          "  2. Billing not active on the Google Cloud project.\n" +
          "  3. API key HTTP referrer restrictions block this URL.\n" +
          "     Add these patterns in Cloud Console → Credentials → API key:\n" +
          "       http://localhost:3000/*\n" +
          "       http://localhost/*\n" +
          "       https://yourdomain.com/*\n" +
          "  Falling back to OpenStreetMap (Leaflet).",
      );

      // Case 1 — auth failed before/during script init: reject the pending
      // promise so the preview IIFE's .catch() runs and triggers Leaflet.
      if (_mapsLoadReject) {
        var rej = _mapsLoadReject;
        _mapsLoadReject = null;
        global.__stayBeeMapsPromise = null;
        rej(new Error("google-maps-auth-failure"));
      }

      // Case 2 — auth failed after the map was already rendered (Google does
      // an async key check after drawing the first tile). Switch to Leaflet.
      var previewCfg = global.__STAYBEE_MAP_PREVIEW__;
      var previewEl = document.getElementById("staybeeMapPreview");
      if (
        previewEl &&
        previewCfg &&
        previewCfg.lat != null &&
        previewCfg.lng != null
      ) {
        initLeafletFallback(
          previewEl,
          Number(previewCfg.lat),
          Number(previewCfg.lng),
        );
      }
    };
  }
})(typeof window !== "undefined" ? window : this);

// ─── Map Picker (new / edit listing forms) ──────────────────────────────────
(function () {
  "use strict";
  var cfg = window.__STAYBEE_MAP_PICKER__;
  if (!cfg || !cfg.apiKey) return;

  function showPickerError(msg) {
    var el = document.getElementById("staybeeMapPickerError");
    var loading = document.getElementById("staybeeMapPickerLoading");
    if (loading) loading.classList.add("d-none");
    if (el) {
      el.textContent = msg;
      el.classList.remove("d-none");
    }
  }

  function hidePickerError() {
    var el = document.getElementById("staybeeMapPickerError");
    if (el) el.classList.add("d-none");
  }

  function hidePickerLoading() {
    var loading = document.getElementById("staybeeMapPickerLoading");
    if (loading) loading.classList.add("d-none");
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function parseCoord(val) {
    if (val == null) return null;
    var s = String(val).trim().replace(",", ".");
    if (s === "") return null;
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function isValidLatLng(lat, lng) {
    return (
      lat != null && lng != null &&
      lat >= -90 && lat <= 90 &&
      lng >= -180 && lng <= 180
    );
  }

  function initPicker() {
    var mapEl = document.getElementById("staybeeMapPicker");
    if (!mapEl) return;

    var section = document.querySelector("[data-staybee-map-section]");
    if (section && section.getAttribute("data-staybee-maps-initialized") === "1") return;
    if (section) section.setAttribute("data-staybee-maps-initialized", "1");

    var latInput  = document.getElementById("listingLatitude");
    var lngInput  = document.getElementById("listingLongitude");
    var addrInput = document.getElementById("listingLocationAddress");
    var clearBtn  = document.getElementById("staybeeMapClearLocation");
    var geoBtn    = document.getElementById("staybeeUseCurrentLocation");

    var center = { lat: Number(cfg.centerLat), lng: Number(cfg.centerLng) };
    var map = new google.maps.Map(mapEl, {
      center: center,
      zoom: cfg.hasExistingCoords ? 15 : 5,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    var marker = new google.maps.Marker({
      map: map,
      draggable: true,
      animation: google.maps.Animation.DROP,
    });

    if (!cfg.hasExistingCoords) marker.setVisible(false);

    var geocoder = new google.maps.Geocoder();
    var syncingFromMap = false;

    function fillCoordInputs(lat, lng) {
      syncingFromMap = true;
      if (latInput) latInput.value = lat.toFixed(7);
      if (lngInput) lngInput.value = lng.toFixed(7);
      syncingFromMap = false;
    }

    function setPosition(latLng, optAddress, skipGeocode) {
      marker.setVisible(true);
      marker.setPosition(latLng);
      map.panTo(latLng);
      var lat = typeof latLng.lat === "function" ? latLng.lat() : latLng.lat;
      var lng = typeof latLng.lng === "function" ? latLng.lng() : latLng.lng;
      fillCoordInputs(lat, lng);
      hidePickerError();
      if (optAddress && addrInput) {
        addrInput.value = optAddress;
      } else if (!skipGeocode && addrInput) {
        geocoder.geocode({ location: latLng }, function (results, status) {
          if (status === "OK" && results && results[0]) {
            addrInput.value = results[0].formatted_address;
          }
        });
      }
    }

    function applyManualCoordinates() {
      if (syncingFromMap) return;
      var lat = parseCoord(latInput ? latInput.value : "");
      var lng = parseCoord(lngInput ? lngInput.value : "");
      if (lat == null && lng == null) { hidePickerError(); return; }
      if (lat == null || lng == null) {
        showPickerError("Enter both latitude and longitude, or clear both fields.");
        return;
      }
      if (!isValidLatLng(lat, lng)) {
        showPickerError("Use valid latitude (−90 to 90) and longitude (−180 to 180), or use the map.");
        return;
      }
      hidePickerError();
      var ll = new google.maps.LatLng(lat, lng);
      setPosition(ll, null, false);
      map.setZoom(Math.max(map.getZoom(), 14));
    }

    function trySyncManualCoordsWhileTyping() {
      if (syncingFromMap) return;
      var lat = parseCoord(latInput ? latInput.value : "");
      var lng = parseCoord(lngInput ? lngInput.value : "");
      if (lat == null && lng == null) { hidePickerError(); return; }
      if (!isValidLatLng(lat, lng)) return;
      hidePickerError();
      var ll = new google.maps.LatLng(lat, lng);
      setPosition(ll, null, false);
      map.setZoom(Math.max(map.getZoom(), 14));
    }

    var debouncedWhileTyping = debounce(trySyncManualCoordsWhileTyping, 450);

    if (latInput) {
      latInput.addEventListener("input", function () { if (!syncingFromMap) debouncedWhileTyping(); });
      latInput.addEventListener("blur",  function () { if (!syncingFromMap) applyManualCoordinates(); });
    }
    if (lngInput) {
      lngInput.addEventListener("input", function () { if (!syncingFromMap) debouncedWhileTyping(); });
      lngInput.addEventListener("blur",  function () { if (!syncingFromMap) applyManualCoordinates(); });
    }

    if (cfg.initialLat != null && cfg.initialLng != null) {
      setPosition(
        { lat: Number(cfg.initialLat), lng: Number(cfg.initialLng) },
        cfg.initialAddress || "",
        true,
      );
      map.setZoom(15);
    }

    map.addListener("click", function (e) { setPosition(e.latLng); });
    marker.addListener("dragend", function () {
      var pos = marker.getPosition();
      if (pos) setPosition(pos);
    });

    google.maps.event.addListenerOnce(map, "idle", function () { hidePickerLoading(); });

    if (geoBtn) {
      geoBtn.addEventListener("click", function () {
        hidePickerError();
        if (!navigator.geolocation) {
          showPickerError("Your browser does not support geolocation.");
          return;
        }
        geoBtn.disabled = true;
        geoBtn.setAttribute("aria-busy", "true");
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            geoBtn.disabled = false;
            geoBtn.removeAttribute("aria-busy");
            setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }, null, false);
            map.setZoom(16);
          },
          function (err) {
            geoBtn.disabled = false;
            geoBtn.removeAttribute("aria-busy");
            var msg = "Could not retrieve your current location.";
            if (err && err.code === 1) msg = "Location permission denied. Allow location in your browser settings, or set the pin manually.";
            else if (err && err.code === 2) msg = "Your position is unavailable. Try again or place the pin on the map.";
            else if (err && err.code === 3) msg = "Location request timed out. Try again.";
            showPickerError(msg);
          },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
        );
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        marker.setVisible(false);
        syncingFromMap = true;
        if (latInput) latInput.value = "";
        if (lngInput) lngInput.value = "";
        syncingFromMap = false;
        if (addrInput) addrInput.value = "";
        map.setCenter(center);
        map.setZoom(5);
        hidePickerError();
      });
    }

    var form = document.querySelector("[data-staybee-listing-form]");
    if (form && form.getAttribute("data-require-map-location") === "true") {
      form.addEventListener("submit", function (e) {
        var lat = parseCoord(latInput ? latInput.value : "");
        var lng = parseCoord(lngInput ? lngInput.value : "");
        if (!isValidLatLng(lat, lng)) {
          e.preventDefault();
          showPickerError(
            "Please set a valid location: use the map, current location, or enter latitude and longitude.",
          );
          mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }
  }

  window.__stayBeeEnsureGoogleMapsLoaded(cfg.apiKey)
    .then(function () { initPicker(); })
    .catch(function (err) {
      hidePickerLoading();
      showPickerError(
        err.message === "google-maps-auth-failure"
          ? "Google Maps authentication failed. Check that the Maps JavaScript API is enabled, " +
            "billing is active, and HTTP referrer restrictions include this domain."
          : err.message ||
            "Could not load Google Maps. Verify the API key, referrer restrictions, " +
            "and that Maps JavaScript API is enabled in Google Cloud Console.",
      );
    });
})();

// ─── Map Preview (listing detail / show page) ───────────────────────────────
(function () {
  "use strict";
  var cfg = window.__STAYBEE_MAP_PREVIEW__;
  if (!cfg || !cfg.apiKey || cfg.lat == null || cfg.lng == null) return;

  var el = document.getElementById("staybeeMapPreview");
  if (!el) return;

  var lat = Number(cfg.lat);
  var lng = Number(cfg.lng);

  function showPreviewError(msg) {
    var wrap = el.closest("[data-staybee-map-preview-wrap]");
    var errEl = wrap && wrap.querySelector("[data-staybee-map-preview-error]");
    var loadEl = wrap && wrap.querySelector("[data-staybee-map-preview-loading]");
    if (loadEl) loadEl.classList.add("d-none");
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove("d-none");
    }
  }

  function hidePreviewLoading() {
    var wrap = el.closest("[data-staybee-map-preview-wrap]");
    var loadEl = wrap && wrap.querySelector("[data-staybee-map-preview-loading]");
    if (loadEl) loadEl.classList.add("d-none");
  }

  function initGooglePreview() {
    if (!isFinite(lat) || !isFinite(lng)) {
      showPreviewError("Invalid coordinates stored for this listing.");
      return;
    }
    var pos = { lat: lat, lng: lng };
    var map = new google.maps.Map(el, {
      center: pos,
      zoom: 15,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });
    new google.maps.Marker({
      map: map,
      position: pos,
      animation: google.maps.Animation.DROP,
    });
    google.maps.event.addListenerOnce(map, "idle", function () {
      hidePreviewLoading();
    });
  }

  function start() {
    if (!isFinite(lat) || !isFinite(lng)) {
      showPreviewError("Invalid coordinates stored for this listing.");
      return;
    }

    window
      .__stayBeeEnsureGoogleMapsLoaded(cfg.apiKey)
      .then(function () {
        initGooglePreview();
      })
      .catch(function (err) {
        // Google Maps auth failed or could not load — switch to Leaflet fallback.
        // initLeafletFallback handles its own loading indicator / error display.
        if (typeof window.__stayBeeInitLeafletFallback === "function") {
          window.__stayBeeInitLeafletFallback(el, lat, lng);
        } else {
          hidePreviewLoading();
          showPreviewError(
            "Map could not be loaded. Use “Open in Google Maps” below.",
          );
        }
      });
  }

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            io.disconnect();
            start();
          }
        });
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
  } else {
    start();
  }
})();
