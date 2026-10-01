# Development session record and hand-over

This file records the session in which this platform was built (October 2026, with an AI coding assistant), so someone else can continue the work. It is a structured record of the conversation, not a raw transcript: what was asked, what was decided and why, what was built, what was verified, and what is left.

**If you are continuing this work:** read [Current state](#current-state) and [Next steps](#next-steps) first. The original product specification is reproduced in full in [Appendix A](#appendix-a--original-specification).

---

## Contents
1. [Starting point](#starting-point)
2. [Session timeline](#session-timeline)
3. [Decisions and their reasons](#decisions-and-their-reasons)
4. [Current state](#current-state)
5. [Bugs found and fixed during development](#bugs-found-and-fixed-during-development)
6. [Gotchas](#gotchas)
7. [Known risks in the unexecuted code](#known-risks-in-the-unexecuted-code)
8. [Next steps](#next-steps)
9. [How to resume with an AI assistant](#how-to-resume-with-an-ai-assistant)
10. [Appendix A — original specification](#appendix-a--original-specification)

---

## Starting point
The session started from a folder `qa-platform-phase1/qa-platform` that contained only **Phase 1 (browser foundation)**, about 785 lines:
- `src/shared/redactor.ts`, the central secret redactor.
- `src/shared/types.ts`, the Zod `FindingSchema` (a defect requires a basis), auth, viewport and bounding-box schemas.
- `src/browser/*`, a Playwright `BrowserController`, semantic locators, cookie/localStorage/sessionStorage/header auth, and network/console collectors.
- Three test files (25 tests). Empty directories existed for every later module.

The goal, given as a long specification prompt (Appendix A), was to build a complete, application-independent autonomous UI/UX QA platform in 15 phases.

---

## Session timeline

| # | User request | Outcome |
|---|---|---|
| 1 | "Analyse the codebase and tell me its purpose." | Explained: Phase 1 of an autonomous UI/UX QA platform; everything else was still empty directories. |
| 2 | Pasted the full specification (Appendix A) and asked to compare it with the code, list what is done and what is left, and give a plan before implementing. | Gap table: Phase 1 done; Phases 2–15 not started. Proposed a plan that moves the demo app earlier (it is the test target for every later phase) and the database before the AI phases. |
| 3 | "What is taken as input from the UI?" | Nothing yet: no UI or API existed. Listed the spec's dashboard inputs. Noted that "Testing Mode" was never defined in the spec, and that a JWT typed into the UI conflicts with run recovery. |
| 4 | "Shouldn't JWT tokens be taken from the backend? Reframe the plan as a proper AI engineer." | **Agreed and adopted.** Tokens are configured server-side as named auth profiles; the UI picks a profile name. Plan restructured into stages A (foundation), B (deterministic engine, no AI), C (advisory AI and agent), D (delivery). |
| 5 | "Simplify: what exactly is the final output and its purpose?" | Plain-language description of the product, its workflow and outputs. Asked for the AI key via environment variable, not chat. |
| 6 | "Create it completely now and give me instructions to run it." | Implemented phases 0–8, running each suite and fixing failures (see test results below). |
| 7 | (Mid-build) "Now continue, don't test, I will do it on my own." | Implemented phases 9–15 **without running their tests**; only ran the TypeScript typecheck. Wrote docs, Docker and CLI. |
| 8 | "Run this, give me the URL." | Built the dashboard and started the demo app (`http://127.0.0.1:3000`) and the dashboard/API (`http://127.0.0.1:4000`). No `.env`, so AI was off. |
| 9 | "I don't have a key yet; I want to see the frontend." | Explained that only the AI modes need the key; walked through a deterministic run in the dashboard. |
| 10 | "Create a repo, push this code, update .gitignore." | Hardened `.gitignore`, added `.gitattributes` (LF), `git init`, one commit. `gh` CLI was not installed, so the GitHub repo could not be created automatically. |
| 11 | Pasted terminal output showing `npm test` failures. | The output came from **before** the session's changes (it showed 3 test files and the old typecheck script). Gave the corrected commands: approve blocked install scripts, PowerShell env-var syntax, winget `--source winget`. |
| 12 | Gave `https://github.com/OjasviArora910/ui-testing.git`. | Pushed `main`. |
| 13 | "Update the README and push a docs folder with this whole chat session." | This file, plus README updates. |

---

## Decisions and their reasons

### Credentials stay on the server (auth profiles)
- **Decision:** the dashboard and API never accept a raw JWT. `qa.auth.json` (gitignored) defines named profiles: `{ location, key?, scheme?, source: { env } | { file } }`. The API rejects any request body containing `jwt`, `token`, `authorization`, `cookie`, `apikey`, `password` or `secret` keys, and `RunRequestSchema` is `.strict()`.
- **Why:** the browser is driven by the backend, so the frontend never needs the token. Keeping it off the UI avoids leaking it through browser memory, request logs or proxies. It also makes runs resumable after a restart: only the profile name is persisted, and the token is re-resolved when the run resumes.
- **Code:** `src/shared/authProfiles.ts`, `src/shared/runRequest.ts`, `src/api/server.ts`.

### Testing modes
The spec named a "Testing Mode" input but did not define it. Chosen values:
- **`deterministic`:** crawl, rules and functional tests, with no AI.
- **`ai_assisted`:** the same, plus advisory AI analysis of findings.
- **`exploratory`:** the same, plus the ReAct agent.

### Ground truth is enforced in three places
- `FindingSchema` (Zod) rejects a defect without a basis.
- `RuleRegistry.run` drops invalid findings and reports them as rule errors.
- A SQLite `CHECK (classification <> 'defect' OR basis IS NOT NULL)` constraint.

### The AI cannot change findings
`AIAnalysisSchema` is `.strict()` and has no `classification`, `basis`, `severity` or `confirmed` field, so a reply containing any of them is rejected. Analyses go only to the `ai_analyses` table. "Confirmed" exists only as a `human_decisions` row (`CONFIRM_BUG`).

### Safety
- **One `ActionGuard`** (`src/functional/actionGuard.ts`) is shared by the crawler, the functional tests and the agent.
- **Intent checks:** dangerous keywords (from config plus built-ins such as logout), cross-origin navigation, payment-looking fields.
- **Network check:** a request guard in `BrowserController` aborts every non-GET/HEAD/OPTIONS request and any same-origin URL whose path contains a dangerous keyword.
- **Forms:** submissions are verified client-side, and the write itself is blocked by default (`functional.submitValidForms: false`).
- **Agent:** reuses the same guard; its suspicions become anomalies, never defects.

### Avoiding duplicates and false positives
- **Page-level network/console rules** only see the page-load window. Errors caused by clicking are reported once, by the functional rules.
- **Not counted as failures:** cancelled requests (`ERR_ABORTED`) and requests blocked by the platform itself (`ERR_BLOCKED_BY_CLIENT`).
- **Legitimate overlap** (tooltip, dropdown, modal, popover, badge, fixed/sticky floating UI) is excluded from the overlap rule (`src/geometry/legit.ts`).
- **Heuristic checks produce anomalies, not defects:** off-screen elements, keyboard checks, slow requests, the agent's suspicions, buttons covered by floating UI.
- **`demo-app` includes a `/legit` page:** correct UI that looks risky. The suites assert it produces zero defects.

### Ordering changes from the spec
The demo app (spec Phase 14) was built right after discovery so every later phase could be tested against known defects. The database (12) was built before AI (10) and the agent (11).

### Verdict
Derived, never stored as truth:
- **FAILED:** a human-confirmed bug, or a critical/major defect.
- **BLOCKED_PENDING_REVIEW:** anomalies still await a human.
- **PASS_WITH_WARNINGS:** only minor/info defects remain.
- **PASS:** nothing active.

Reports are regenerated after every human decision.

### AI provider
One OpenAI-compatible adapter covers OpenAI, Groq and Gemini (Gemini through its OpenAI-compatible endpoint). Configuration is server-side environment variables only: `QA_AI_PROVIDER`, `QA_AI_API_KEY`, optional `QA_AI_MODEL` and `QA_AI_BASE_URL`. The key is registered with the central redactor. Tests use `MockProvider`.

---

## Current state

### Implemented
All 15 phases. The module map is in [ARCHITECTURE.md](../ARCHITECTURE.md), the per-phase table in [STATUS.md](../STATUS.md).

### Verified
- **Suites run green during development:**

  | Suite | Tests |
  |---|---|
  | `redactor` | 5 |
  | `schema` | 4 |
  | `browser` | 16 |
  | `config` | 8 |
  | `discovery` | 6 |
  | `rules` | 13 |
  | `functional` | 12 |
  | `accessibility` | 4 |
  | `visual` | 7 |

- **Typecheck:** `npx tsc --noEmit` and `npx tsc -p web/tsconfig.json` are clean.
- **Manual smoke check:** the dashboard built with `vite build web`. The demo app and the API/dashboard started and answered (`/api/health` and `/` returned 200). A full run was not observed end-to-end from the dashboard in this session.

### Not verified
- **Test files written but never executed:** `tests/database.test.ts`, `tests/ai.test.ts`, `tests/agent.test.ts`, `tests/reporting.test.ts`, `tests/e2e.test.ts`.
- **No live AI call has been made** (no key was available).
- **The Docker image has not been built.**

### Environment notes
- Developed on Windows 11 with Node 24 and Playwright 1.63 (Chromium 153).
- On a fresh `npm install`, npm may block the install scripts of `better-sqlite3` and `esbuild`. Approve them with `npm install-scripts approve better-sqlite3 esbuild`, then `npm install` again.
- The parent folder `qa-platform-phase1/` contains an unrelated Python `.venv`, which the project does not use. The git repository root is `qa-platform/`.
- Repository: https://github.com/OjasviArora910/ui-testing (branch `main`).

---

## Bugs found and fixed during development
These are worth knowing because similar mistakes are easy to reintroduce.

1. **Backslashes in in-page scripts.** In-page scripts are template-literal strings, so regex escapes must be doubled (`\\s+`). A shell heredoc silently dropped one backslash: `/\s+/` became `/s+/`, which turned "Forms" into "Form". Write these files with an editor, not a shell heredoc, and keep the doubling.
2. **Site-wide nav links used up the per-page link budget,** so page-specific links (the broken ones) were never tested. Fixed by sorting non-nav links first and sharing a run-wide `testedLinks` set.
3. **Playwright `networkidle` waits at least 500 ms,** which made the functional suite take minutes. Replaced with `settle()` and `waitForIdle()` based on the collector's in-flight request count.
4. **axe-core 4.x does not run `duplicate-id`, and treats a placeholder as an accessible name.** Added custom checks `a11y.duplicate-id` and `a11y.form-field-label` (placeholder-only labels) inside the axe script.
5. **The first full-page screenshot after load can be 2 px taller** than later ones. `VisualTester` takes a warm-up screenshot first.
6. **Dynamic text changed width,** so mask rectangles moved. Masked elements in the demo use fixed widths. In real apps, mask containers rather than inline text.
7. **Buttons covered by fixed/overlay UI** (cookie banners) are reported as anomalies, not defects (`coveredBy()` in `src/functional/helpers.ts`).
8. **Requests aborted by navigation** looked like network failures. They are now ignored.
9. **JUnit marked `a11y.axe` as passing** even when `a11y.*` findings existed, because axe emits sub-ids. Passing testcases are now decided per rule namespace.

---

## Gotchas
- **PowerShell vs bash:** `NAME=value npm test` is bash only. In PowerShell use `$env:NAME = "value"; npm test`.
- **Test browser:** tests use Playwright's Chromium by default. `QA_USE_SPARTICUZ=1` switches to the `@sparticuz/chromium` fallback, which is only useful in a sandbox where the Playwright CDN is blocked.
- **`.env` loading:** the npm scripts `qa`, `serve` and `demo` load `.env` with `node --env-file-if-exists=.env`, which needs Node 22.9+.
- **One run at a time** by default (`QA_MAX_CONCURRENT_RUNS`). The API has no user authentication and binds to `127.0.0.1`. Put it behind an auth proxy before exposing it.
- **Generated data:** `data/` holds the SQLite DB, evidence, reports and baselines, and is gitignored. Delete it to reset all runs.
- **Demo token:** `demo-app/server.ts` contains a fake demo JWT on purpose. It protects nothing, but GitHub secret scanning may flag it.

---

## Known risks in the unexecuted code
Places most likely to need adjustment when the unexecuted suites are first run:
- **`tests/e2e.test.ts`:**
  - It asserts every entry of `GROUND_TRUTH` in `demo-app/pages.ts`. If a rule fires on a different page than listed, or not at all because the action budget ran out, adjust the budget (`maxActions: 400`) or the ground truth. Don't weaken the rules.
  - It also requires zero defects on `/legit` across the whole pipeline (functional, axe, keyboard and network together). Earlier per-module suites passed this, but not the combined run.
- **`tests/agent.test.ts`:** `elId()` parses the observation format `e3 button "Name"` built in `ReactAgent.describe()`. If that format changes, update both.
- **`Orchestrator.approveBaseline`:** matches stored `visual-current` evidence by redacted page URL and viewport. Verify it after a run with no baseline.
- **`RunExecutor`:**
  - Abort is checked between units, not inside long functional loops, so STOP can take a few seconds.
  - The trace (`trace: true` by default) can be large on big runs.
- **Run duration:** `waitForIdle(slowRequestMs + 1000)` runs once per page × viewport. Pages that poll the network continuously will always wait about 4 s.
- **`web/vite.config.ts`:** relies on Vite replacing `__dirname` in config files (supported). It built successfully once.

---

## Next steps
1. **Run the unexecuted suites and fix failures,** in this order: `database`, `reporting`, `ai`, `agent`, then `e2e`. Update STATUS.md with the results.
2. **Do a full dashboard run against the demo app.** Review a few anomalies, check that the verdict changes, and approve a visual baseline. Then rerun and expect visual PASS.
3. **Add an AI key** (`.env`: `QA_AI_PROVIDER`, `QA_AI_API_KEY`) and run `ai_assisted`, then `exploratory`, against the demo. Watch for rejected AI outputs in the `ai_analyses` table and tune prompts or `QA_AI_MODEL` if needed.
4. **Build and run the Docker image** (`docker compose up --build`).
5. **Try it on a real staging app** with an auth profile. Expect to tune `ignoredEndpoints`, `visualThresholds.maskSelectors` and `dangerousActions.keywords` in `qa.config.json`.
6. **Known gaps you may want to close:**
   - iframes and shadow DOM are not inspected.
   - No API authentication.
   - Element crops are limited to 12 per page × viewport.
   - No CI workflow file yet. A GitHub Actions job would need `npx playwright install --with-deps chromium`, then `npm test`.

---

## How to resume with an AI assistant
Give the assistant this file, STATUS.md and ARCHITECTURE.md, then a task such as: *"Run `npx vitest run tests/database.test.ts`, fix any failures without weakening the ground-truth or safety rules, and update STATUS.md."*

Constraints that must be preserved:
- Never accept credentials through the UI or API.
- Never let AI output change a finding's classification or basis.
- Every defect needs a basis.
- No destructive actions; all actions go through `ActionGuard`.
- No app-specific selectors in core code.

---

## Appendix A — original specification
The full specification prompt given at the start of the session, unchanged.

````markdown
# ROLE

Act as a senior Software Architect, AI Engineer, QA Automation Engineer, and Playwright expert.

Your job is to **BUILD the application**, not merely explain how to build it.

# PRODUCT

Build a reusable **Autonomous UI/UX QA Testing Platform**.

Input:

* Web application URL
* Optional JWT
* JWT location: cookie / localStorage / sessionStorage / Authorization header
* Optional custom rules
* Optional visual baseline

The platform must work against unfamiliar web applications without application-specific Playwright scripts or source-code dependency.

Core pipeline:

```text
URL/Auth
→ Orchestrator
→ Playwright BrowserController
→ UI Discovery
→ Deterministic Rules + Functional Tests
→ Geometry/Responsive/Accessibility/Network/Console/Visual
→ Evidence
→ AI Analysis
→ Optional ReAct Exploration
→ Human Review
→ HTML/JSON/JUnit Reports
```

# CRITICAL GROUND-TRUTH POLICY

Never claim something is a defect merely because it "looks wrong."

Every finding must have one of:

```text
deterministic
generic_rule
configured_rule
baseline
human
```

If insufficient evidence exists, classify it as:

```text
anomaly
```

and send it to review.

AI may explain, classify, prioritize, and flag likely false positives.

AI may NOT independently confirm a defect, modify rules, modify baselines, or bypass safety restrictions.

# TECH STACK

Use:

* React + TypeScript + Vite
* Node.js + TypeScript
* Playwright
* axe-core
* SQLite
* Zod
* Vitest
* Docker
* AI provider abstraction supporting Gemini/Groq/OpenAI-compatible APIs

Use clean modular TypeScript.

Do not create a giant file.

# ARCHITECTURE

```text
Dashboard
   ↓ REST/SSE
API Server
   ↓
Orchestrator
   ├── Auth
   ├── BrowserController
   ├── Discovery
   ├── Functional Tests
   ├── Rule Engine
   ├── Geometry
   ├── Responsive
   ├── Accessibility
   ├── Network/Console
   ├── Visual
   ├── Evidence
   ├── AI
   └── Optional ReAct Agent
           ↓
      Findings Pipeline
           ↓
   SQLite + Evidence Store
           ↓
   Human Review + Reports
```

# REQUIRED MODULES

```text
/browser
/discovery
/rules
/functional
/geometry
/visual
/accessibility
/network
/ai
/agent
/evidence
/reporting
/database
/orchestrator
/api
/shared
```

Frontend:

```text
/web
```

Demo:

```text
/demo-app
```

Tests:

```text
/tests
```

# BROWSER CONTROLLER

Create a reusable Playwright abstraction supporting:

```text
navigate
click
fill
select
check
uncheck
hover
press
scroll
reload
back
forward
screenshot
DOM inspection
ARIA inspection
bounding boxes
computed styles
visible elements
interactive elements
network inspection
console inspection
```

Do NOT create application-specific test scripts.

Use semantic selectors first:

```text
role
accessible name
label
text
test id
semantic attributes
CSS fallback
```

# AUTHENTICATION

Support:

```text
cookie
localStorage
sessionStorage
Authorization header
```

JWT/secrets must be registered with a central redactor.

Never store or output raw:

```text
JWT
cookies
Authorization headers
API keys
secrets
```

# UI DISCOVERY

Automatically discover:

* routes/pages
* buttons
* links
* inputs
* forms
* selects
* checkboxes
* radios
* dialogs
* menus
* tabs
* accordions
* tables
* images
* headings
* interactive elements

Build a structured `PageModel`.

Track:

```text
type
role
accessible name
text
selector
visibility
enabled state
bounding box
```

Implement same-origin crawling with limits.

# FUNCTIONAL QA

Automatically test safe actions.

Buttons:

* visibility
* enabled state
* clickability
* observable result
* JS exceptions
* failed network requests

Links:

* clickability
* navigation
* obvious 404/500

Forms:

* required fields
* empty submission
* invalid input
* validation messages
* safe valid submission where possible

Use synthetic data.

Never automatically perform destructive actions such as:

```text
delete
purchase
payment
account deletion
irreversible operations
```

Implement a centralized `ActionGuard` used by BOTH functional testing and the AI agent.

# RULE ENGINE

Implement plugin architecture:

```ts
interface Rule {
  id: string;
  name: string;
  category: string;
  severity: string;
  description: string;
  basis: Basis;
  evaluate(context: RuleContext): Promise<Finding[]>;
}
```

Adding a rule must NOT require modifying the orchestrator.

Initial rules should cover:

```text
overlap
text clipping
off-screen elements
horizontal overflow
container overflow
zero-size visible elements
small interactive targets
network failures
console errors
functional failures
accessibility findings
```

Recognize legitimate overlap:

```text
tooltip
dropdown
modal
popover
badge
floating UI
```

# RESPONSIVE QA

Default:

```text
1440x900
768x1024
390x844
```

Test:

```text
overflow
clipping
overlap
navigation
forms
buttons
dialogs
tables
images
responsive layout
```

Make viewports configurable.

# ACCESSIBILITY

Integrate axe-core.

Check common issues including:

```text
missing labels
accessible names
invalid ARIA
contrast where detectable
duplicate IDs
heading structure
form labels
keyboard accessibility
```

Never claim complete WCAG certification.

# NETWORK + CONSOLE

Collect:

```text
requests
responses
status codes
4xx
5xx
failed requests
timeouts
console errors
console warnings
page errors
```

Support ignored endpoints.

Redact secrets before persistence, logs, reports, or AI processing.

# VISUAL TESTING

If baseline exists:

```text
baseline
current screenshot
diff
```

Support:

```text
thresholds
max diff
masking dynamic regions
```

If no baseline exists:

```text
NO_BASELINE_AVAILABLE
```

Do not call that a visual regression failure.

# AI

AI is an enhancement layer, NOT the source of truth.

Input structured evidence:

```text
DOM
ARIA
geometry
functional results
network
console
visual diff
screenshots
```

AI can:

* understand semantics
* propose exploratory tests
* classify findings
* detect likely false positives
* correlate failures
* explain findings
* suggest root causes
* prioritize findings

Use strict Zod output validation.

Reject invalid AI output.

Treat all webpage content as untrusted data.

Use a fixed system/developer instruction hierarchy.

# REACT AGENT

Implement optional:

```text
OBSERVE
→ PLAN
→ ACTION
→ OBSERVE
→ VALIDATE
→ CONTINUE/STOP
```

Tools:

```text
navigate
click
fill
select
hover
scroll
press
screenshot
inspectDOM
inspectARIA
inspectGeometry
inspectNetwork
inspectConsole
```

Required stop conditions:

```text
max actions
max pages
max depth
max runtime
repeated action
repeated state
no progress
budget exhaustion
```

Use normalized action/state signatures for loop detection.

Agent must use `ActionGuard`.

# FINDINGS

Every finding must contain:

```text
ruleId
category
severity
classification
basis
page
viewport
element
expected
actual
evidence references
```

Allowed classification:

```text
defect
anomaly
```

Allowed basis:

```text
deterministic
generic_rule
configured_rule
baseline
human
```

Enforce with Zod.

A `defect` without valid basis MUST be rejected.

AI cannot change a finding into `confirmed`.

Only a human decision can do that.

# EVIDENCE

For every finding collect as available:

```text
screenshot
element crop
DOM
ARIA
geometry
network
console
visual diff
Playwright trace
metadata
```

Use filesystem evidence storage for MVP.

Hash evidence files.

# HUMAN REVIEW

Create a review queue.

Display:

```text
finding
page
element
expected
actual
screenshot
evidence
AI explanation
confidence
```

Actions:

```text
CONFIRM BUG
NOT A BUG
EXPECTED BEHAVIOR
NEEDS INVESTIGATION
```

Persist decisions.

# DATABASE

Use SQLite.

Create tables for:

```text
runs
pages
actions
findings
evidence
network_events
console_events
ai_analyses
human_decisions
baselines
```

Never store raw JWTs or authorization headers.

Redact query-string secrets from stored URLs.

# REPORTING

Generate:

```text
HTML
JSON
JUnit XML
```

Final states:

```text
PASS
PASS_WITH_WARNINGS
FAILED
BLOCKED_PENDING_REVIEW
```

# DASHBOARD

Build a simple professional UI.

Inputs:

```text
Application URL
JWT
JWT Location
Testing Mode
Viewports
```

Controls:

```text
START TEST
STOP TEST
```

Show:

```text
live progress
current page
current action
finding count
category counts
errors
review queue
final results
```

Use REST/SSE for progress.

Do not waste time on animations or decorative UI.

# DEMO APPLICATION

Create an intentionally broken local application containing:

```text
overlapping text
overlapping button
clipped text
horizontal overflow
broken link
404
500
console error
missing form label
invalid validation
responsive issue
modal
intentional tooltip overlap
dynamic content
slow API
```

Also create legitimate UI examples to measure false positives.

# CONFIG

Create:

```text
qa.config.json
```

Support:

```text
maxPages
maxActions
maxDepth
timeouts
viewports
rules
ignoredEndpoints
dangerousActions
visualThresholds
```

Support application-specific rules without modifying core code.

# ORCHESTRATOR

Implement a central run lifecycle:

```text
CREATED
→ AUTHENTICATING
→ DISCOVERING
→ TESTING
→ ANALYZING
→ REVIEW
→ REPORTING
→ COMPLETED
```

Support:

```text
start
progress
abort
timeout
budgets
cleanup
```

Every run must be recoverable from persisted state.

# IMPLEMENTATION STRATEGY

Do NOT dump the entire implementation into one response.

Work directly in the repository.

First inspect the repository.

Then create/update:

```text
ARCHITECTURE.md
STATUS.md
qa.config.json
```

`STATUS.md` must always contain:

```text
current phase
completed work
changed files
tests executed
test results
known limitations
next phase
commands to run
```

Then implement phases sequentially:

```text
1 Browser foundation
2 Discovery
3 Rule engine
4 Functional testing
5 Geometry
6 Network/console
7 Accessibility
8 Visual
9 Evidence
10 AI
11 Agent
12 Human review
13 Reporting
14 Demo application
15 End-to-end integration
```

# IMPORTANT EXECUTION RULE

Do NOT spend the majority of the response explaining code.

Prioritize:

```text
inspect repository
implement
run tests
fix failures
update STATUS.md
```

After each phase:

1. Run tests.
2. Fix failures.
3. Update documentation.
4. Update STATUS.md.
5. Continue automatically to the next phase if the exit criteria pass.

If the context/output limit is approaching:

1. Finish the current safe unit of work.
2. Save all progress to the repository.
3. Update `STATUS.md`.
4. Do NOT restart or rewrite completed work.

When continuing, read `STATUS.md` first and resume from the recorded phase.

Do not repeatedly ask me for permission between phases unless a decision genuinely requires human input.

# QUALITY BAR

Code must be:

* typed
* modular
* testable
* secure
* observable
* maintainable
* provider-independent
* application-independent

Avoid:

* hardcoded application selectors
* giant files
* fake implementations
* TODO-only placeholders
* pretending visual correctness exists without a baseline
* AI-only testing
* unvalidated AI output
* secrets in logs
* destructive autonomous actions

Every important behavior must have automated tests.

# FIRST ACTION

Before writing implementation code:

1. Inspect the repository.
2. Determine existing technologies/files.
3. Reuse useful existing code.
4. Create the architecture/status documentation.
5. Identify the smallest Phase 1 implementation.
6. Implement Phase 1.
7. Run its tests.
8. Fix failures.
9. Update `STATUS.md`.

Then continue through the phases without rebuilding completed work.

The goal is a **real working autonomous QA product**, not a tutorial or prototype consisting of disconnected examples.
````

**Deviation from the original spec:** the dashboard does not take a raw JWT or JWT location. Following the user's direction in timeline step 4, it takes an **auth profile name**. The location and secret source are configured on the server (`qa.auth.json`).
