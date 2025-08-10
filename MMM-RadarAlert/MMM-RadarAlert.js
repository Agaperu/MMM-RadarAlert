/* MMM-RadarAlert.js
   Starter MagicMirror module with:
   - multiple regions
   - multi-alert-provider support (NWS, MeteoAlarm)
   - RainViewer worldwide radar playback (animated frames)
   - flashing border, slide-in/out, audio
   - node_helper socket proxy usage for CORS + caching
*/

Module.register("MMM-RadarAlert", {
    defaults: {
      // Regions: for alerts use provider-specific identifiers:
      // NWS: zone codes like "TXZ213"
      // MeteoAlarm: country/area codes or zone ids (example: "GB" or more granular IDs)
      // For rainviewer provider, supply {lat, lon, zoom, name, zone?}
      regions: [],
  
      // Which alert providers to check (order matters)
      alertProviders: ["nws", "meteoalarm"],
  
      // Radar provider (where to get imagery)
      radarProvider: "rainviewer", // or "nws"
  
      // NWS templates
      radarUrlTemplateNWS: "https://radar.weather.gov/ridge/standard/{region}_loop.gif",
      alertApiTemplateNWS: "https://api.weather.gov/alerts/active/zone/{region}",
  
      // RainViewer endpoints
      rainviewerMetaUrl: "https://api.rainviewer.com/public/weather-maps.json",
      rainviewerImageTemplate: "https://tilecache.rainviewer.com/v2/radar/{t}/{z}/{x}/{y}/2/1_1.png",
      // NOTE: the rainviewerImageTemplate above is tile-based (example). We'll use the simpler
      // single-frame URL pattern for small footprints in this starter:
      rainviewerSingleFrameTemplate: "https://data.rainviewer.com/images/{timestamp}/radar_0.png",
  
      // Timing (ms)
      showDuration: 15 * 1000,
      repeatInterval: 5 * 60 * 1000,
      updateInterval: 60 * 1000, // poll alerts every 60s (increase to reduce API calls)
      rainviewerFrameInterval: 300, // ms per frame when animating the radar loop
  
      // Alert filtering
      alertTypes: ["Tornado Warning", "Severe Thunderstorm Warning", "Flash Flood Warning"],
  
      // Visual/audio
      soundFile: "modules/MMM-RadarAlert/alert.mp3",
      fadeSpeed: 400,
      useProxy: true, // use node_helper proxy (recommended)
      proxyTTL: 30 * 1000, // default cache TTL for proxy fetches (30s)
      // Whether to auto-hide on tap
      tapToDismiss: true
    },
  
    start() {
      Log.info(`${this.name} starting`);
      this.alertActive = false;
      this.visible = false;
      this.alertData = null;
      this.repeatTimer = null;
      this.alertCheckTimer = null;
      this.rainviewerMeta = null;
      this.frameIntervalId = null;
      this.animationFrameIndex = 0;
      this.currentFrameUrls = [];
      this.pendingFetches = {}; // map id -> resolve for proxy results
      this.nextRequestId = 1;
  
      this.scheduleAlertChecks();
    },
  
    scheduleAlertChecks() {
      this.checkAlerts(); // immediate
      this.alertCheckTimer = setInterval(() => this.checkAlerts(), this.config.updateInterval);
    },
  
    /* ------------ Proxy helpers ------------- */
    proxyFetch(url, ttl) {
      return new Promise((resolve) => {
        if (!this.config.useProxy || !this.sendSocketNotification) {
          // fallback: fetch directly in client (may be CORS blocked)
          fetch(url).then(async (res) => {
            let text = null;
            try { text = await res.text(); } catch (e) {}
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
        if (resolver) {
          resolver(result);
          delete this.pendingFetches[id];
        }
      }
    },
  
    /* ------------ Alert providers ------------- */
  
    async checkAlerts() {
      // Iterate configured regions and providers; set alertActive true if any match.
      let foundAlert = false;
      let foundData = null;
      let foundRegion = null;
  
      for (let region of this.config.regions) {
        for (let provider of this.config.alertProviders) {
          if (provider === "nws") {
            // expect region to be a zone string or object with zone property
            const zone = (typeof region === "string") ? region : region.zone;
            if (!zone) continue;
            const url = this.config.alertApiTemplateNWS.replace("{region}", zone);
            try {
              const res = await this.proxyFetch(url, this.config.proxyTTL);
              if (!res.ok) continue;
              const json = JSON.parse(res.body);
              if (json && Array.isArray(json.features) && json.features.length > 0) {
                // search for alert types configured
                for (let alert of json.features) {
                  const ev = alert.properties && alert.properties.event;
                  if (this.config.alertTypes.includes(ev)) {
                    foundAlert = true;
                    foundData = alert;
                    foundRegion = zone;
                    break;
                  }
                }
              }
            } catch (e) {
              Log.error(this.name + " NWS check error:", e);
            }
          } else if (provider === "meteoalarm") {
            // MeteoAlarm: for Europe/EUMETNET. Region object expected to have {country, areaId, name}
            // Simplified strategy: if region has `meteoalarmFeed` (RSS/OGC) use that; otherwise try generic API
            try {
              // If user provided an OGC / API URL for the given region: use it.
              if (region.meteoalarmUrl) {
                const res = await this.proxyFetch(region.meteoalarmUrl, this.config.proxyTTL);
                if (!res.ok) continue;
                // Many MeteoAlarm feeds are RSS or JSON; parse heuristically
                const body = res.body;
                if (body && body.includes("<rss")) {
                  // parse for <item><title> etc (quick detect)
                  if (body.includes("warning") || body.includes("aviso") || body.includes("warning")) {
                    // crude detection — treat as found (user should refine)
                    foundAlert = true;
                    foundData = { properties: { event: "MeteoAlarm", headline: region.name || "MeteoAlarm Alert" } };
                    foundRegion = region;
                  }
                } else {
                  // if JSON, look for entries
                  try {
                    const js = JSON.parse(body);
                    // heuristics
                    if (js && (js.features || js.entries || js.items)) {
                      // assume alerts present
                      foundAlert = true;
                      foundData = { properties: { event: "MeteoAlarm", headline: region.name || "MeteoAlarm Alert" } };
                      foundRegion = region;
                    }
                  } catch (e) {
                    // ignore
                  }
                }
              } else if (region.country) {
                // simple attempt to use official MeteoAlarm OGC API (example base)
                // NOTE: exact OGC endpoint can differ per deployment; user may provide exact endpoints for reliability.
                const ogcBase = `https://api.meteoalarm.org/`; // generic root; may need customization
                // Many MeteoAlarm deployments provide RSS feeds per country/region — we leave this flexible
                // For now, fallback to not triggering unless user supplies 'meteoalarmUrl'
              }
            } catch (e) {
              Log.error(this.name + " meteoalarm check error:", e);
            }
          }
          if (foundAlert) break;
        }
        if (foundAlert) break;
      }
  
      this.alertActive = foundAlert;
      this.alertData = foundData;
      this.alertRegion = foundRegion;
  
      this.handleAlertStatus();
    },
  
    /* ------------ Radar fetching & animation ------------- */
  
    async prepareRainViewerFrames() {
      // fetch rainviewer metadata (cached by proxy)
      try {
        const metaRes = await this.proxyFetch(this.config.rainviewerMetaUrl, 30 * 1000);
        if (!metaRes.ok || !metaRes.body) {
          Log.warn(this.name + " RainViewer meta fetch failed");
          return [];
        }
        const meta = JSON.parse(metaRes.body);
        // meta.radar.past is an array of timestamps (seconds)
        const past = meta.radar && meta.radar.past ? meta.radar.past : [];
        // Build frame urls (we'll use single-frame composite path for simplicity)
        // We'll use rainviewerSingleFrameTemplate: https://data.rainviewer.com/images/{timestamp}/radar_0.png
        const frames = past.map((t) => this.config.rainviewerSingleFrameTemplate.replace("{timestamp}", t));
        return frames;
      } catch (e) {
        Log.error(this.name + " prepareRainViewerFrames error:", e);
        return [];
      }
    },
  
    async startRainViewerAnimationInto(imgElement) {
      // Build frames if not present or expired
      this.currentFrameUrls = await this.prepareRainViewerFrames();
      if (!this.currentFrameUrls || this.currentFrameUrls.length === 0) {
        // fallback - transparent placeholder
        imgElement.src = "modules/MMM-RadarAlert/no-radar.png";
        return;
      }
  
      // Clear any existing frame interval
      if (this.frameIntervalId) {
        clearInterval(this.frameIntervalId);
        this.frameIntervalId = null;
      }
  
      // Cycle frames at rainviewerFrameInterval; if frame interval is small relative to showDuration,
      // we will cycle while visible; otherwise we can just set first frame.
      this.animationFrameIndex = 0;
      imgElement.src = this.currentFrameUrls[this.animationFrameIndex];
  
      this.frameIntervalId = setInterval(() => {
        this.animationFrameIndex = (this.animationFrameIndex + 1) % this.currentFrameUrls.length;
        imgElement.src = this.currentFrameUrls[this.animationFrameIndex];
      }, this.config.rainviewerFrameInterval);
    },
  
    stopRainViewerAnimation() {
      if (this.frameIntervalId) {
        clearInterval(this.frameIntervalId);
        this.frameIntervalId = null;
        this.currentFrameUrls = [];
      }
    },
  
    /* ------------ Show/Hide flow ------------- */
  
    handleAlertStatus() {
      if (this.alertActive) {
        // start repeating show cycle if not running
        if (!this.repeatTimer) {
          this.showRadar(); // show immediately
          this.repeatTimer = setInterval(() => this.showRadar(), this.config.repeatInterval);
        }
      } else {
        // stop repeating and hide
        if (this.repeatTimer) {
          clearInterval(this.repeatTimer);
          this.repeatTimer = null;
        }
        this.hideRadar(true);
      }
    },
  
    async showRadar() {
      this.visible = true;
      this.updateDom(this.config.fadeSpeed);
      this.playAudioCue();
  
      // start build of radar image & optional animation
      // wait a tick for DOM to mount then populate image
      setTimeout(async () => {
        const holder = document.querySelector(`#${this.identifier}-radar-img-holder`);
        if (holder) {
          holder.innerHTML = ""; // clear
          const img = document.createElement("img");
          img.className = "radar-image";
          holder.appendChild(img);
  
          if (this.config.radarProvider === "rainviewer") {
            await this.startRainViewerAnimationInto(img);
          } else if (this.config.radarProvider === "nws") {
            // use region zone string or region object
            const regionKey = (typeof this.alertRegion === "string") ? this.alertRegion : (this.alertRegion && this.alertRegion.zone);
            const url = this.config.radarUrlTemplateNWS.replace("{region}", regionKey || "KTLX");
            img.src = url;
          }
        }
      }, 50);
  
      // hide after showDuration
      setTimeout(() => {
        this.hideRadar();
      }, this.config.showDuration);
    },
  
    hideRadar(immediate = false) {
      // stop any radar animation
      this.stopRainViewerAnimation();
  
      this.visible = false;
      this.updateDom(this.config.fadeSpeed);
    },
  
    playAudioCue() {
      try {
        const audio = new Audio(this.config.soundFile);
        audio.volume = 0.8;
        audio.play().catch((e) => {
          Log.warn(this.name + " audio blocked:", e);
        });
      } catch (e) {
        Log.error(this.name + " audio error:", e);
      }
    },
  
    // Tap to dismiss
    notificationReceived(notification, payload, sender) {
      // reserved for future
    },
  
    getDom() {
      // Unique id helps DOM lookups from methods
      const root = document.createElement("div");
      root.className = "radar-alert";
      root.id = `${this.identifier}-radar-root`;
  
      // Visibility classes for slide and border flash
      if (this.visible) {
        root.classList.add("visible");
      } else {
        root.classList.remove("visible");
      }
  
      // Hidden when not active and not visible
      if (!this.alertActive && !this.visible) {
        root.style.display = "none";
        return root;
      }
  
      // Content container
      const content = document.createElement("div");
      content.className = "radar-content";
  
      // Header / title
      const title = document.createElement("div");
      title.className = "radar-title";
      title.innerHTML = `<strong>${(this.alertData && this.alertData.properties && this.alertData.properties.event) || (this.alertRegion && this.alertRegion.name) || "Severe Weather"}</strong><br/>${(this.alertData && this.alertData.properties && (this.alertData.properties.headline || this.alertData.properties.description)) || ""}`;
      content.appendChild(title);
  
      // image holder (we will populate image async in showRadar)
      const imgHolder = document.createElement("div");
      imgHolder.className = "radar-img-holder";
      imgHolder.id = `${this.identifier}-radar-img-holder`;
      content.appendChild(imgHolder);
  
      // tap to dismiss: clickable overlay
      if (this.config.tapToDismiss) {
        content.style.cursor = "pointer";
        content.addEventListener("click", () => {
          this.alertActive = false;
          this.hideRadar(true);
          // stop repeating cycle
          if (this.repeatTimer) {
            clearInterval(this.repeatTimer);
            this.repeatTimer = null;
          }
          this.sendNotification("RADAR_ALERT_USER_DISMISS", {});
        });
      }
  
      root.appendChild(content);
  
      // flashing border element
      const border = document.createElement("div");
      border.className = "radar-border";
      root.appendChild(border);
  
      return root;
    },
  
    // cleanup
    suspend() {
      if (this.alertCheckTimer) clearInterval(this.alertCheckTimer);
      if (this.repeatTimer) clearInterval(this.repeatTimer);
      this.stopRainViewerAnimation();
    },
  
    resume() {
      this.scheduleAlertChecks();
    }
  });
  