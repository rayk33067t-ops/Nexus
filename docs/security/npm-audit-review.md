# Dashboard dependency audit (npm audit warnings)

Status: **review prepared, not yet confirmed against the phone's own `npm audit` output.**
The npm registry could not be reached from the environment that prepared this
review, so `npm audit` could not be run there. The apply script runs
`npm audit` on the phone, prints the real result, and stops for review. Where
the phone's result differs from this file, the phone's result wins.

Scope: `dashboard/` only (its own `package.json` and `package-lock.json`). Express
is a **production** dependency of the dashboard. The root project has only
development dependencies (`ts-node`, `typescript`, `@types/node`).

Locked versions reviewed (from `dashboard/package-lock.json` on `world-spine`,
commit 8641689): express 5.2.1, body-parser 2.3.0, qs 6.15.3, router 2.2.0.

## Findings matching these versions

npm counts each vulnerable package, including packages that are only flagged
because they depend on a vulnerable one. Three packages fit that pattern here:
**body-parser**, **qs**, and **express** (flagged through them). That is the
most likely source of the "3 vulnerabilities", but it is an inference until the
phone's audit output confirms it.

| Advisory | Package | Severity | Path | Fixed in | Reached by the dashboard? |
|---|---|---|---|---|---|
| GHSA-27r3-jxmh-p828 (CVE-2026-111181): a compressed body with trailing bytes can crash the process | body-parser 2.3.0 | High (7.5) | express → body-parser | 2.4.x (exact patched version to be confirmed by `npm audit`) | **No.** `dashboard/server.js` registers no body parser (`express.json`, `urlencoded`, `raw`, `text`), so request bodies are never parsed. |
| GHSA-x5fp-wj9c-mxmx (CVE-2026-82562): `arrayLimit` bypass with `comma: true` | qs 6.15.3 | Moderate | express → body-parser → qs; express → qs | 6.16.0 | **No.** Needs `qs.parse` with `comma: true`. Express 5's default query parser is "simple" (Node's own), not qs, and the dashboard reads no query parameters through qs. |
| GHSA-4mjr-xmp4-gh2g (CVE-2026-82417): `stringify` throws on a crafted `isBuffer` | qs 6.15.3 | Moderate | same as above | 6.16.0 | **No.** Needs `qs.parse` with `plainObjects` or `allowPrototypes`, then `qs.stringify`. The dashboard does neither. |
| GHSA-6pq8-jhm2-2vcw (CVE-2026-110816): `stringify` with `arrayFormat: 'comma'` throws | qs ≤ 6.16.0 | Moderate | same as above | 6.16.1 | **No.** The dashboard never calls `qs.stringify`. |

Also relevant: the dashboard listens on 127.0.0.1 only, so other devices can't
send it requests at all (checked by the behavioral test in
`tests/dashboard.test.ts`).

## Remediation

- Compatible fixes (no `--force`): the apply script runs `npm audit fix` in the
  isolated workspace's `dashboard/` folder, shows exactly what changed in
  `package-lock.json`, reruns every test, and commits it **separately** from the
  security fixes so it can be reviewed or dropped on its own.
- No forced or major-version upgrades are applied. If `npm audit` still reports
  anything after the compatible fix, it is listed in the script's report as
  residual risk for the Founder to decide on.

## Residual risk if a fix can't be applied

Low for the dashboard as written: none of the vulnerable code paths are used,
and the server is reachable only from the phone itself. This changes the moment
the dashboard starts parsing request bodies or using qs, so any such change
must come with the patched versions first.

## Sources

- Advisory summaries for GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g (github.com/advisories)
- OSV entry for GHSA-6pq8-jhm2-2vcw (osv.dev)
- Scanner report listing GHSA-27r3-jxmh-p828 against body-parser 2.3.0 under express 5.2.1
