# AGENTS.md — Fork & Module Maintenance Guide

This document is the operating manual for AI agents and maintainers working on this repository. It defines repository conventions, the upstream sync workflow, and architectural guidelines for extending existing modules or adding new custom claimers.

---

## 1. Repository & Branch Topology

* **Upstream:** `https://github.com/feldorn/free-games-claimer` (official base)
* **Origin (Fork):** `https://github.com/LoginRs99/free-games-claimer`
* **Active Working Branch:** `custom/alienware`

### Branch Structure

```text
upstream/main (feldorn/free-games-claimer)
       │
       ▼  (fast-forward only)
   main (origin/main — 100% clean mirror of upstream/main)
       │
       ▼  (clean rebase)
custom/alienware (origin/custom/alienware — custom Alienware Arena stack)
```

1. **`main`:** Pure upstream mirror. **NEVER** commit custom features or fork-specific changes directly onto `main`. It must only track `upstream/main` via fast-forward merges.
2. **`custom/alienware`:** The primary custom feature branch. Houses the Alienware Arena module, its tests, and necessary integration glue in the shared configuration and Web-UI.
3. **`backup/*`:** Local safety checkpoint branches (e.g., `backup/pre-upstream-sync`) created prior to any history rewrite or rebase operation.

---

## 2. Upstream Synchronization Workflow

When upstream releases updates, sync `custom/alienware` cleanly by rebasing rather than creating merge commits. Follow this exact sequence:

### Step 1: Create a Safety Checkpoint Branch
Always save the current HEAD before any rebase:
```bash
git branch backup/pre-sync-$(date +%Y%m%d-%H%M%S)
```

### Step 2: Fetch Upstream & Fast-Forward `main`
```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
```

### Step 3: Rebase Custom Commits
Rebase the feature branch onto the updated `main`:
```bash
git checkout custom/alienware
git rebase main
```

> [!NOTE]
> In automated or headless environments (Windows PowerShell or CI), if Git prompts for an editor or throws `error: there was a problem with the editor 'false'`, set `GIT_EDITOR="true"` or configure `git config core.editor true` before continuing the rebase.

### Step 4: Resolve Merge Conflicts (Shared Integration Files)
Upstream updates typically conflict only in shared integration points:
* `src/sites.js` (Site registry & login checkers)
* `src/panel/panel.js` (Web-UI server, statistics aggregation, schedule loops)
* `src/app-config.js` (Config schema & scheduler options)
* `src/config.js` (Environment variable mappings)

**Resolution Rules:**
1. **Additive Integration:** Never drop upstream additions (e.g., new storefronts like `joybuy`, new flags, or updated selectors). Keep upstream's blocks and Alienware's blocks side-by-side.
2. **Avoid Circular ESM Dependencies:** Do not import `cfg` at top-level in `src/sites.js` unless safely protected against circular TDZ (Temporal Dead Zone) evaluation. Prefer using paths/env helpers or ensure `#src/util.js` is imported first.
3. **Preserve Shared Upstream Helpers:** Align with upstream updates in `#src/browser.js` (e.g., persistent session-cookie retention) and `#src/util.js` (e.g., async `jsonDb` corrupt file rotation).

Once conflicts in each file are resolved:
```bash
git add <resolved-files>
git rebase --continue
```

### Step 5: Verify Dependencies & Static Checks
```bash
# Check if upstream added new dependencies (e.g., bcryptjs)
npm ls --depth=0

# Install if dependencies are missing
npm install

# Run custom unit tests and upstream test suites
node test/alienware-check.js
node test/claim-cmd.js

# Verify JS syntax across modified modules and test files
Get-ChildItem -Path src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-ChildItem -Path test -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-ChildItem -Path . -Filter *.js | ForEach-Object { node --check $_.FullName }
```

### Step 6: Push Updated Branch
```bash
git push --force-with-lease origin custom/alienware
```

---

## 3. Architecture & Extension Guide

When extending the Alienware module or creating a new custom claimer/watcher, maintain strict modularity to keep future upstream rebases frictionless.

### Key Integration Points

| Component | File Location | Responsibility |
| :--- | :--- | :--- |
| **Platform Runner** | `src/platforms/<id>.js` | The core scraping/automation logic. Fully self-contained. |
| **CLI Runner Stub** | `<id>.js` (root) | 1-line root entrypoint (`import './src/platforms/<id>.js';`). |
| **Site Registry** | `src/sites.js` | Site metadata, `checkLogin(page)` implementation, browser profile directory. |
| **Config Schema** | `src/app-config.js` | Schema definitions for UI settings (`CONFIG_SCHEMA`) & scheduler windows. |
| **Runtime Config** | `src/config.js` | Maps `process.env` and service settings into the shared `cfg` object. |
| **Web-UI / Panel** | `src/panel/panel.js` | Multi-tab login, stats display, dedicated scheduler loops, API endpoints. |
| **Unit Tests** | `test/<id>-check.js` | Unit and contract tests for the site's definition and `checkLogin` logic. |

