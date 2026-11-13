# Third-party software

| Package | License | Used for |
|---|---|---|
| [@hebcal/core](https://github.com/hebcal/hebcal-es6) (with @hebcal/hdate, @hebcal/noaa) | GPL-2.0-or-later (noaa: LGPL-2.1) | Candle-lighting, Havdalah and Yom Tov times |
| [Express](https://expressjs.com) | MIT | Web server |
| [Helmet](https://helmetjs.github.io) | MIT | Security headers and CSP |
| [Leaflet](https://leafletjs.com) | BSD-2-Clause | Maps (served from this app, not a CDN) |
| [Multer](https://github.com/expressjs/multer) | MIT | Photo uploads |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | MIT | QR codes for invites |
| [web-push](https://github.com/web-push-libs/web-push) | MPL-2.0 | Push notifications |

Map tiles, when an admin enables street maps, come from © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Heavy use should point `MAP_TILE_URL` at your own or a commercial tile server, per the OSM tile usage policy.

Mishmar itself is GNU AGPL-3.0-or-later, which is compatible with the GPL-2.0-or-later Hebcal libraries.
