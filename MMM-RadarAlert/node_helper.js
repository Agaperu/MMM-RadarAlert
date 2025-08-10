// node_helper.js
const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({
  start: function () {
    this.cache = {}; // simple in-memory cache { key: { ts, ttl, body, headers, ok, status } }
    this.name = "MMM-RadarAlert Helper";
    console.log(`${this.name} started`);
  },

  // caching helper
  async cachedFetch(url, ttl = 60 * 1000) {
    const now = Date.now();
    const key = url;
    const entry = this.cache[key];
    if (entry && (now - entry.ts) < ttl) {
      return entry;
    }

    try {
      const res = await fetch(url, { timeout: 20000 });
      const contentType = res.headers.get("content-type") || "";
      let body;
      if (contentType.includes("application/json") || contentType.includes("text/")) {
        body = await res.text();
      } else {
        // for images / binary, return url as-is (frontend will load it)
        // but still capture status/headers
        body = null;
      }
      const cached = {
        ts: now,
        ttl,
        ok: res.ok,
        status: res.status,
        headers: {}, // optional: map headers if needed
        body,
        url // keep original
      };
      this.cache[key] = cached;
      return cached;
    } catch (e) {
      return { ts: now, ttl, ok: false, status: 0, error: e.message, body: null, url };
    }
  },

  socketNotificationReceived: async function (notification, payload) {
    if (notification === "RADAR_ALERT_PROXY_FETCH") {
      const { id, url, ttl = 60 * 1000 } = payload;
      const res = await this.cachedFetch(url, ttl);
      this.sendSocketNotification("RADAR_ALERT_PROXY_RESULT", { id, result: res });
    }
  }
});


//   // called by MagicMirror to allow modules to expose HTTP endpoints
//   getApp: function () {
//     if (!this.expressApp) {
//       this.expressApp = express();
//     }
//     return this.expressApp;
//   },

//   // MagicMirror calls this when it mounts module's app
//   // But for compatibility, define a small server mount method:
//   // Note: MagicMirror module loader will mount this express app at /modules/<moduleName>
//   // to expose endpoints under that path. We'll keep a simple handler below.
//   // The exact mount mechanism varies; alternative: use this.expressApp in start().
// });
