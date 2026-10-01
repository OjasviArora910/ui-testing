# Architecture — Autonomous UI/UX QA Platform

## Principles
1. **Ground truth first.** A finding is a `defect` only with a basis (`deterministic | generic_rule | configured_rule | baseline | human`). Otherwise it is an `anomaly` and goes to review. Enforced three times: `FindingSchema` (Zod), `RuleRegistry.run` (rejects invalid findings), and a SQLite `CHECK` constraint.
2. **AI is advisory.** It may explain, prioritise, flag likely false positives, correlate, and drive the optional exploratory agent. Its output schema (`AIAnalysisSchema`, `.strict()`) has no field that can change a finding, so a reply containing `classification`, `basis`, `confirmed`... is rejected. "Confirmed" exists only as a human decision row.
3. **Application-independent.** No app-specific selectors. Semantic targeting (role+name > label > text > testId > attribute > CSS). App-specific expectations go in `qa.config.json` (`rules.custom`) or rule plugins (`rules.plugins`).
4. **Secrets never persist.** The user gives the JWT together with the URL (`RunRequest.auth = { token, location, key?, scheme? }`). The token is registered with the central `Redactor` on arrival and lives only in server memory for that run: `Orchestrator.launch` hands it to the `RunExecutor` through in-memory hooks. The persisted request is `toPersisted(request)`, which records only `authSource: 'token'` and `authLocation`. Playwright tracing is disabled for any authenticated run, because traces contain cookies and headers. Resuming a token run requires the token again. Server-side **auth profiles** (`qa.auth.json` → env var / file) remain an optional alternative for CI. A top-level `jwt`/`token`/`authorization` field is rejected. Collectors redact at capture time and the database redacts every string again before insert.
5. **Safety.** One `ActionGuard` gates the crawler, functional tests and the ReAct agent: destructive keywords, cross-origin navigation, payment fields, and — at network level — every write method (POST/PUT/PATCH/DELETE) unless explicitly enabled.

## Pipeline
```
Dashboard (web/, React+Vite) ──REST/SSE──> API (src/api) ──> Orchestrator (src/orchestrator)
  CREATED → AUTHENTICATING → DISCOVERING → TESTING → ANALYZING → REVIEW → REPORTING → COMPLETED   (+ ABORTED / ERROR)

  per page × viewport (TESTING):
    navigate → wait for idle → PageModel → visual check → axe + keyboard → functional tests (ActionGuard)
    → RuleContext → RuleRegistry (geometry, responsive, network, console, functional, a11y, visual, configured, plugins)
    → evidence (screenshot, crop, DOM, ARIA, geometry, network, console, visual diff, metadata; sha256) → SQLite
  ANALYZING: optional ReAct agent (exploratory mode) → AI analysis (advisory, Zod-validated)
  REPORTING: verdict + HTML/JSON/JUnit; regenerated after every human decision
```

## Layout
| Path | Responsibility |
|---|---|
| `src/shared` | Zod schemas (Finding, Auth, Viewport), `ConfigSchema`/`loadConfig`, `AuthProfileResolver`, `RunRequestSchema`, `Redactor` |
| `src/browser` | `BrowserController` (actions, inspection, request guard, tracing), auth injection, event collectors, in-page scripts |
| `src/discovery` | `PageModel` builder, same-origin crawler (limits, URL normalisation, dedupe, resumable) |
| `src/rules` | `Rule` plugin contract, `RuleRegistry`, declarative configured rules, `collectRuleContext` |
| `src/functional` | `ActionGuard`, button/link/form tests, synthetic data, action budget |
| `src/geometry` | overlap/clipping/off-screen/overflow/zero-size/small-target rules, legitimate-overlap detection, responsive rules |
| `src/network` | failed request / slow request / console error / console warning rules |
| `src/accessibility` | axe-core runner (+ duplicate-id and placeholder-only label checks), keyboard traversal check |
| `src/visual` | pixel diff (pixelmatch), baseline store, `VisualTester` (`NO_BASELINE_AVAILABLE` is never a failure) |
| `src/evidence` | hashed, content-addressed filesystem evidence store + capture helpers |
| `src/ai` | provider abstraction (OpenAI-compatible: OpenAI / Groq / Gemini; mock), strict schema, prompts, analyzer, evidence digest |
| `src/agent` | ReAct agent, tool schema, normalised action/state signatures, loop detector |
| `src/database` | SQLite schema + repository, review-state derivation, verdict |
| `src/reporting` | report data, HTML, JSON, JUnit |
| `src/orchestrator` | `Orchestrator` (start/resume/abort/timeout/progress/review), `RunExecutor` (lifecycle), `createPlatform` |
| `src/api` | REST + SSE server (also serves the built dashboard) |
| `src/cli.ts` | `serve`, `demo`, `run`, `runs`, `resume`, `baseline` |
| `demo-app/` | intentionally broken app + legitimate UI page + ground-truth catalogue |
| `web/` | React + Vite dashboard |

## Key design decisions
- **In-page scripts are strings**, not functions: bundlers (esbuild `__name`) otherwise inject helpers that don't exist in the page.
- **Header auth is same-origin only** (route interception), so tokens cannot reach third parties.
- **Actions return `ActionResult`** instead of throwing, giving uniform observability.
- **Functional writes are verified, not sent**: by default a form submission is observed client-side and the POST is aborted by the request guard (`functional.submitValidForms: false`).
- **Page-level network/console findings use the page-load window only**; problems triggered by clicking are reported by the functional rules, so nothing is reported twice.
- **Cancelled requests (`ERR_ABORTED`) and guard-blocked requests are not app failures.**
- **Resumability**: `runs.state_json` stores the crawl queue, tested `page|viewport` units, action budget and phase flags; `Orchestrator.resume()` continues from there and re-resolves the auth profile (the token itself is never persisted).
- **Verdict** is derived, never stored as truth: FAILED (human-confirmed bug or critical/major defect) > BLOCKED_PENDING_REVIEW (anomalies awaiting review) > PASS_WITH_WARNINGS (minor/info defects) > PASS.
