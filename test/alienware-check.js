import assert from 'node:assert/strict';
import '#src/util.js';
import { SITES_BY_ID } from '#src/sites.js';

console.log('--- Testing alienware-arena registration & checkLogin logic ---');

const awaSite = SITES_BY_ID['alienware-arena'];
assert.ok(awaSite, 'alienware-arena should be in SITES_BY_ID');
assert.equal(typeof awaSite.checkLogin, 'function', 'alienware-arena should have a checkLogin function');
assert.equal(awaSite.id, 'alienware-arena');
assert.equal(awaSite.scheduleKind, 'daily-window');
console.log('ok: alienware-arena registry definition verified');

// Test 1: Both logged in
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: selector => ({
      first: () => ({
        count: async () => selector.includes('login-form') ? 0 : 1,
        innerText: async () => 'TestAwaUser',
      }),
    }),
    context: () => ({
      cookies: async () => [
        { name: 'auth-token', value: 'oauth_secret_token_123' },
        { name: 'login', value: 'TestTwitchUser' },
      ],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'authenticated', 'Status should be authenticated');
  assert.equal(res.loggedIn, true, 'Should be logged in when both are present');
  assert.equal(res.user, 'AWA: TestAwaUser | Twitch: TestTwitchUser');
  assert.equal(res.details.awa.loggedIn, true);
  assert.equal(res.details.twitch.loggedIn, true);
  console.log('ok: Dual login (both logged in) ->', res);
}

// Test 2: AWA logged in, Twitch logged out
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: selector => ({
      first: () => ({
        count: async () => selector.includes('login-form') ? 0 : 1,
        innerText: async () => 'TestAwaUser',
      }),
    }),
    context: () => ({
      cookies: async () => [],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'unauthenticated', 'Status should be unauthenticated');
  assert.equal(res.loggedIn, false, 'Should be not logged in if Twitch is missing');
  assert.equal(res.user, 'AWA: TestAwaUser | Twitch: not signed in');
  assert.equal(res.details.awa.loggedIn, true);
  assert.equal(res.details.twitch.loggedIn, false);
  console.log('ok: Partial login (AWA only) ->', res);
}

// Test 3: Twitch logged in, AWA logged out
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: _selector => ({
      first: () => ({
        count: async () => 0,
        innerText: async () => '',
      }),
    }),
    context: () => ({
      cookies: async () => [
        { name: 'auth-token', value: 'oauth_secret_token_123' },
        { name: 'login', value: 'TestTwitchUser' },
      ],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'unauthenticated', 'Status should be unauthenticated');
  assert.equal(res.loggedIn, false, 'Should be not logged in if AWA is missing');
  assert.equal(res.user, 'AWA: not signed in | Twitch: TestTwitchUser');
  assert.equal(res.details.awa.loggedIn, false);
  assert.equal(res.details.twitch.loggedIn, true);
  console.log('ok: Partial login (Twitch only) ->', res);
}

// Test 4: Both logged out
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: _selector => ({
      first: () => ({
        count: async () => 0,
      }),
    }),
    context: () => ({
      cookies: async () => [],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'unauthenticated', 'Status should be unauthenticated');
  assert.equal(res.loggedIn, false, 'Should be not logged in when both are missing');
  assert.equal(res.user, null);
  assert.equal(res.details.awa.loggedIn, false);
  assert.equal(res.details.twitch.loggedIn, false);
  console.log('ok: Both logged out ->', res);
}

// Test 5: AWA login redirect detected
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/account/login',
    goto: async () => {},
    waitForTimeout: async () => {},
    locator: _selector => ({
      first: () => ({
        count: async () => 0,
      }),
    }),
    context: () => ({
      cookies: async () => [],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'unauthenticated', 'Status should be unauthenticated on login redirect');
  assert.equal(res.loggedIn, false);
  assert.equal(res.details.awa.loggedIn, false);
  console.log('ok: Login redirect detected ->', res);
}

// Test 5b: In-page evaluate detecting window.user_is_logged_in = true and title check
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      // Mock DOM environment where window.user_is_logged_in = true
      const origWindow = globalThis.window;
      const origDoc = globalThis.document;
      try {
        globalThis.window = {
          location: { href: 'https://eu.alienwarearena.com/control-center' },
          user_is_logged_in: true,
          user_username: 'ArenaChampion',
        };
        globalThis.document = {
          title: 'Control Center | Alienware Arena',
          querySelector: () => null,
        };
        return await fn();
      } finally {
        globalThis.window = origWindow;
        globalThis.document = origDoc;
      }
    },
    context: () => ({
      cookies: async () => [
        { name: 'auth-token', value: 'oauth_token_val' },
        { name: 'login', value: 'TwitchChampion' },
      ],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'authenticated');
  assert.equal(res.loggedIn, true);
  assert.equal(res.user, 'AWA: ArenaChampion | Twitch: TwitchChampion');
  console.log('ok: window.user_is_logged_in global detection ->', res);
}

