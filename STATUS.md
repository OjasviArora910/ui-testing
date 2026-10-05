# STATUS

## Current phase
**All 15 phases implemented.** Phases 0–8 were implemented and their test suites run green. Phases 9–15 (evidence, AI, agent, database, reporting, orchestrator/API/dashboard/Docker, e2e) are implemented and type-check cleanly, but **their test suites were written and NOT executed** (the user asked to run them personally).

## Dynamic test selection (added after phase 15)
Implemented and tested. See "Dynamic test selection" in ARCHITECTURE.md and README.md.
- `src/dynamic`: page/component classifier, test selector (selected + skipped with reasons), result classifier (`BUG | WARNING | EXPECTED | NEEDS_REVIEW | BLOCKED_BY_SAFETY`).
- `src/functional`: runner, forms and buttons are plan-aware; new `search.ts` and `modal.ts`; ActionGuard-blocked requests give `BLOCKED` instead of a pass; "expected change did not happen" fails only for HIGH-confidence intent.
- Observer fix: `textChanged` compared the body text length with the length of a digest string, so it was almost always true and most clicks were verified as "something changed". It now compares text lengths.
- New rules in `src/geometry/consistency.ts`: `image.broken`, `image.distorted`, `layout.stacked-duplicate`, `consistency.spacing`, `consistency.alignment` (the last three are review-only).
- Evidence: functional findings carry the before/after screenshots and an action trace of the action that produced them.
- Accessibility: separate track; `accessibility.failRun` (default false) decides whether it affects the verdict. Run form has Off / Report separately / Required.
- Storage: migration 2 adds `test_results`, `pages.decision_json`, `findings.context_json`.
- Demo app: `/marketing`, `/login`, `/dashboard`; `DYNAMIC_TRUTH` in `demo-app/pages.ts` is the ground truth for detection and selection.
- Dashboard: "Dynamic test selection" panel (Detected / Selected / Skipped / results per page), classification badge on findings. HTML report has the same section.

Not done: the live simulation does not show the scenario reason; hamburger menus are only exercised when `functional.allViewports` is on (functional tests run on the first viewport); no LLM assistance for `UNKNOWN_GENERAL` pages.

## Completed work
| Phase | Status | Notes |
|---|---|---|
| 0 Config/auth | done, tested (auth change in step 15 not yet run) | `loadConfig` (Zod), one-time token with the URL (memory only, never stored; trace disabled), optional server-side `AuthProfileResolver`, strict `RunRequestSchema` |
| 1 Browser foundation | done, tested | + request guard, nav status, structure collector, element ids/parents, cheap `settle`, `waitForIdle` |
| 2 Discovery | done, tested | `PageModel`, same-origin crawler (limits, normalisation, dedupe, resume) |
| 14 Demo app (moved up) | done | broken pages + `/legit` false-positive page + `/danger` + `/a11y` + `/account` (auth) + ground truth |
| 3 Rule engine | done, tested | plugin registry, severity overrides, disable, declarative configured rules, plugin modules |
| 4 Functional | done, tested | `ActionGuard` (UI + network level), buttons, links, forms, synthetic data, budget |
| 5 Geometry/responsive | done, tested | overlap (legit tooltip/dropdown/modal/popover/badge/floating), clipping, off-screen, overflow, container overflow, zero-size, small targets, table/image/dialog/navigation |
| 6 Network/console | done, tested | failed/slow requests, console errors/warnings, ignored endpoints |
| 7 Accessibility | done, tested | axe-core + duplicate-id + placeholder-only labels + keyboard traversal |
| 8 Visual | done, tested | pixelmatch diff, thresholds, masking, per-viewport baselines, NO_BASELINE_AVAILABLE |
| 9 Evidence | done, untested | sha256 content-addressed store, page + element evidence |
| 10 AI | done, untested | OpenAI-compatible provider (OpenAI/Groq/Gemini), strict schema, retry-once, injection sanitising, budgets |
| 11 Agent | done, untested | ReAct loop, tool schema, ActionGuard, all stop conditions, normalised signatures |
| 12 Database + review | done, untested | 10 tables, redaction on insert, CHECK constraints, decisions, verdict |
| 13 Reporting | done, untested | HTML (self-contained, escaped), JSON, JUnit |
| 15 Integration | done, untested | orchestrator lifecycle/abort/timeout/resume, REST+SSE API, React dashboard, CLI, Docker |

## Changed files
`package.json, tsconfig.json, qa.config.json, qa.auth.example.json, .env.example, .gitignore, .dockerignore, Dockerfile, docker-compose.yml, README.md, ARCHITECTURE.md, STATUS.md`
`src/shared/{config,authProfiles,runRequest}.ts` · `src/browser/{inpage,types,controller,collectors}.ts`
`src/discovery/*` · `src/rules/*` · `src/functional/*` · `src/geometry/*` · `src/network/*` · `src/accessibility/*` · `src/visual/*` · `src/evidence/*` · `src/ai/*` · `src/agent/*` · `src/database/*` · `src/reporting/*` · `src/orchestrator/*` · `src/api/*` · `src/cli.ts`
`demo-app/{pages,server}.ts` · `web/**` · `tests/*.test.ts`, `tests/helpers/launch.ts`

## Tests executed / results
Executed during development (all green at the time): `browser` 16, `config` 8, `discovery` 6, `rules` 13, `functional` 12, `accessibility` 4, `visual` 7, `redactor`/`schema` (Phase 1).
`npx tsc --noEmit` and `npx tsc -p web/tsconfig.json`: clean.
**Not executed at that time:** `database`, `ai`, `agent`, `reporting`, `e2e` test files.

**After the dynamic-selection work:** all 17 suites pass (151 tests) when run serially with `npx vitest run --no-file-parallelism`, including `database`, `ai`, `agent`, `reporting`, `e2e` and the new `dynamic` suite. Run in parallel (plain `npm test`) on a small machine, browser suites can hit their 60 s timeouts because every file launches its own Chromium; that is load, not a defect. The e2e suite takes about 12 minutes.

## Known limitations
- Iframes and shadow DOM are not traversed; accessible names are an approximation (axe is authoritative).
- Keyboard and overlap heuristics can produce anomalies (by design, never defects) on unusual UIs.
- Screenshots cannot be redacted; they stay on local disk and are sent to the AI only if `ai.sendScreenshots` is true.
- Slow-request detection waits at most `network.slowRequestMs + 1s` per page load.
- One run at a time by default (`QA_MAX_CONCURRENT_RUNS`). No user accounts on the API: bind to localhost or put it behind your own auth proxy.
- Gemini is used through its OpenAI-compatible endpoint; default model names may need `QA_AI_MODEL`.

## Next phase
A live smoke test with your AI key (AI-assisted and exploratory modes have only been run against the mock provider).

## Commands
See README.md. Hand-over notes and session history: docs/SESSION.md.
