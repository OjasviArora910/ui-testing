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

## Dynamic test selection
The functional part of TESTING is no longer "every suite on every page". A small layer in `src/dynamic` sits above the existing testers:
```
PageModel -> classifyPage (detection) -> selectTests (selection) -> existing testers -> observer -> verifier -> classifyResult -> evidence + report
```
- **Detection and selection are separate.** `classifyPage` only says what is present (`LOGIN_AUTH`, `FORM`, `SEARCH`, `DASHBOARD`, `TABLE_LIST`, `MODAL_DIALOG`, `NAVIGATION`, `MARKETING_CONTENT`, `UNKNOWN_GENERAL`; several can apply), each with a confidence and the signals that fired. `selectTests` turns that into a `TestPlan` with `selected` and `skipped` scenarios, each with a reason. Both are pure and deterministic; no LLM is involved.
- **The plan drives the existing testers.** `runFunctionalTests` runs only the suites the plan names, on the elements it names: `testForms` in `full` or `login` mode (search boxes and inputs without a submit control are never submitted), `testButtons` on the chosen controls (tabs, filters, expandables, pagination, and at most `dynamic.maxGenericButtons` buttons of unclear intent), plus `testSearch` and `testModals`. Without a plan (`dynamic.enabled: false`) the previous generic behaviour is unchanged.
- **Classification.** `classifyResult` names each executed test `BUG | WARNING | EXPECTED | NEEDS_REVIEW | BLOCKED_BY_SAFETY`. BUG and WARNING are still `defect` findings with a basis and NEEDS_REVIEW is still an `anomaly`, so principle 1 is untouched. EXPECTED and BLOCKED_BY_SAFETY are not findings; every executed test is stored in `test_results` with its page type, reason, confidence, expected, actual and classification.
- **No manufactured certainty.** "The expected change did not happen" is a failure only when the intent is HIGH confidence; otherwise it is NEEDS_REVIEW. "Nothing visibly happened" is never a failure on its own. A failure the tester reports with LOW confidence is downgraded to an anomaly before it reaches the rules.
- **Safety blocks are not passes.** When ActionGuard aborts a request an action sent, the verifier returns `BLOCKED` and the result is `BLOCKED_BY_SAFETY`: the UI interaction happened, the workflow is unverified.
- **Evidence follows the finding.** A functional finding carries `context.resultId`; the executor attaches the before screenshot, the after/error-state screenshot and an `action-trace` (only that action's requests, console lines and changes) instead of page-wide dumps taken after the page was reset.
- **Two tracks, never mixed.** Every finding is either UI/UX or accessibility (`trackOf`: category `accessibility` or an `a11y.` rule id). `classifyFinding` labels UI/UX findings BUG / WARNING / NEEDS_REVIEW and every accessibility finding ACCESSIBILITY, whatever its severity; a control can work (its interaction test is EXPECTED) and still have an accessibility finding. Summary counts, severities, the dashboard tabs, the HTML report sections and JUnit failures are computed per track. Accessibility takes part in the verdict only when `accessibility.failRun` is true (default false). A human-confirmed finding always counts.
- **Proof before BUG.** Overlap is reported only when the page itself shows the content of two unrelated elements rendered at the same place (`src/geometry/probe.ts`: text line boxes, ancestor clipping, opacity, hit-testing); composition (control inside a field, stacked layers, floating UI) is not overlap. The observer records the control's state, the region it governs, layout, visible text, state attributes, theme, form values, native dialogs and popups, so a correct state change is EXPECTED. An interaction defect with no evidence of its own is downgraded to review.

## Layout
| Path | Responsibility |
|---|---|
| `src/shared` | Zod schemas (Finding, Auth, Viewport), `ConfigSchema`/`loadConfig`, `AuthProfileResolver`, `RunRequestSchema`, `Redactor` |
| `src/browser` | `BrowserController` (actions, inspection, request guard, tracing), auth injection, event collectors, in-page scripts |
| `src/discovery` | `PageModel` builder, same-origin crawler (limits, URL normalisation, dedupe, resumable) |
| `src/rules` | `Rule` plugin contract, `RuleRegistry`, declarative configured rules, `collectRuleContext` |
| `src/dynamic` | page/component classifier, test selector (`TestPlan` with selected/skipped + reasons), result classifier |
| `src/functional` | `ActionGuard`, button/link/form/search/modal tests, intent, observer, verifier, synthetic data, action budget |
| `src/geometry` | overlap/clipping/off-screen/overflow/zero-size/small-target rules, legitimate-overlap detection, responsive rules, broken/distorted image, stacked duplicates, spacing/alignment heuristics (`consistency.ts`) |
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
- **Verdict** is derived, never stored as truth: FAILED (human-confirmed bug or critical/major defect) > BLOCKED_PENDING_REVIEW (anomalies awaiting review) > PASS_WITH_WARNINGS (minor/info defects) > PASS. Accessibility findings are left out unless `accessibility.failRun` is set.