// Test 5c: In-page evaluate detecting unauthenticated via document.title / login form
{
  const mockPage = {
    url: () => 'https://eu.alienwarearena.com/control-center',
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const origWindow = globalThis.window;
      const origDoc = globalThis.document;
      try {
        globalThis.window = {
          location: { href: 'https://eu.alienwarearena.com/control-center' },
          user_is_logged_in: false,
        };
        globalThis.document = {
          title: 'Log in to your account | Alienware Arena',
          querySelector: (sel) => sel.includes('login-form') ? {} : null,
        };
        return await fn();
      } finally {
        globalThis.window = origWindow;
        globalThis.document = origDoc;
      }
    },
    context: () => ({
      cookies: async () => [],
    }),
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'unauthenticated');
  assert.equal(res.loggedIn, false);
  console.log('ok: Unauthenticated login title/form detection ->', res);
}

// Test 6: Network/navigation error
{
  const mockPage = {
    url: () => '',
    goto: async () => {
      throw new Error('Navigation timeout: net::ERR_CONNECTION_TIMED_OUT');
    },
  };

  const res = await awaSite.checkLogin(mockPage);
  assert.equal(res.status, 'error', 'Status should be error');
  assert.equal(res.loggedIn, false, 'Should handle exceptions safely');
  assert.ok(res.error.includes('Navigation timeout'), 'Should return truncated error message');
  console.log('ok: Error handling ->', res);
}

console.log('\n--- Testing normalizeLoginResult and isSessionStale contract ---');
import { normalizeLoginResult, isSessionStale } from '#src/sites.js';

// Contract Test 1: Modern tripartite results
{
  const auth = normalizeLoginResult({ status: 'authenticated', loggedIn: true, user: 'hero' });
  assert.equal(auth.status, 'authenticated');
  assert.equal(auth.loggedIn, true);
  assert.equal(isSessionStale(auth), false, 'Authenticated session must NOT be stale');

  const unauth = normalizeLoginResult({ status: 'unauthenticated', loggedIn: false });
  assert.equal(unauth.status, 'unauthenticated');
  assert.equal(unauth.loggedIn, false);
  assert.equal(isSessionStale(unauth), true, 'Unauthenticated session MUST be stale');

  const err = normalizeLoginResult({ status: 'error', loggedIn: false, error: 'net::ERR_TIMED_OUT' });
  assert.equal(err.status, 'error');
  assert.equal(err.loggedIn, false);
  assert.equal(err.error, 'net::ERR_TIMED_OUT');
  assert.equal(isSessionStale(err), false, 'Error/timeout with loggedIn:false MUST NOT trigger stale session alert');
  console.log('ok: Modern tripartite normalization verified');
}

// Contract Test 2: Legacy / upstream Boolean formats
{
  const legacyAuth = normalizeLoginResult({ loggedIn: true, user: 'gamer' });
  assert.equal(legacyAuth.status, 'authenticated');
  assert.equal(isSessionStale(legacyAuth), false);

  const legacyUnauth = normalizeLoginResult({ loggedIn: false });
  assert.equal(legacyUnauth.status, 'unauthenticated');
  assert.equal(isSessionStale(legacyUnauth), true);

  const legacyErr = normalizeLoginResult({ loggedIn: false, error: 'Navigation timeout 20000ms' });
  assert.equal(legacyErr.status, 'error');
  assert.equal(isSessionStale(legacyErr), false, 'Legacy error must NOT be treated as confirmed logout');

  const busyErr = normalizeLoginResult({ error: 'Browser session active, close it first.' });
  assert.equal(busyErr.status, 'error');
  assert.equal(isSessionStale(busyErr), false);

  assert.equal(isSessionStale(null), false);
  assert.equal(isSessionStale(undefined), false);
  console.log('ok: Legacy format backward-compatibility & error suppression verified');
}

console.log('\n--- ALL ALIENWARE & AUTH CONTRACT TESTS PASSED ---');

