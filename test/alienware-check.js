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
    locator: _selector => ({
      first: () => ({
        count: async () => 1,
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
    locator: _selector => ({
      first: () => ({
        count: async () => 1,
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

console.log('\n--- ALL ALIENWARE UNIT TESTS PASSED ---');
