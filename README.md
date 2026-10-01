# Autonomous UI/UX QA Platform

Point it at a web app URL. It crawls the site with a real browser and tests buttons, links and forms safely. It checks layout, responsiveness, accessibility, network/console errors and visual regressions. It stores evidence for every problem, and then uses AI to explain and prioritise the findings. A defect is only reported when a rule, measurement, baseline or human backs it up. Anything weaker goes to a human review queue.

> **Picking this project up?** Read [docs/SESSION.md](docs/SESSION.md) first. It records what was built, the decisions made, what is tested and what is not, and the next steps. Then read [STATUS.md](STATUS.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Project status
- All 15 planned phases are implemented. Backend and dashboard typecheck cleanly.
- Test suites for phases 1–8 (browser, config, discovery, rules, functional, accessibility, visual) passed during development.
- Test suites for phases 9–15 (`database`, `ai`, `agent`, `reporting`, `e2e`) are written but have **not been run yet**. Run them first, see [Tests](#tests).
- AI features need an API key (not yet configured). Everything else works without one.

## Requirements
- Node.js 22.9+ (developed on Node 24)
- Chromium for Playwright: `npx playwright install chromium`
- Windows, macOS or Linux. Commands below are given for PowerShell and bash where they differ.

## Install
```bash
git clone https://github.com/OjasviArora910/ui-testing.git
cd ui-testing
npm install-scripts approve better-sqlite3 esbuild   # npm may block these native/install scripts; both are required
npm install
npx playwright install chromium
```
If `npm install` warns that install scripts were blocked, run the `approve` line and then `npm install` again. Without them, the SQLite database (better-sqlite3) and the dashboard build (esbuild/vite) fail.

## Quick start (demo app + dashboard)
Use two terminals.

```bash
# terminal 1 – the intentionally broken demo app on http://127.0.0.1:3000
npm run demo

# terminal 2 – build the dashboard once, then start API + dashboard on http://127.0.0.1:4000
npm run web:build
npm run serve
```
Open http://127.0.0.1:4000, enter `http://127.0.0.1:3000`, choose a mode and viewports, then click **START TEST**.

For dashboard development with hot reload, keep `npm run serve` running and use `npm run dev:web` (http://localhost:5173, proxies `/api` to :4000).

## Logged-in apps (JWT)
Give the token together with the URL. In the dashboard's **Login** section, choose **Use a JWT / access token**, paste the token, and pick where the app expects it:

| Location | What the platform does | Optional name field |
|---|---|---|
| Cookie | sets a cookie on the app's domain before the first page load | cookie name (default `token`) |
| localStorage / sessionStorage | writes the key before the app's scripts run | storage key (default `token`) |
| Authorization header | adds the header to same-origin requests only (never to third parties) | header name (default `Authorization`), scheme (default `Bearer`) |

**How the token is protected:**
- It is used **only in server memory** for that one run. It is never written to the database, evidence, reports, logs or the run record (only "token, location=cookie" is recorded).
- The dashboard field is masked, excluded from autofill, and cleared right after START TEST. The API never sends it back.
- It is registered with the central redactor immediately, so if the app echoes it into the page, console or URLs, the copy is replaced with `[REDACTED]`.
- Playwright tracing is switched off automatically for runs with credentials, because traces record cookies and headers.
- Screenshots cannot be redacted. If an app displays the token on screen, it will appear in screenshots (stored on local disk only).
- Because the token is not stored, **resuming** an interrupted token run asks you to paste it again.
- Keep the server on localhost (the default) or use HTTPS when the dashboard and server are on different machines, since the token travels in the start request.

**From the command line or CI**, put the token in an environment variable and name it. Never pass the token itself as an argument, because it would end up in shell history:
```powershell
$env:APP_TOKEN = "<token>"
npm run qa -- run --url https://staging.example.com --token-env APP_TOKEN --token-location cookie --token-key session
```

**Optional: server-side auth profiles** (for shared or CI setups). Define named profiles in `qa.auth.json` (gitignored; see `qa.auth.example.json`) whose secret comes from an env var or mounted file. Then pick the profile in the dashboard, or pass `--profile <name>` on the CLI. `npm run demo` prints the demo app's public, harmless token for trying this out.

## AI (your key)
Put them in a `.env` file (copy `.env.example`; the npm scripts load it automatically), or set them in the shell:
```powershell
$env:QA_AI_PROVIDER = "gemini"     # or groq | openai | openai-compatible
$env:QA_AI_API_KEY  = "<your key>"
# optional: $env:QA_AI_MODEL = "gemini-2.5-flash"
npm run serve
```
On startup the server prints which provider/model is active. The **AI-assisted** and **Exploratory** modes are enabled in the dashboard only when AI is configured.

## Command line / CI
```bash
npm run qa -- run --url http://127.0.0.1:3000 --mode deterministic
npm run qa -- run --url https://staging.example.com --token-env APP_TOKEN --token-location header --mode ai_assisted --max-pages 30
npm run qa -- run --url https://staging.example.com --profile staging-admin   # server-side auth profile
npm run qa -- runs                      # list runs
npm run qa -- resume <runId>            # continue an interrupted run
npm run qa -- baseline --run <runId> --page http://127.0.0.1:3000/legit --viewport desktop   # approve visual baseline
```
Exit codes: `0` PASS / PASS_WITH_WARNINGS, `1` FAILED, `2` BLOCKED_PENDING_REVIEW, `3` error.

Reports are written to `data/runs/<runId>/report.html | report.json | report.xml` (JUnit). They are also available from the dashboard.

## Docker
```bash
cp qa.auth.example.json qa.auth.json     # edit profiles
# put QA_AI_PROVIDER / QA_AI_API_KEY / QA_JWT_* in .env
docker compose up --build
```
- Dashboard and API: http://127.0.0.1:4000
- Demo app: http://127.0.0.1:3000 (inside compose, test it as `http://demo:3000`)
- Data is persisted in `./data`.

## Tests
```bash
npm test                 # all suites (they launch Chromium; the e2e suite takes a few minutes)
npx vitest run tests/rules.test.ts     # one suite
npm run typecheck
```
Tests use Playwright's Chromium. In PowerShell, set environment variables with `$env:NAME = "value"; npm test`. The bash form `NAME=value npm test` does not work in PowerShell.

Suggested order for a first run of the not-yet-executed suites:
```bash
npx vitest run tests/database.test.ts tests/reporting.test.ts tests/ai.test.ts   # fast, mostly no browser
npx vitest run tests/agent.test.ts                                               # browser + mock LLM
npx vitest run tests/e2e.test.ts                                                 # full pipeline, several minutes
```

## Repository layout
```
src/          backend (see ARCHITECTURE.md for the module map)
web/          React + Vite dashboard
demo-app/     intentionally broken app + legitimate-UI page used as ground truth
tests/        vitest suites
docs/         project history and hand-over notes (SESSION.md)
```

## Configuration
`qa.config.json` covers limits (`maxPages`, `maxActions`, `maxDepth`), timeouts, viewports, rules (disable, severity overrides, declarative `custom` rules, `plugins`), `ignoredEndpoints`, `dangerousActions`, `visualThresholds` (incl. `maskSelectors` for dynamic regions), and functional/accessibility/network/geometry/AI/agent settings. All of it is validated by Zod at startup.

Custom rule example (no code change needed):
```json
"rules": { "custom": [ { "id": "app.cookie-banner", "name": "Cookie banner present", "type": "selector-exists", "selector": "#cookie-banner", "pages": ["/*"] } ] }
```
A plugin is a module listed in `rules.plugins` that default-exports one or more `Rule` objects (see `src/rules/types.ts`).

## Workflow
1. **Start a run.** Enter a URL. If it needs login, paste the token and choose where it goes. Pick a mode and viewports, then click START TEST. Progress streams live.
2. **Read the results.** Defects come with a basis and evidence. Anomalies land in the **Review queue**.
3. **Review anomalies.** For each one choose CONFIRM BUG, NOT A BUG, EXPECTED BEHAVIOR or NEEDS INVESTIGATION. Each decision is persisted, and the verdict and reports are regenerated.
4. **Visual baselines.** The first run reports `NO_BASELINE_AVAILABLE`, which is not a failure. Approve a screenshot as the baseline, and later runs compare against it.
