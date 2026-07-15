import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../src/index.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const registrationPassphrase = 'shared-registration-secret';
const adminToken = 'admin-secret';
const maxRequestBodyBytes = 16 * 1024;
const maxAdminConfigBodyBytes = 64 * 1024;

test('an existing name attaches another device to the same user data', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const firstSeed = '11111111-1111-4111-8111-111111111111';
  const secondSeed = '22222222-2222-4222-8222-222222222222';
  const today = toTrafficDateKey(new Date());

  const first = await activate(database, {
    name: 'Alice',
    deviceSeed: firstSeed
  });
  assert.equal(first.status, 200);
  const firstIdentity = await first.json();
  await database
    .prepare(
      `INSERT INTO traffic_daily
         (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(firstIdentity.userId, firstIdentity.deviceId, today, 4096, 8192, new Date().toISOString())
    .run();
  const configWrite = await updateAdminUserConfig(database, firstIdentity.userId, {
    subscriptionUrl: 'https://example.com/alice-sub',
    preferredNode: 'Alice Node'
  });
  assert.equal(configWrite.status, 200);

  const attached = await activate(database, {
    name: ' Alice ',
    deviceSeed: secondSeed
  });
  assert.equal(attached.status, 200);
  const attachedIdentity = await attached.json();
  assert.equal(attachedIdentity.userId, firstIdentity.userId);
  assert.notEqual(attachedIdentity.deviceId, firstIdentity.deviceId);
  assert.deepEqual(trafficWithoutTimestamp(attachedIdentity.traffic), {
    date: today,
    totalUpload: 4096,
    totalDownload: 8192,
    deviceTotalUpload: 0,
    deviceTotalDownload: 0,
    todayUpload: 4096,
    todayDownload: 8192
  });
  assert.equal(database.queryAll('SELECT id FROM devices WHERE user_id = ?', firstIdentity.userId).length, 2);

  const config = await getClientConfig(database, attachedIdentity, secondSeed);
  assert.equal(config.status, 200);
  const configBody = await config.json();
  assert.equal(configBody.config.subscriptionUrl, 'https://example.com/alice-sub');
  assert.equal(configBody.config.preferredNode, 'Alice Node');
  assert.equal(configBody.config.enabled, true);

  const retry = await activate(database, {
    name: 'ALICE',
    deviceSeed: firstSeed
  });
  assert.equal(retry.status, 200);
  const retriedIdentity = await retry.json();
  assert.equal(retriedIdentity.userId, firstIdentity.userId);
  assert.equal(retriedIdentity.deviceId, firstIdentity.deviceId);
  assert.equal(retriedIdentity.name, firstIdentity.name);
  assert.deepEqual(trafficWithoutTimestamp(retriedIdentity.traffic), {
    date: today,
    totalUpload: 4096,
    totalDownload: 8192,
    deviceTotalUpload: 4096,
    deviceTotalDownload: 8192,
    todayUpload: 4096,
    todayDownload: 8192
  });
  assert.equal(database.queryAll('SELECT id FROM devices WHERE user_id = ?', firstIdentity.userId).length, 2);
});

test('an orphaned existing user atomically accepts concurrent fresh devices', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await database
    .prepare('INSERT INTO users (id, name, normalized_name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('orphan-user', 'Alice', 'alice', 'active', '2026-07-13T00:00:00.000Z')
    .run();

  const responses = await Promise.all([
    activate(database, {
      name: 'Alice',
      deviceSeed: '11111111-1111-4111-8111-111111111111'
    }),
    activate(database, {
      name: ' Alice ',
      deviceSeed: '22222222-2222-4222-8222-222222222222'
    })
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  assert.deepEqual(await Promise.all(responses.map(async (response) => (await response.json()).userId)), [
    'orphan-user',
    'orphan-user'
  ]);
  assert.equal(database.queryAll('SELECT id FROM devices WHERE user_id = ?', 'orphan-user').length, 2);
});

test('an existing device can switch to another existing user name', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const firstSeed = '11111111-1111-4111-8111-111111111111';
  const bobSeed = '22222222-2222-4222-8222-222222222222';
  const today = toTrafficDateKey(new Date());

  const first = await activate(database, { name: 'Alice', deviceSeed: firstSeed });
  assert.equal(first.status, 200);
  const firstIdentity = await first.json();
  await database
    .prepare(
      `INSERT INTO traffic_daily
         (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(firstIdentity.userId, firstIdentity.deviceId, today, 100, 200, new Date().toISOString())
    .run();

  const bob = await activate(database, {
    name: 'Bob',
    deviceSeed: bobSeed
  });
  assert.equal(bob.status, 200);
  const bobIdentity = await bob.json();
  await database
    .prepare(
      `INSERT INTO traffic_daily
         (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(bobIdentity.userId, bobIdentity.deviceId, today, 700, 900, new Date().toISOString())
    .run();
  const configWrite = await updateAdminUserConfig(database, bobIdentity.userId, {
    subscriptionUrl: 'https://example.com/bob-sub',
    preferredNode: 'Bob Node'
  });
  assert.equal(configWrite.status, 200);

  const switched = await activate(database, { name: 'Bob', deviceSeed: firstSeed });
  assert.equal(switched.status, 200);
  const switchedIdentity = await switched.json();
  assert.equal(switchedIdentity.userId, bobIdentity.userId);
  assert.equal(switchedIdentity.name, bobIdentity.name);
  assert.equal(switchedIdentity.deviceId, firstIdentity.deviceId);
  assert.deepEqual(trafficWithoutTimestamp(switchedIdentity.traffic), {
    date: today,
    totalUpload: 700,
    totalDownload: 900,
    deviceTotalUpload: 0,
    deviceTotalDownload: 0,
    todayUpload: 700,
    todayDownload: 900
  });
  assert.equal(
    database.queryAll('SELECT user_id FROM devices WHERE device_seed = ?', firstSeed)[0]?.user_id,
    bobIdentity.userId
  );
  const aliceHistory = database.queryAll(
    `SELECT user_id, device_id, upload_bytes, download_bytes
     FROM traffic_daily
     WHERE user_id = ? AND device_id = ?`,
    firstIdentity.userId,
    firstIdentity.deviceId
  );
  assert.equal(aliceHistory.length, 1);
  assert.deepEqual(
    { ...aliceHistory[0] },
    {
      user_id: firstIdentity.userId,
      device_id: firstIdentity.deviceId,
      upload_bytes: 100,
      download_bytes: 200
    }
  );

  const config = await getClientConfig(database, switchedIdentity, firstSeed);
  assert.equal(config.status, 200);
  const configBody = await config.json();
  assert.equal(configBody.config.subscriptionUrl, 'https://example.com/bob-sub');
  assert.equal(configBody.config.preferredNode, 'Bob Node');
  assert.equal(
    database.queryAll('SELECT user_id FROM user_remote_config WHERE user_id = ?', bobIdentity.userId).length,
    1
  );
});

test('activation rejects malformed JSON as a bad request', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const response = await worker.fetch(
    new Request('https://worker.example/api/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid json' });
});

test('a whitespace-only admin token keeps the admin API disabled', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const response = await worker.fetch(new Request('https://worker.example/api/admin/users'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: '   '
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'admin disabled' });
});

test('admin config writes reject non-object JSON and bodies larger than 64 KiB', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  for (const path of ['/api/admin/config', '/api/admin/users/user-1/config']) {
    const nonObject = await requestAdminConfig(database, path, '[]');
    assert.equal(nonObject.status, 400, path);
    assert.deepEqual(await nonObject.json(), { error: 'invalid json' });

    const oversized = await requestAdminConfig(
      database,
      path,
      JSON.stringify({ padding: 'x'.repeat(maxAdminConfigBodyBytes) })
    );
    assert.equal(oversized.status, 413, path);
    assert.deepEqual(await oversized.json(), { error: 'request too large' });
  }
});

test('admin config writes bound rule count and rule text without truncating invalid input', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  const tooMany = await updateAdminConfig(database, {
    directRules: Array.from({ length: 257 }, (_, index) => `DOMAIN,rule-${index}.test`)
  });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: 'too many rules' });

  const tooLong = await updateAdminUserConfig(database, 'user-1', {
    directRules: [`DOMAIN,${'x'.repeat(154)}`]
  });
  assert.equal(tooLong.status, 400);
  assert.deepEqual(await tooLong.json(), { error: 'invalid rule' });

  const invalidItem = await updateAdminConfig(database, { proxyRules: ['DOMAIN,example.test', 42] });
  assert.equal(invalidItem.status, 400);
  assert.deepEqual(await invalidItem.json(), { error: 'invalid rules' });

  const boundaryRules = Array.from({ length: 256 }, (_, index) => `DOMAIN,ok-${index}.test`);
  const accepted = await updateAdminConfig(database, { directRules: boundaryRules });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).config.directRules, boundaryRules);
});

test('global config rejects invalid recognized fields without changing stored config', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baselineResponse = await updateAdminConfig(database, {
    enabled: true,
    subscriptionUrl: 'https://example.com/sub',
    ruleProfile: 'global',
    preferredNode: 'Node A',
    preferredStrategy: 'auto',
    anomalyThresholdBytes: 1024
  });
  assert.equal(baselineResponse.status, 200);
  const baseline = (await baselineResponse.json()).config;

  const cases = [
    { input: { enabled: 'true' }, error: 'invalid enabled' },
    { input: { subscriptionUrl: 42 }, error: 'invalid subscription url' },
    { input: { enabled: false, ruleProfile: 'unsupported' }, error: 'invalid rule profile' },
    { input: { preferredNode: 42 }, error: 'invalid preferred node' },
    { input: { preferredStrategy: 'unsupported' }, error: 'invalid preferred strategy' },
    { input: { anomalyThresholdBytes: null }, error: 'invalid anomaly threshold' },
    { input: { anomalyThresholdBytes: 0.5 }, error: 'invalid anomaly threshold' }
  ];

  for (const item of cases) {
    const response = await updateAdminConfig(database, item.input);
    assert.equal(response.status, 400, item.error);
    assert.deepEqual(await response.json(), { error: item.error });
    const current = await getAdminConfig(database);
    assert.equal(current.status, 200);
    assert.deepEqual((await current.json()).config, baseline, item.error);
  }
});

test('per-user config patches preserve omitted fields and only explicit null clears an override', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  const baselineResponse = await updateAdminUserConfig(database, 'user-1', {
    enabled: false,
    subscriptionUrl: 'https://example.com/user-sub',
    ruleProfile: 'global',
    preferredNode: 'Node A',
    preferredStrategy: 'auto',
    directRules: ['DOMAIN,direct.test'],
    proxyRules: ['DOMAIN,proxy.test']
  });
  assert.equal(baselineResponse.status, 200);

  const patchedResponse = await updateAdminUserConfig(database, 'user-1', { preferredNode: 'Node B' });
  assert.equal(patchedResponse.status, 200);
  const patched = (await patchedResponse.json()).override;
  assert.equal(patched.enabled, false);
  assert.equal(patched.subscriptionUrl, 'https://example.com/user-sub');
  assert.equal(patched.ruleProfile, 'global');
  assert.equal(patched.preferredNode, 'Node B');
  assert.equal(patched.preferredStrategy, 'auto');
  assert.deepEqual(patched.directRules, ['DOMAIN,direct.test']);
  assert.deepEqual(patched.proxyRules, ['DOMAIN,proxy.test']);

  const clearedResponse = await updateAdminUserConfig(database, 'user-1', { subscriptionUrl: null });
  assert.equal(clearedResponse.status, 200);
  const cleared = (await clearedResponse.json()).override;
  assert.equal('subscriptionUrl' in cleared, false);
  assert.equal(cleared.preferredNode, 'Node B');
  assert.deepEqual(cleared.directRules, ['DOMAIN,direct.test']);

  const invalidResponse = await updateAdminUserConfig(database, 'user-1', {
    enabled: true,
    ruleProfile: 'unsupported'
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: 'invalid rule profile' });

  const unsupportedThreshold = await updateAdminUserConfig(database, 'user-1', { anomalyThresholdBytes: 1024 });
  assert.equal(unsupportedThreshold.status, 400);
  assert.deepEqual(await unsupportedThreshold.json(), { error: 'invalid anomaly threshold' });

  const currentResponse = await getAdminUserConfig(database, 'user-1');
  assert.equal(currentResponse.status, 200);
  const current = (await currentResponse.json()).override;
  assert.equal(current.enabled, false);
  assert.equal('subscriptionUrl' in current, false);
  assert.equal(current.ruleProfile, 'global');
  assert.equal(current.preferredNode, 'Node B');
  assert.deepEqual(current.directRules, ['DOMAIN,direct.test']);
  assert.deepEqual(current.proxyRules, ['DOMAIN,proxy.test']);
});

test('activation rejects request bodies larger than 16 KiB', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const response = await activate(database, {
    name: 'A'.repeat(17 * 1024),
    deviceSeed: '11111111-1111-4111-8111-111111111111'
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request too large' });
});

test('activation accepts an exact-limit UTF-8 stream split inside a multibyte character', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const body = createExactLimitActivationBody();
  const encoded = new TextEncoder().encode(body);
  assert.equal(encoded.byteLength, maxRequestBodyBytes);
  const firstMultibyteByte = encoded.findIndex((byte) => byte >= 0x80);
  assert.ok(firstMultibyteByte >= 0);

  const response = await worker.fetch(
    createStreamRequest('/api/activate', [
      encoded.slice(0, firstMultibyteByte + 1),
      encoded.slice(firstMultibyteByte + 1, firstMultibyteByte + 2),
      encoded.slice(firstMultibyteByte + 2)
    ]),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    }
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, '张三');
});

test('bounded JSON routes cancel oversized chunked bodies without trusting Content-Length', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  for (const { path, declaredLength } of [
    { path: '/api/activate', declaredLength: undefined },
    { path: '/api/traffic/report', declaredLength: '1' }
  ]) {
    const streamed = createOverflowRequest(path, declaredLength);
    const response = await worker.fetch(streamed.request, {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    });

    assert.equal(response.status, 413, path);
    assert.deepEqual(await response.json(), { error: 'request too large' });
    assert.equal(streamed.state.cancelled, true, `${path} should cancel its reader`);
    assert.equal(streamed.state.pulls, 2, `${path} should stop before requesting another chunk`);
  }
});

test('activation rejects malformed or oversized identity metadata', async () => {
  const cases = [
    {
      input: { name: 'A'.repeat(81), deviceSeed: '11111111-1111-4111-8111-111111111111' },
      error: 'invalid name'
    },
    {
      input: { name: 'A\u0000B', deviceSeed: '11111111-1111-4111-8111-111111111111' },
      error: 'invalid name'
    },
    { input: { name: 'Alice', deviceSeed: 'not-a-uuid' }, error: 'invalid device' },
    {
      input: {
        name: 'Alice',
        deviceSeed: '11111111-1111-4111-8111-111111111111',
        deviceName: 'D'.repeat(121)
      },
      error: 'invalid device name'
    },
    {
      input: {
        name: 'Alice',
        deviceSeed: '11111111-1111-4111-8111-111111111111',
        platform: 'P'.repeat(33)
      },
      error: 'invalid platform'
    },
    {
      input: {
        name: 'Alice',
        deviceSeed: '11111111-1111-4111-8111-111111111111',
        appVersion: 'V'.repeat(65)
      },
      error: 'invalid app version'
    }
  ];

  for (const item of cases) {
    const database = createD1Database();
    try {
      const response = await activate(database, item.input);
      assert.equal(response.status, 400, item.error);
      assert.deepEqual(await response.json(), { error: item.error });
      if (item.error === 'invalid name') {
        assert.deepEqual(database.queryAll('SELECT key FROM rate_limits'), []);
      }
    } finally {
      database.close();
    }
  }
});

test('concurrent activation failures cannot bypass the per-name limit', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      activate(database, {
        name: 'Alice',
        deviceSeed: '11111111-1111-4111-8111-111111111111',
        passphrase: 'wrong-passphrase'
      })
    )
  );
  const statuses = responses.map((response) => response.status);

  assert.equal(statuses.filter((status) => status === 403).length, 8);
  assert.equal(statuses.filter((status) => status === 429).length, 4);
});

test('successful activation clears prior failed-attempt reservations', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const input = {
    name: 'Alice',
    deviceSeed: '11111111-1111-4111-8111-111111111111'
  };

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const failed = await activate(database, { ...input, passphrase: 'wrong-passphrase' });
    assert.equal(failed.status, 403);
  }
  assert.equal((await activate(database, input)).status, 200);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failed = await activate(database, { ...input, passphrase: 'wrong-passphrase' });
    assert.equal(failed.status, 403);
  }
  assert.equal((await activate(database, { ...input, passphrase: 'wrong-passphrase' })).status, 429);
});

test('concurrent global config patches preserve both fields and advance distinct versions', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baselineResponse = await updateAdminConfig(database, {
    ruleProfile: 'ruleset',
    preferredStrategy: 'manual',
    preferredNode: 'Node A'
  });
  assert.equal(baselineResponse.status, 200);
  const baseline = (await baselineResponse.json()).config;

  const responses = await Promise.all([
    updateAdminConfig(database, { ruleProfile: 'global' }),
    updateAdminConfig(database, { preferredStrategy: 'auto' })
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  );

  const finalResponse = await getAdminConfig(database);
  assert.equal(finalResponse.status, 200);
  const final = (await finalResponse.json()).config;
  assert.equal(final.ruleProfile, 'global');
  assert.equal(final.preferredStrategy, 'auto');
  assert.equal(final.preferredNode, 'Node A');
  assert.equal(final.version, baseline.version + 2);
});

test('explicit null clears nullable global config choices', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baseline = await updateAdminConfig(database, {
    ruleProfile: 'global',
    preferredStrategy: 'auto'
  });
  assert.equal(baseline.status, 200);

  const cleared = await updateAdminConfig(database, {
    ruleProfile: null,
    preferredStrategy: null
  });
  assert.equal(cleared.status, 200);
  const config = (await cleared.json()).config;
  assert.equal('ruleProfile' in config, false);
  assert.equal('preferredStrategy' in config, false);
});

async function activate(database, input) {
  return worker.fetch(
    new Request('https://worker.example/api/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        passphrase: registrationPassphrase,
        deviceName: 'TEST-PC',
        platform: 'win32',
        appVersion: '1.5.8',
        ...input
      })
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    }
  );
}

async function getClientConfig(database, identity, deviceSeed) {
  const url = new URL('https://worker.example/api/config');
  url.searchParams.set('userId', identity.userId);
  url.searchParams.set('deviceId', identity.deviceId);
  const timestamp = String(Date.now());
  const bodyHash = createHash('sha256').update('').digest('hex');
  const canonical = ['GET', `${url.pathname}${url.search}`, timestamp, bodyHash].join('\n');
  const signature = createHmac('sha256', deviceSeed).update(canonical).digest('hex');

  return worker.fetch(
    new Request(url, {
      headers: {
        'x-youyu-timestamp': timestamp,
        'x-youyu-signature': signature
      }
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    }
  );
}

function trafficWithoutTimestamp(traffic) {
  const { updatedAt: _updatedAt, ...summary } = traffic;
  return summary;
}

function toTrafficDateKey(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function updateAdminConfig(database, input) {
  return requestAdminConfig(database, '/api/admin/config', JSON.stringify(input));
}

async function updateAdminUserConfig(database, userId, input) {
  return requestAdminConfig(database, `/api/admin/users/${encodeURIComponent(userId)}/config`, JSON.stringify(input));
}

async function requestAdminConfig(database, path, body) {
  return worker.fetch(
    new Request(`https://worker.example${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json'
      },
      body
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase,
      ADMIN_TOKEN: adminToken
    }
  );
}

