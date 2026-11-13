# Security

Mishmar is used to protect people, so security reports get priority.

## Reporting a vulnerability

Report it privately through **Security → Report a vulnerability** on this repository (a GitHub private advisory). If that isn't available, use the contact on the maintainer's GitHub profile. You should hear back within 7 days. Please give us time to ship a fix before writing about it publicly.

**Never put real data in an issue.** That means no floor plans, survey photos, incident text, alert locations, member names, database files, `data/master.key`, or `data/vapid.json`. A description, the steps to reproduce and the app version are enough.

## Supported versions

Only the latest release gets security fixes.

## What Mishmar protects, and how

| Area | Protection |
|---|---|
| Accounts | Invite-only. scrypt password hashes, lockout plus rate limits, optional TOTP two-step sign-in (secret encrypted, codes can't be replayed). |
| Sessions | Random tokens stored only as SHA-256 hashes. HttpOnly, SameSite=Strict, Secure cookies. Revoked on password change, reset or deactivation. |
| Authorization | Roles (guard, coordinator, admin) checked on the server for every route. Event data is limited to that event's team. |
| Data at rest | AES-256-GCM with HKDF per-purpose keys covers incident text, alert locations, live positions, messages, briefings, contacts, GPS calibration, push subscriptions, re-showable invite codes and every photo. |
| Data minimization | No email, phone or member directory. Alert GPS is deleted after 14 days, messages after 7, event positions when the event ends, incidents after 365 days. Photo EXIF/GPS is stripped in the browser and again on the server. |
| Web | Strict CSP (no inline script or style), CSRF header on writes, `no-store` on the API. The service worker caches only the app shell, never data. Invite and reset codes travel in the URL fragment, so they never reach server logs. |
| Shabbat lock | Enforced on the server (HTTP 423), not just hidden in the UI. Life-safety routes stay available. |

## Known limits

- **Silent mode:** a web app can't bypass iPhone silent mode. Test alert delivery on your team's real phones.
- **Not 911:** Mishmar coordinates your team. It does not contact emergency services.
- **Single instance:** run one instance per congregation. Live connections and rate limits are held in memory.
- **The master key protects everything.** Keep `MISHMAR_MASTER_KEY` in a secrets manager, separate from backups.

## Deployment checklist

- Serve over HTTPS only, and set `TRUST_PROXY=1` behind a proxy.
- Set `MISHMAR_MASTER_KEY` from a secrets manager. Don't rely on the auto-generated `data/master.key` in production.
- Never set `MISHMAR_INSECURE_COOKIES` or `MISHMAR_FAKE_NOW` in production.
- Turn on two-step sign-in for every admin and coordinator.
- Monitor `/healthz` and schedule `npm run backup`.
