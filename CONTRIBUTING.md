# Contributing

Thanks for helping keep congregations safer. Mishmar is deliberately small: one Node process, SQLite, plain JavaScript in the browser, and no build step.

## Ground rules

- **Never post real data.** No floor plans, building photos, incident details, member names or database files in issues, pull requests or screenshots. Use the demo data or invented details.
- **Security problems go through a private advisory,** not an issue. See [SECURITY.md](SECURITY.md).
- **Life safety comes first.** A change must never make the silent alert slower, harder to reach, or blocked by the Shabbat lock.
- **Collect less, not more.** New features shouldn't add email, phone numbers, contact lists or long-lived location history. If something sensitive must be stored, encrypt it with `enc()` and give it a retention limit.
- **Keep the CSP strict.** No inline scripts or styles, no third-party CDNs. Build DOM with `h()`, never `innerHTML`.
- **Keep it usable for everyone.** That includes older volunteers, gloved hands, bright sun and weak signal. Use big tap targets and plain words.

## Development

```bash
npm install
MISHMAR_INSECURE_COOKIES=1 npm start   # http://localhost:3000
npm test                                # end-to-end suites, about 1 minute
```

On Windows PowerShell: `$env:MISHMAR_INSECURE_COOKIES=1; npm start`.

To try the Shabbat lock on a weekday, set `MISHMAR_FAKE_NOW=2026-11-06T23:00:00Z`.

## Pull requests

1. For anything bigger than a fix, open an issue first so we can agree on the approach.
2. Add or update tests in `test/`, and run `npm test` before pushing.
3. Server routes need a role check (`need(...)`). Routine routes also need `routineOnly`, unless they're life-safety.
4. Add a line to `CHANGELOG.md`.

By contributing, you agree your work is released under the GNU AGPL-3.0-or-later.
