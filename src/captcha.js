// Opt-in CAPTCHA solver — 2Captcha REST provider (v2.11.0 / 2D).
//
// Zero-effect when unconfigured: without CAPTCHA_API_KEY set, both
// solve helpers return null immediately and callers fall back to
// today's fail-and-diagnostic behaviour. Only when the user opts in
// does any HTTP traffic leave the container.
//
// Provider layout: a single `provider` object bundles the URL and
// method-name variants each service uses. Today only 2Captcha ships;
// alternate providers (CapSolver, Anti-Captcha) plug in behind the
// same top-level solveHcaptcha / solveRecaptcha signatures by adding
// their own provider entry and dispatching on cfg.captcha_provider.
//
// Call sites (EG hCaptcha intercept, FAB checkout captcha) wrap:
//
//   const token = await solveHcaptcha(page, { siteKey, url });
//   if (token) {
//     await page.evaluate((t) => {
//       document.querySelector('[name="h-captcha-response"]').value = t;
//     }, token);
//     // …trigger the form's submit path…
//   } else {
//     // fall back to today's behaviour (fail visible → diagnostic)
//   }

import { cfg } from './config.js';
import { log } from './util.js';

const PROVIDERS = {
  '2captcha': {
    in:  'https://2captcha.com/in.php',
    res: 'https://2captcha.com/res.php',
    // 2Captcha uses `hcaptcha` (lowercase h). Their reCAPTCHA-v2 method
    // is `userrecaptcha` — the "user" prefix is a legacy artefact.
    hcaptcha: 'hcaptcha',
    recaptcha: 'userrecaptcha',
  },
};

// Returns the provider config for the currently selected provider, or
// null if the user hasn't opted in (missing API key or unknown provider).
function activeProvider() {
  if (!cfg.captcha_api_key) return null;
  const key = String(cfg.captcha_provider || '2captcha').toLowerCase();
  return PROVIDERS[key] || null;
}

// Poll the provider until a token comes back, error is reported, or
// deadline hits. 2Captcha's `res.php` returns `CAPCHA_NOT_READY` while
// solving, `OK|<token>` on success, `ERROR_...` codes on failure.
async function pollForToken(prov, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // First poll waits ~10s to give the human solver time — 2Captcha's
  // own docs suggest this. Subsequent polls at 5s intervals.
  await new Promise(r => setTimeout(r, 10000));
  while (Date.now() < deadline) {
    try {
      const url = `${prov.res}?key=${cfg.captcha_api_key}&action=get&id=${id}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const text = (await r.text()).trim();
      if (text === 'CAPCHA_NOT_READY') {
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }
      if (text.startsWith('OK|')) return text.slice(3);
      // Anything else is a terminal error (ERROR_CAPTCHA_UNSOLVABLE etc.)
      return { error: text };
    } catch (e) {
      // Network hiccups don't burn the poll — the deadline still catches
      // a truly-stuck provider.
      log.warn(`captcha: poll error ${String(e.message || e).split('\n')[0]}`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
  return { error: 'timeout waiting for solver' };
}

// Submit a job to the provider and return its id, or null on error.
async function submitJob(prov, method, params) {
  try {
    const body = new URLSearchParams({
      key: cfg.captcha_api_key,
      method,
      json: '1',
      ...params,
    });
    const r = await fetch(prov.in, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (j.status === 1 && j.request) return String(j.request);
    log.warn(`captcha: submit failed ${j.request || 'unknown'}`);
    return null;
  } catch (e) {
    log.warn(`captcha: submit exception ${String(e.message || e).split('\n')[0]}`);
    return null;
  }
}

/**
 * Solve an hCaptcha challenge. Returns the token string on success, or
 * null if unavailable (no provider configured, submit failed, poll
 * timed out, or provider reported an unsolvable challenge).
 *
 * @param {import('patchright').Page} _page  reserved for future use — some providers need the browser's cookies to bootstrap
 * @param {object} args
 * @param {string} args.siteKey  the hCaptcha site key from the challenge widget
 * @param {string} args.url      the page URL the captcha is embedded on
 * @param {number} [args.timeoutMs=120000]
 */
export async function solveHcaptcha(_page, { siteKey, url, timeoutMs = 120000 }) {
  const prov = activeProvider();
  if (!prov) return null;
  if (!siteKey || !url) {
    log.warn('captcha: missing siteKey or url — skipping solve');
    return null;
  }
  const id = await submitJob(prov, prov.hcaptcha, { sitekey: siteKey, pageurl: url });
  if (!id) return null;
  log.info(`captcha: hCaptcha submitted (${cfg.captcha_provider || '2captcha'} id=${id})`);
  const res = await pollForToken(prov, id, timeoutMs);
  if (typeof res === 'string') {
    log.info('captcha: solved');
    return res;
  }
  log.warn(`captcha: ${res.error}`);
  return null;
}

/**
 * Solve a reCAPTCHA v2 challenge. Same contract as solveHcaptcha —
 * null when unavailable/failed, token string on success.
 */
export async function solveRecaptcha(_page, { siteKey, url, timeoutMs = 120000 }) {
  const prov = activeProvider();
  if (!prov) return null;
  if (!siteKey || !url) {
    log.warn('captcha: missing siteKey or url — skipping solve');
    return null;
  }
  const id = await submitJob(prov, prov.recaptcha, { googlekey: siteKey, pageurl: url });
  if (!id) return null;
  log.info(`captcha: reCAPTCHA submitted (${cfg.captcha_provider || '2captcha'} id=${id})`);
  const res = await pollForToken(prov, id, timeoutMs);
  if (typeof res === 'string') {
    log.info('captcha: solved');
    return res;
  }
  log.warn(`captcha: ${res.error}`);
  return null;
}

// Attempt to auto-detect an hCaptcha widget on the page and solve it.
// Reads the `data-sitekey` attribute off the standard iframe / div
// element. Returns { ok: bool, applied: bool } — `ok` when a token
// was obtained and injected; `applied` when the caller's submit path
// should be triggered. Null return means no widget found (or opt-out).
// Call sites use this as a defensive wrapper before their existing
// captcha-wall diagnostic path fires.
export async function attemptAutoSolveHcaptcha(page) {
  if (!activeProvider()) return null;
  try {
    const siteKey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey], .h-captcha[data-sitekey]');
      if (el) return el.getAttribute('data-sitekey');
      // Also check hidden iframes (hCaptcha sometimes ships this way)
      const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (iframe) {
        const m = iframe.src.match(/[?&]sitekey=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      }
      return null;
    });
    if (!siteKey) return null;
    const token = await solveHcaptcha(page, { siteKey, url: page.url() });
    if (!token) return { ok: false, applied: false };
    // Inject the token into the standard hCaptcha response inputs. Sites
    // vary in which of these they read from, so set both — plus fire an
    // input event in case the site is listening for one.
    await page.evaluate((t) => {
      const set = (sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = t;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      set('[name="h-captcha-response"]');
      set('[name="g-recaptcha-response"]');
      set('#h-captcha-response');
    }, token).catch(() => {});
    return { ok: true, applied: true };
  } catch (e) {
    log.warn(`captcha: auto-solve exception ${String(e.message || e).split('\n')[0]}`);
    return { ok: false, applied: false };
  }
}