async function addKnownUser(database, id = 'user-1') {
  await database
    .prepare('INSERT INTO users (id, name, normalized_name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, 'Known User', `known-${id}`, 'active', '2026-07-13T00:00:00.000Z')
    .run();
}

async function getAdminConfig(database) {
  return worker.fetch(
    new Request('https://worker.example/api/admin/config', {
      headers: { authorization: `Bearer ${adminToken}` }
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase,
      ADMIN_TOKEN: adminToken
    }
  );
}

async function getAdminUserConfig(database, userId) {
  return worker.fetch(
    new Request(`https://worker.example/api/admin/users/${encodeURIComponent(userId)}/config`, {
      headers: { authorization: `Bearer ${adminToken}` }
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase,
      ADMIN_TOKEN: adminToken
    }
  );
}

function createExactLimitActivationBody() {
  const input = {
    name: '张三',
    passphrase: registrationPassphrase,
    deviceSeed: '11111111-1111-4111-8111-111111111111',
    deviceName: '测试电脑',
    platform: 'win32',
    appVersion: '1.5.8',
    padding: ''
  };
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(JSON.stringify(input)).byteLength;
  const remainingBytes = maxRequestBodyBytes - baseBytes;
  const multibyteCharacters = Math.floor(remainingBytes / 3);
  const asciiCharacters = remainingBytes - multibyteCharacters * 3;
  input.padding = `${'界'.repeat(multibyteCharacters)}${'a'.repeat(asciiCharacters)}`;
  return JSON.stringify(input);
}

function createStreamRequest(path, chunks, headers = {}) {
  let index = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]);
        index += 1;
      }
    },
    { highWaterMark: 0 }
  );
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half'
  });
}

function createOverflowRequest(path, declaredLength) {
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream(
    {
      pull(controller) {
        state.pulls += 1;
        if (state.pulls === 1) {
          controller.enqueue(new Uint8Array(maxRequestBodyBytes).fill(0x20));
        } else if (state.pulls === 2) {
          controller.enqueue(new Uint8Array([0x20]));
        } else {
          controller.close();
        }
      },
      cancel() {
        state.cancelled = true;
      }
    },
    { highWaterMark: 0 }
  );
  const headers = { 'content-type': 'application/json' };
  if (declaredLength !== undefined) headers['content-length'] = declaredLength;
  return {
    state,
    request: new Request(`https://worker.example${path}`, {
      method: 'POST',
      headers,
      body,
      duplex: 'half'
    })
  };
}

function createD1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(schema);

  return {
    prepare(sql) {
      return new D1Statement(sqlite, sql);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    queryAll(sql, ...bindings) {
      return sqlite.prepare(sql).all(...bindings);
    },
    close() {
      sqlite.close();
    }
  };
}

class D1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1Statement(this.database, this.sql, bindings);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) };
  }
}
