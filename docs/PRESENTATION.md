---
marp: true
title: Autonomous UI/UX QA Platform
paginate: true
---

# Autonomous UI/UX QA Platform

Give it a URL. It opens a real browser, tests the page the way a person would, and reports only confirmed bugs.

<!-- Speaker note: one-line pitch. Say what it is before how it works. -->

---

## The problem

- Manual UI testing is slow and repetitive, and it gets skipped under deadline pressure.
- Scripted tests break when the page changes, and someone has to write them for every page.
- Automated tools often flood teams with false alarms, so people stop trusting the results.

---

## What it does

- Takes a URL, plus an optional login token.
- Finds the buttons, links, forms, tabs, menus and dialogs on the page by itself.
- Tries each one safely and checks that it did what it should.
- Shows the test live, then a results page with screenshots.

No test scripts are written per page.

---

## How a run works

1. Open the page in a real browser.
2. Check that the page's data actually loaded.
3. Discover the elements on the page.
4. For each element: **safety check → interact → observe → verify**.
5. Explore anything that opened (dialogs, tabs, menus), then put it back as it was.
6. Write the report.

---

## Only real bugs are reported

Every tested element ends in one of three results:

| Result | Meaning |
|---|---|
| **Pass** | The expected behaviour was observed |
| **Inconclusive / Blocked** | It could not be verified, or it was skipped for safety |
| **Confirmed Bug** | A clear expectation was contradicted, with evidence |

Blocked requests, unclear results and layout measurements are never counted as bugs.

---

## Safe by design

- **Deny by default:** only read requests leave the browser, plus a short approved list.
- **Nothing is deleted:** delete-type actions and DELETE requests are never performed.
- **Nothing is saved by accident:** Create and Save are blocked unless one controlled workflow is switched on for one page.
- **Permissions are left alone:** permission and access settings are never operated.
- **Dialogs are never confirmed:** warnings and confirmations are cancelled, not accepted.
- **Tokens are never stored.**

---

## The dashboard

- **New Test:** a four-step wizard (target, authentication, testing mode, viewport and limits).
- **Live Execution:** the browser view with the current target, the action, and expected versus actual.
- **Results:** summary numbers, confirmed bugs with details and screenshots, tested elements, activity log.
- **Reports:** HTML, JSON and JUnit (for CI).

<!-- Speaker note: this is the best place for a live demo or screenshots. -->

---

## Architecture

```
Dashboard (React)  ─┐
Command line       ─┼─►  API server ─►  Orchestrator ─►  Run executor
                    │                                        │
                    │                                        ▼
                    │                          Browser controller (Playwright)
                    │                                        │
                    └◄── live events and frames ◄────────────┤
                                                             ▼
                                              SQLite + screenshots + reports
```

One Node.js process serves the API, the dashboard and the live event stream.

---

## Technology

| Layer | Technology |
|---|---|
| Language and runtime | TypeScript on Node.js |
| Browser automation | Playwright (Chromium) |
| Storage | SQLite |
| Dashboard | React + Vite |
| Validation | Zod |
| Tests | Vitest |
| Optional | AI summaries of findings |

---

## Quality of the tool itself

- 39 test files with 310 automated tests.
- The tests run a real browser against small fixture websites.
- Last complete run: 310 of 310 passed (on the safety branch, before the latest UI merge).
- Type checks and the dashboard build pass on the current branch.

---

## Tried on a real application

- Run against pages of an internal portal in read-only mode.
- Page data loaded through an approved list of read-only requests.
- Global navigation skipped in "test this page only" mode.
- Layout measurements were kept as observations and not reported as bugs.

---

## Current limits

- It works on what is visible; hidden or unusual custom controls may come back inconclusive.
- Permission settings are recognised by their wording, so unusual labels could be missed or over-blocked.
- The dashboard has no login of its own yet.
- The latest read-only validation on the real portal is still pending.

---

## Next steps

3. Decide how it appears in the common dashboard: a link, an embedded view, or their own screens using this API.
4. Then consider automatic discovery of the read-only requests each page needs.

---

## How to run it

```bash
npm install
npx playwright install chromium
npm run web:build
npm run serve      # dashboard and API on http://127.0.0.1:4000
npm run demo       # optional demo site on http://127.0.0.1:3000
```

---

# Questions