---

### Detailed Implementation Standards

#### 1. Platform Runner (`src/platforms/<id>.js`)
* **Browser Initialization:** Always use `launchContext(SITE_ID, options)` from `#src/browser.js`. It handles Chromium flags, profile locks (`cleanProfileLocks`), locale setup, and crash bubble suppression.
* **Persistent Profile:** Store browser user data in a dedicated directory: `cfg.dir.browser + '-<id>'` (e.g., `data/browser-alienware-arena`). Never share browser profiles across different storefronts unless SSO explicitly links them.
* **Database & State:** Use `await jsonDb('<id>.json', { ...defaults })` from `#src/util.js` for persistent storage (e.g., tracking daily minutes, claim history, or ARP).
* **Logging:** Follow upstream chalk-based conventions via `log` from `#src/util.js`:
  * `log.section(title)`: Section header.
  * `log.status(key, val)`: Operational parameter or state.
  * `log.ok(msg)`: Successful milestone.
  * `log.skip(name, reason)`: Deliberate skip (dimmed neutral marker).
  * `log.fail(msg)` / `log.exception(e)`: Real failure.

#### 2. Platform Registry (`src/sites.js`)
Register the module in the `SITES` array:
```javascript
{
  id: 'my-service',
  name: 'My Service',
  version: '1.0',
  subtitle: 'Description of service functionality.',
  script: platformScript('my-service'),
  claimOrder: 15,
  loginUrl: 'https://example.com/login',
  homeUrl: 'https://example.com/dashboard',
  get browserDir() { return browserDir('my-service'); },
  contextOptions: null, // or devices['Pixel 7'] for mobile services
  defaultActive: false,
  activeEnv: 'MY_SERVICE_ACTIVE',
  linkedWith: null,
  claimDbFile: null,
  scheduleKind: 'daily-window', // or 'daily-chain', 'watch-only'
  features: [],
  configFields: [
    { key: 'myOption', env: 'MY_SERVICE_OPTION', type: 'boolean', default: true,
      label: 'Enable feature', hint: 'Description for Settings UI' }
  ],
  async checkLogin(page) {
    // Navigate and return { loggedIn: boolean, user?: string, error?: string }
  }
}
```

#### 3. Dual Authentication Check Pattern
If a custom module depends on multiple authentication sessions (e.g., Alienware Arena + Twitch for watch-time rewards):
* In `src/panel/panel.js` -> `launchSite(siteId)`: When opened via noVNC in the Sessions tab, open a second tab for the secondary service (`context.newPage()`) and return focus to the primary page (`page.bringToFront()`).
* In `src/sites.js` -> `checkLogin(page)`: Inspect primary authentication via DOM locators, and secondary authentication via cookie jar inspection (`page.context().cookies('https://domain.com')`). Return combined user status:
  `user: 'Service1: user1 | Service2: user2'`.

#### 4. Detached Scheduling & Web-UI Integration
For services that operate on independent daily windows rather than the synchronous main claim chain:
* Add scheduler keys to `CONFIG_SCHEMA` in `src/app-config.js`:
  `scheduler.<id>ScheduleHours` and `scheduler.<id>ScheduleStart`.
* Expose schedule state in `getSchedulerConfig()`.
* In `src/panel/panel.js`:
  * Add the site ID to `INDEPENDENT_SCHEDULED_SITE_IDS = new Set(['alienware-arena', ...])`.
  * Define independent scheduler loop (e.g., `awaSchedulerLoop()`) and start it inside `server.listen(...)`.
  * Support detached runs and explicit run modes in `/api/run-service` and `/api/stop-detached-run`.

#### 5. Docker & CI Considerations
* **Data Volume:** All persistent configuration, database files, screenshots, and browser profiles MUST reside inside `data/` (`/fgc/data` in Docker container).
* **Workflow Triggers:** Ensure `.github/workflows/docker-publish.yml` triggers on `custom/**` and `codex/**` branches so test images build automatically on push.

---

## 4. Verification Checklist Before Any Commit / Push

- [ ] `node test/alienware-check.js` passes.
- [ ] `node test/claim-cmd.js` passes.
- [ ] All other unit tests in `test/` pass (`aliexpress-missions`, `epic-session`, `joybuy`, `profile-prefs`, `url-security`).
- [ ] Syntax check runs cleanly: `Get-ChildItem -Path src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }` and `Get-ChildItem -Path test -Filter *.js | ForEach-Object { node --check $_.FullName }`.
- [ ] Git commit history on `custom/alienware` is clean and directly stacked on top of latest `upstream/main`.
- [ ] No temporary files or secrets committed in `data/`.
