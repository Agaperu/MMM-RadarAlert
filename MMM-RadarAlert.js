/* MMM-RadarAlert.js — Leaflet (local) + RainViewer overlay, NWS GIF
   - Robust nested-config merge
   - Safe basemap URL with fallback
   - Show panel before map; invalidate size after slide-in
   - Zoom helpers: region.zoom / config.leaflet.zoom / radiusKm support
*/

Module.register("MMM-RadarAlert", {
  defaults: {
    regions: [
      // Example region near Brandon, FL:
      // { name: "Brandon (Inland Hillsborough)", zone: "FLZ251", radarSite: "KTBW", lat: 27.9396, lon: -82.2865, zoom: 11 }
      // or use radius-based fitting:
      // { name: "Brandon", zone: "FLZ251", radarSite: "KTBW", lat: 27.9396, lon: -82.2865, radiusKm: 25 }
    ],

    alertProviders: ["nws"],

    /* radarProvider:
       - "nws"       : NWS GIF loop (fixed extent)
       - "rainviewer": Static-image animation (no basemap)
       - "leaflet"   : Leaflet basemap + RainViewer overlay (zoomable)
    */
    radarProvider: "leaflet",

    /* NWS */
    alertApiTemplateNWS: "https://api.weather.gov/alerts/active/zone/{region}",
    radarUrlTemplateNWS: "https://radar.weather.gov/ridge/standard/{radarSite}_loop.gif",

    /* RainViewer meta */
    rainviewerMetaUrl: "https://api.rainviewer.com/public/weather-maps.json",

    /* Leaflet + RainViewer overlay defaults */
    leaflet: {
      baseUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      baseMaxZoom: 18,
      zoom: 8,
      color: 2,
      smooth: 1,
      snow: 0,
      opacity: 0.9,
      frameInterval: 400
    },

    /* Legacy RainViewer static-image animation (no basemap) */
    rainviewer: { size: 512, zoom: 6, color: 2, smooth: 1, snow: 0 },
    rainviewerFrameInterval: 300,

    /* Timing */
    showDuration: 15 * 1000,
    repeatInterval: 5 * 60 * 1000,
    updateInterval: 60 * 1000,

    /* Alerts to react to */
    alertTypes: ["Tornado Warning", "Severe Thunderstorm Warning", "Severe Thunderstorm Watch", "Tropical Storm Warning", "Hurricane Warning"],

    /* Audio */
    soundFile: "modules/MMM-RadarAlert/alert.mp3",

    /* Proxy (optional) */
    useProxy: false,
    proxyTTL: 30 * 1000,

    tapToDismiss: true
  },

  /* ---- Load local CSS/Leaflet (put files in vendor/leaflet/) ---- */
  getStyles() {
    return [
      this.file("MMM-RadarAlert.css"),
      this.file("vendor/leaflet/leaflet.css")
    ];
  },
  getScripts() {
    return [
      this.file("vendor/leaflet/leaflet.js")
    ];
  },

  /* ---------- tiny utils ---------- */
  _isStr(v) { return typeof v === "string"; },
  _nonEmptyString(v) { return (typeof v === "string" && v.trim().length) ? v.trim() : null; },
  _validTileTemplate(url) { return this._isStr(url) && /{z}.*{x}.*{y}/.test(url); },

  /* ---------- helpers: merged nested config (ignore undefined/null) ---------- */
  _mergeDefaults(base, override) {
    const out = Object.assign({}, base || {});
    if (!override || typeof override !== "object") return out;
    for (const k of Object.keys(override)) {
      const v = override[k];
      if (v === undefined || v === null) continue; // don’t clobber with undefined/null
      out[k] = v;
    }
    return out;
  },
  _leafletCfg() { return this._mergeDefaults(this.defaults.leaflet, this.config.leaflet); },
  _rainviewerSimpleCfg() { return this._mergeDefaults(this.defaults.rainviewer, this.config.rainviewer); },

  /* ---------- visibility/DOM guards (NEW) ---------- */
  _isDisplayed() {
    // must have a region position and not be hidden; also root may or may not be in DOM yet
    return !!(this.data && this.data.position && !this.hidden);
  },
  _waitForDomThen(cb) {
    let tries = 0;
    const tick = () => {
      const root = document.getElementById(`${this.identifier}-radar-root`);
      if (this._isDisplayed() && root) { try { cb(); } catch(e){} return; }
      if (++tries > 40) return; // ~10s max
      setTimeout(tick, 250);
    };
    tick();
  },

  /* ---------- zoom helpers ---------- */
  // Priority: region.zoom → config.leaflet.zoom → 8
  _resolveZoom(center) {
    const LC = this._leafletCfg ? this._leafletCfg() : (this.config.leaflet || this.defaults.leaflet);
    if (center && typeof center.zoom === "number") return center.zoom;
    if (LC && Number.isFinite(LC.zoom)) return LC.zoom;
    return 8;
  },

  // If region has radiusKm, fit to that bounds; else setView with resolved zoom
  _fitRegionOrZoom(map, center) {
    const LC = this._leafletCfg ? this._leafletCfg() : (this.config.leaflet || this.defaults.leaflet);
    const lat = (center && typeof center.lat === "number") ? center.lat : 39.8283;
    const lon = (center && typeof center.lon === "number") ? center.lon : -98.5795;

    if (center && typeof center.radiusKm === "number" && center.radiusKm > 0) {
      const r = center.radiusKm;
      const dLat = r / 111; // ~111 km per degree latitude
      const dLon = r / (111 * Math.cos(lat * Math.PI / 180)); // lon degrees vary by latitude
      const southWest = [lat - dLat, lon - dLon];
      const northEast = [lat + dLat, lon + dLon];
      map.fitBounds([southWest, northEast], { padding: [12, 12], maxZoom: (LC && LC.baseMaxZoom) || 18 });
    } else {
      map.setView([lat, lon], this._resolveZoom(center));
    }
  },

  /* ---------- lifecycle ---------- */
  start() {
    Log.info(`${this.name} starting`);

    this._L = (typeof window !== "undefined" && window.L) ? window.L : undefined;

    this.alertActive   = false;
    this.alertData     = null;
    this.alertRegion   = null;

    this.alertCheckTimer = null;
    this.repeatTimer     = null;
    this.hideTimer       = null;
    this._rvTimer        = null;

    this._root    = null;
    this._map     = null;
    this._base    = null;
    this._rvLayer = null;
    this._rvFrames = [];
    this._rvIndex  = 0;

    this.pendingFetches = {};
    this.nextRequestId  = 1;

    this.scheduleAlertChecks();
  },

  /* ---------- test ---------- */
  triggerTestAlert() {
    this.alertActive = true;
    this.alertData = {
      properties: {
        event: "Heat Advisory",
        headline: "Test Heat Advisory",
        description: "This is a test alert to verify display, map, zoom, and audio."
      }
    };
    this.alertRegion = this.config.regions[0] || { name: "Test Region", zone: "FLZ251", radarSite: "KTLX", lat: 35.33, lon: -97.28, zoom: 11 };
    this.handleAlertStatus();
  },

  /* ---------- scheduling ---------- */
  scheduleAlertChecks() {
    this.checkAlerts();
    this.alertCheckTimer = setInterval(() => this.checkAlerts(), this.config.updateInterval);
  },

  /* ---------- proxy fetch (optional) ---------- */
  proxyFetch(url, ttl) {
    return new Promise((resolve) => {
      if (!this.config.useProxy || !this.sendSocketNotification) {
        fetch(url).then(async (res) => {
          let text = null; try { text = await res.text(); } catch {}
          resolve({ ok: res.ok, status: res.status, body: text, url });
        }).catch((e) => resolve({ ok: false, status: 0, error: e.message, url }));
        return;
      }
      const id = `req_${this.nextRequestId++}`;
      this.pendingFetches[id] = resolve;
      this.sendSocketNotification("RADAR_ALERT_PROXY_FETCH", { id, url, ttl });
    });
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "RADAR_ALERT_PROXY_RESULT") {
      const { id, result } = payload;
      const resolver = this.pendingFetches[id];
      if (resolver) { resolver(result); delete this.pendingFetches[id]; }
    }
  },

  /* ---------- alerts ---------- */
  async checkAlerts() {
    let foundAlert = false, foundData = null, foundRegion = null;

    for (const region of this.config.regions) {
      for (const provider of this.config.alertProviders) {
        if (provider === "nws") {
          const zone = (typeof region === "string") ? region : region.zone;
          if (!zone) continue;
          const url = this.config.alertApiTemplateNWS.replace("{region}", zone);
          try {
            const res = await this.proxyFetch(url, this.config.proxyTTL);
            if (!res.ok || !res.body) continue;
            const json = JSON.parse(res.body);
            const feats = Array.isArray(json.features) ? json.features : [];
            for (const alert of feats) {
              const ev = alert?.properties?.event || "";
              const matchAny = Array.isArray(this.config.alertTypes) && this.config.alertTypes.length === 0;
              if (matchAny || this.config.alertTypes.includes(ev)) {
                foundAlert = true; foundData = alert; foundRegion = region; break;
              }
            }
          } catch (e) { Log.error(this.name + " NWS check error:", e); }
        }
        if (foundAlert) break;
      }
      if (foundAlert) break;
    }

    this.alertActive = foundAlert;
    this.alertData   = foundData;
    this.alertRegion = foundRegion;
    this.handleAlertStatus();
  },

  /* ---------- legacy RainViewer static frames (no basemap) ---------- */
  async getCenterFrames(center) {
    const RV = this._rainviewerSimpleCfg();
    try {
      const res = await this.proxyFetch(this.config.rainviewerMetaUrl, 30000);
      if (!res.ok || !res.body) return [];
      const meta = JSON.parse(res.body);
      const host = meta.host || "https://tilecache.rainviewer.com";
      const past = Array.isArray(meta?.radar?.past) ? meta.radar.past : [];
      const lat = center?.lat ?? 39.8283, lon = center?.lon ?? -98.5795;
      return past.map(f => {
        const time = (typeof f === "object" && f) ? (f.time || f.ts || f.t) : f;
        const path = (typeof f === "object" && f && f.path) ? f.path : (time ? `/v2/radar/${time}` : null);
        if (!path) return null;
        return `${host}${path}/${RV.size}/${RV.zoom}/${lat}/${lon}/${RV.color}/${RV.smooth}_${RV.snow}.png`;
      }).filter(Boolean);
    } catch (e) { Log.error(this.name + " RainViewer meta error:", e); return []; }
  },

  /* ---------- Leaflet + RainViewer overlay ---------- */
  async initLeaflet(holder, center) {
    const L = this._L || (typeof window !== "undefined" ? window.L : undefined);
    if (!L) { console.warn(this.name, "Leaflet not loaded"); return false; }

    // Resolve base tile URL (validate template, else fallback to OSM)
    const LC = this._leafletCfg();
    let baseUrl = this._nonEmptyString(LC.baseUrl);
    if (!this._validTileTemplate(baseUrl)) {
      baseUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    }
    const maxZoom = Number.isFinite(LC.baseMaxZoom) ? LC.baseMaxZoom : 18;

    // Reuse existing map if present
    if (this._map && this._map._loaded) {
      if (!holder.contains(this._map._container)) {
        holder.appendChild(this._map._container);
        this._map.invalidateSize();
      }
      // center/zoom via helpers
      this._fitRegionOrZoom(this._map, center);
      if (!this._base) {
        try {
          this._base = L.tileLayer(baseUrl, { maxZoom, subdomains: "abc" }).addTo(this._map);
        } catch (e) {
          console.warn(this.name, "Base tile layer creation failed — fallback to OSM:", e);
          this._base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom, subdomains: "abc" }).addTo(this._map);
        }
      }
      return true;
    }

    // Create container
    const mapDiv = document.createElement("div");
    mapDiv.id = `${this.identifier}-leaflet`;
    mapDiv.style.width = "100%";
    mapDiv.style.height = "100%";
    holder.appendChild(mapDiv);

    // Create map
    this._map = L.map(mapDiv, { zoomControl: false, attributionControl: false, fadeAnimation: true });

    // Center/zoom (region zoom or radiusKm or config zoom)
    this._fitRegionOrZoom(this._map, center);

    // Create base layer
    try {
      this._base = L.tileLayer(baseUrl, { maxZoom, subdomains: "abc" }).addTo(this._map);
    } catch (e) {
      console.warn(this.name, "Base tile layer creation failed — fallback to OSM:", e);
      this._base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom, subdomains: "abc" }).addTo(this._map);
    }

    return true;
  },

  async startLeafletRainviewer(center) {
    const L = this._L || (typeof window !== "undefined" ? window.L : undefined);
    if (!L || !this._map) return;

    const LC = this._leafletCfg();

    // Use 256 tiles by default (safe). To try fewer, larger tiles, change to 512.
    const TILE_PX = 256; // ← change to 512 if you want (then see layer options below)

    // Build list of frame {url, ts}
    const fetchMeta = await this.proxyFetch(this.config.rainviewerMetaUrl, 30000);
    if (!fetchMeta?.ok || !fetchMeta.body) return;

    const meta  = JSON.parse(fetchMeta.body);
    const host  = meta.host || "https://tilecache.rainviewer.com";
    const past  = Array.isArray(meta?.radar?.past) ? meta.radar.past : [];
    const nowc  = Array.isArray(meta?.radar?.nowcast) ? meta.radar.nowcast : [];
    const frames = past.concat(nowc);
    if (!frames.length) return;

    const build = (frame) => {
      let time = null, path = null;
      if (frame && typeof frame === "object") {
        time = frame.time || frame.ts || frame.t || null;
        path = frame.path || (time ? `/v2/radar/${time}` : null);
      } else {
        time = frame;
        path = time ? `/v2/radar/${time}` : null;
      }
      if (!path) return null;
      const palette = Number.isFinite(LC.color) ? LC.color : 2;
      const smooth  = Number.isFinite(LC.smooth) ? LC.smooth : 1;
      const snow    = Number.isFinite(LC.snow)   ? LC.snow   : 0;
      const url = `${host}${path}/${TILE_PX}/{z}/{x}/{y}/${palette}/${smooth}_${snow}.png`;
      return { url, ts: time };
    };

    const data = frames.map(build).filter(Boolean);
    if (!data.length) return;

    // Keep our frame data & index
    this._rvFramesData = data;
    // Start on the latest (last) frame
    this._rvIndex = data.length - 1;

    // Ensure our double-buffer structure exists
    if (!this._rvLayers) {
      this._rvLayers = { A: null, B: null };
      this._rvActiveKey = "A";
    }

    const opacityTarget = LC.opacity ?? 0.9;

    // Helper to create a tile layer with fades
    const makeLayer = (url) => {
      const opts = {
        opacity: 0,
        zIndex: 200,
        className: "rv-fade" // so CSS transitions apply
      };
      // If you switch TILE_PX to 512, uncomment the next two lines:
      // opts.tileSize = 512;
      // opts.zoomOffset = -1;

      const layer = L.tileLayer(url, opts);
      layer.addTo(this._map);
      return layer;
    };

    // Ensure both layers exist
    if (!this._rvLayers.A) this._rvLayers.A = makeLayer(data[this._rvIndex].url);
    if (!this._rvLayers.B) this._rvLayers.B = makeLayer(data[this._rvIndex].url);

    // Show the active layer immediately (first frame)
    const active = this._rvLayers[this._rvActiveKey];
    active.setUrl(data[this._rvIndex].url);
    active.setOpacity(opacityTarget);

    // Clear any previous animator
    if (this._rvTimer) clearInterval(this._rvTimer);

    // Animator: preload on inactive, then cross-fade
    this._rvTimer = setInterval(() => {
      const nextIdx = (this._rvIndex + 1) % this._rvFramesData.length;
      const next = this._rvFramesData[nextIdx];
      if (!next?.url) { this._rvIndex = nextIdx; return; }

      const inactiveKey = (this._rvActiveKey === "A") ? "B" : "A";
      const inactive = this._rvLayers[inactiveKey];
      const current  = this._rvLayers[this._rvActiveKey];


      // Start with the inactive layer hidden
      inactive.setOpacity(0);
      inactive.setUrl(next.url);

      // When all tiles for the inactive layer are loaded, cross-fade
      const handleLoad = () => {
        inactive.off("load", handleLoad);
        // bring new frame on top & fade in
        try { inactive.bringToFront(); } catch {}
        inactive.setOpacity(opacityTarget);

        // fade out the current layer
        current.setOpacity(0);

        // swap active pointer
        this._rvActiveKey = inactiveKey;
        this._rvIndex = nextIdx;
      };

      inactive.on("load", handleLoad);
    }, LC.frameInterval ?? 220);
  },

  stopLeaflet() {
    if (this._rvTimer) { clearInterval(this._rvTimer); this._rvTimer = null; }
    if (this._rvLayer && this._map) { this._map.removeLayer(this._rvLayer); this._rvLayer = null; }
  },

  /* ---------- show/hide ---------- */
  handleAlertStatus() {
    const active = this.alertActive; // extend with lightningActive if you add it later
    if (active) {
      if (!this.repeatTimer) {
        // Only show when we’re actually displayed; otherwise wait for DOM
        if (this._isDisplayed()) this.showRadar();
        else this._waitForDomThen(() => this.showRadar());
        this.repeatTimer = setInterval(() => {
          if (this._isDisplayed()) this.showRadar();
          else this._waitForDomThen(() => this.showRadar());
        }, this.config.repeatInterval);
      }
    } else {
      if (this.repeatTimer) { clearInterval(this.repeatTimer); this.repeatTimer = null; }
      this.hideRadar(true);
    }
  },

  async showRadar() {
    // If we aren't displayed yet, defer without calling updateDom()
    if (!this._isDisplayed()) {
      this._waitForDomThen(() => this.showRadar());
      return;
    }

    const root = this._root || document.getElementById(`${this.identifier}-radar-root`);
    if (!root) {
      // DOM not built yet — wait and try again (avoid updateDom while hidden)
      this._waitForDomThen(() => this.showRadar());
      return;
    }

    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }

    // Title/subtitle
    const title = root.querySelector(".radar-title");
    const ev  = this.alertData?.properties?.event || (this.alertRegion && this.alertRegion.name) || "Severe Weather";
    const sub = this.alertData?.properties?.headline || this.alertData?.properties?.description || "";
    if (title) title.innerHTML = `<strong>${ev}</strong><br/>${sub}`;

    // Make the popup visible BEFORE creating the map
    const border = root.querySelector(".radar-border");
    if (border) border.classList.add("flash-border");
    root.style.display = "block";
    root.classList.remove("slide-out");
    void root.offsetWidth; // reflow
    root.classList.add("visible", "slide-in");

    // Give the layout a moment to size, then build the content
    await new Promise(r => setTimeout(r, 30));

    const holder = root.querySelector(`#${this.identifier}-radar-img-holder`);
    if (!holder) return;
    holder.innerHTML = "";

    if (this.config.radarProvider === "leaflet") {
      const ok = await this.initLeaflet(holder, this.alertRegion);
      if (ok) {
        await this.startLeafletRainviewer(this.alertRegion);
        // Critical: recalc size now that it's visible and after slide-in
        if (this._map) {
          this._map.invalidateSize();
          this._fitRegionOrZoom(this._map, this.alertRegion);
          setTimeout(() => {
            if (this._map) {
              this._map.invalidateSize();
              this._fitRegionOrZoom(this._map, this.alertRegion);
            }
          }, 550);
        }
      }
    } else if (this.config.radarProvider === "rainviewer") {
      const img = document.createElement("img");
      img.className = "radar-image";
      holder.appendChild(img);
      const frames = await this.getCenterFrames(this.alertRegion);
      if (frames.length) {
        let i = 0; img.src = frames[i];
        if (this._rvTimer) clearInterval(this._rvTimer);
        this._rvTimer = setInterval(() => {
          i = (i + 1) % frames.length;
          img.src = frames[i];
        }, this.config.rainviewerFrameInterval);
      } else {
        img.src = "modules/MMM-RadarAlert/no-radar.png";
      }
    } else { // "nws"
      const img = document.createElement("img");
      img.className = "radar-image";
      holder.appendChild(img);
      const site = (typeof this.alertRegion === "object" && this.alertRegion.radarSite) ? this.alertRegion.radarSite : "KTLX";
      img.src = this.config.radarUrlTemplateNWS.replace("{radarSite}", site);
    }

    // Audio + auto-hide
    this.playAudioCue();
    if (this.config.showDuration > 0) {
      this.hideTimer = setTimeout(() => this.hideRadar(false), this.config.showDuration);
    }
  },

  hideRadar(immediate = false) {
    if (this.config.radarProvider === "leaflet") this.stopLeaflet();
    if (this._rvTimer) { clearInterval(this._rvTimer); this._rvTimer = null; }

    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }

    const root = this._root || document.getElementById(`${this.identifier}-radar-root`);
    if (!root) return;

    const border = root.querySelector(".radar-border");
    if (border) border.classList.remove("flash-border");

    root.classList.remove("slide-in");
    void root.offsetWidth;
    root.classList.add("slide-out");

    setTimeout(() => {
      root.classList.remove("slide-out", "visible");
      root.style.display = "none";
    }, immediate ? 0 : 500);
  },

  playAudioCue() {
    const tryFile = () => new Promise((resolve, reject) => {
      try {
        const audio = new Audio(this.config.soundFile);
        audio.volume = 0.8;
        audio.oncanplaythrough = () => resolve(audio.play().catch(() => resolve()));
        audio.onerror = () => reject(new Error("audio file load error"));
        audio.load();
      } catch (e) { reject(e); }
    });
    const beep = () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine"; o.frequency.value = 880;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        o.start(); o.stop(ctx.currentTime + 0.4);
      } catch (e) {}
    };
    tryFile().catch(beep);
  },

  /* ---------- MagicMirror hooks ---------- */
  notificationReceived(notification, payload, sender) {},

  getDom() {
    const root = document.createElement("div");
    root.className = "radar-alert";
    root.id = `${this.identifier}-radar-root`;
    root.style.display = "none";

    const content = document.createElement("div");
    content.className = "radar-content";

    const title = document.createElement("div");
    title.className = "radar-title";
    title.innerHTML = "<strong>Severe Weather</strong><br/>";
    content.appendChild(title);

    const imgHolder = document.createElement("div");
    imgHolder.className = "radar-img-holder";
    imgHolder.id = `${this.identifier}-radar-img-holder`;
    content.appendChild(imgHolder);

    if (this.config.tapToDismiss) {
      content.style.cursor = "pointer";
      content.addEventListener("click", () => {
        this.alertActive = false;
        if (this.repeatTimer) { clearInterval(this.repeatTimer); this.repeatTimer = null; }
        this.hideRadar(true);
        this.sendNotification("RADAR_ALERT_USER_DISMISS", {});
      });
    }

    root.appendChild(content);

    const border = document.createElement("div");
    border.className = "radar-border";
    root.appendChild(border);

    // Invalidate after slide-in animation ends (ensures proper sizing)
    root.addEventListener("animationend", (e) => {
      if (e.animationName === "slide-in" && this._map) {
        this._map.invalidateSize();
        this._fitRegionOrZoom(this._map, this.alertRegion);
      }
    });

    this._root = root;
    return root;
  },

  suspend() {
    if (this.alertCheckTimer) { clearInterval(this.alertCheckTimer); this.alertCheckTimer = null; }
    if (this.repeatTimer)     { clearInterval(this.repeatTimer);     this.repeatTimer     = null; }
    this.hideRadar(true);
  },

  resume() {
    this.scheduleAlertChecks();
  }
});
