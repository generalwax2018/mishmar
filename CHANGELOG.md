# Changelog

## 0.4.1
- Docker: backups now go to /data/backups on the persistent volume (they were going to a folder the container couldn't write to).
- Dependency updates: web-push 4 (ES module), qrcode-generator 2, @hebcal/core 6.16.
- Added DEPLOY.md, a step-by-step hosting guide (VM with Caddy, or a container host).

## 0.4.0
- Easy invites: a "+ Invite someone" button on the Now screen, a name and plain-language role on each invite, one-tap sending by text, and a list of waiting invites where a leader can show a code again or cancel it.
- Glass interface that follows the phone's light or dark setting. Outdoor display mode stays solid and high-contrast.
- Open-source release under the AGPL-3.0, with a "Source code" link in the app.

## 0.3.0
- Practice drills with time-to-first-response.
- Delivery receipts, a connection watchdog, and alert retries.
- Offline incident reports.
- Reset codes for account recovery.
- Optional two-step sign-in (TOTP).
- QR and printable invites.
- Backups, a health check, and a Dockerfile.

## 0.2.0
- Building layout from photos, panoramas and pins.
- Outdoor event mode with zones, a GPS-calibrated site map and opt-in live positions.
- Alert types and escalation.
- Quick messages.
- Emergency card.
- Shabbat readiness reminders.

## 0.1.0
- Scheduling with posts.
- One-tap silent alert with location.
- Incident reports with photos.
- Shabbat / Yom Tov lock.
