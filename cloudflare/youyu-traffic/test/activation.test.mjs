import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../src/index.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const registrationPassphrase = 'shared-registration-secret';
const adminToken = 'admin-secret';
const maxRequestBodyBytes = 16 * 1024;
const maxAdminConfigBodyBytes = 64 * 1024;

test('an existing name cannot attach a different device seed', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const first = await activate(database, {
    name: 'Alice',
    deviceSeed: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(first.status, 200);
  const firstIdentity = await first.json();

  const conflicting = await activate(database, {
    name: ' Alice ',
    deviceSeed: '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await conflicting.json(), { error: 'registration conflict' });
  assert.equal(database.queryAll('SELECT id FROM devices WHERE user_id = ?', firstIdentity.userId).length, 1);

  const retry = await activate(database, {
    name: 'ALICE',
    deviceSeed: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), firstIdentity);
});

test('an orphaned existing user atomically accepts only one fresh device seed', async (context) => {
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

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const accepted = responses.find((response) => response.status === 200);
  assert.ok(accepted);
  assert.equal((await accepted.json()).userId, 'orphan-user');
  assert.equal(database.queryAll('SELECT id FROM devices WHERE user_id = ?', 'orphan-user').length, 1);
});

test('an existing device seed cannot move to a different name', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const firstSeed = '11111111-1111-4111-8111-111111111111';

  const first = await activate(database, { name: 'Alice', deviceSeed: firstSeed });
  assert.equal(first.status, 200);

  const conflicting = await activate(database, { name: 'Bob', deviceSeed: firstSeed });
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await conflicting.json(), { error: 'registration conflict' });

  const independent = await activate(database, {
    name: 'Bob',
    deviceSeed: '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(independent.status, 200);
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
