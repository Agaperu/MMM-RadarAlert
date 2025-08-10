# MMM-RadarAlert

## Description

Displays animated radar only during severe weather alerts using Leaflet and RainViewer tiles.

Supports multiple regions with real-time alerts from:

- U.S. National Weather Service (NWS) API by zone
- European MeteoAlarm RSS feeds
- Custom regions (add your own alert sources)

Features:

- Configurable alert keywords for filtering
- Audio alert sounds per alert type
- Flashing colored border with animations
- Option for worldwide radar for all configured regions

## Installation

1. Copy the `MMM-RadarAlert` folder into your MagicMirror `modules` directory.

2. Add the following configuration to your `config/config.js`:

```js
{
  module: "MMM-RadarAlert",
  position: "top_center",
  config: {
    regions: [
      {
        name: "New York",
        nwsZone: "NYZ072",
        radarLatLng: [40.7128, -74.006],
        radarZoom: 7
      },
      {
        name: "London",
        meteoAlarmFeed: "https://feeds.meteoalarm.org/feeds/UK-SC.xml",
        radarLatLng: [51.5074, -0.1278],
        radarZoom: 7
      }
    ],
    alertKeywords: ["Warning", "Watch", "Severe", "Tornado", "Flood"],
    displayDuration: 15000,
    repeatInterval: 300000,
    worldwide: false,
    audioAlert: true
  }
}
