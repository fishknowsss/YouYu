import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import worker from '../src/index.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const registrationPassphrase = 'shared-registration-secret';
const adminToken = 'admin-secret';
const maxRequestBodyBytes = 16 * 1024;
const maxAdminConfigBodyBytes = 64 * 1024;

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    subscriptionUrl: 'https://example.com/alice-sub'
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

test('a stable device key reuses one physical device when the signing seed is recreated', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstSeed = '11111111-1111-4111-8111-111111111111';
  const replacementSeed = '22222222-2222-4222-8222-222222222222';

  const first = await activate(database, { name: 'Alice', deviceSeed: firstSeed, deviceKey });
  assert.equal(first.status, 200);
  const firstIdentity = await first.json();

  const replacement = await activate(database, {
    name: 'Alice',
    deviceSeed: replacementSeed,
    deviceKey: deviceKey.toUpperCase()
  });
  assert.equal(replacement.status, 200);
  const replacementIdentity = await replacement.json();

  assert.equal(replacementIdentity.userId, firstIdentity.userId);
  assert.equal(replacementIdentity.deviceId, firstIdentity.deviceId);
  const [storedDevice] = database.queryAll(
    'SELECT device_seed, device_key FROM devices WHERE user_id = ?',
    firstIdentity.userId
  );
  assert.equal(storedDevice.device_seed, replacementSeed);
  assert.equal(storedDevice.device_key, deviceKey);
  assert.equal((await getClientConfig(database, replacementIdentity, replacementSeed)).status, 200);
});

test('admin device totals count logical machines while retaining legacy installation records', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const first = await activate(database, {
    name: 'Alice',
    deviceSeed: '11111111-1111-4111-8111-111111111111',
    deviceName: 'ALICE-PC'
  });
  assert.equal(first.status, 200);
  const second = await activate(database, {
    name: 'Alice',
    deviceSeed: '22222222-2222-4222-8222-222222222222',
    deviceName: ' alice-pc '
  });
  assert.equal(second.status, 200);

  const response = await requestAdmin(database, '/api/admin/users');
  assert.equal(response.status, 200);
  const users = (await response.json()).users;
  assert.equal(users.length, 1);
  assert.equal(users[0].devices, 1);
  assert.equal(users[0].deviceRecords, 2);
});

test('admin can merge user aliases without breaking an already registered source device', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const sourceSeed = '11111111-1111-4111-8111-111111111111';
  const targetSeed = '22222222-2222-4222-8222-222222222222';
  const mergeRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const sourceResponse = await activate(database, { name: 'Alice-old', deviceSeed: sourceSeed });
  const targetResponse = await activate(database, { name: 'Alice', deviceSeed: targetSeed });
  assert.equal(sourceResponse.status, 200);
  assert.equal(targetResponse.status, 200);
  const source = await sourceResponse.json();
  const target = await targetResponse.json();
  assert.equal(
    (await updateAdminUserConfig(database, source.userId, { subscriptionUrl: 'https://example.com/source' })).status,
    200
  );
  assert.equal(
    (await updateAdminUserConfig(database, target.userId, { subscriptionUrl: 'https://example.com/target' })).status,
    200
  );

  const preview = await requestAdmin(
    database,
    `/api/admin/users/${encodeURIComponent(source.userId)}/merge-preview?targetUserId=${encodeURIComponent(target.userId)}`
  );
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).config, {
    conflict: true,
    sourceHasOverride: true,
    targetHasOverride: true,
    recommendedResolution: 'keep_target'
  });
  const unresolved = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId })
  });
  assert.equal(unresolved.status, 409);
  assert.deepEqual(await unresolved.json(), { error: 'config conflict' });

  const merge = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({
      targetUserId: target.userId,
      configResolution: 'keep_target',
      requestId: mergeRequestId
    })
  });
  assert.equal(merge.status, 200);

  const listed = (await (await requestAdmin(database, '/api/admin/users')).json()).users;
  assert.deepEqual(
    listed.map((user) => user.id),
    [target.userId]
  );
  assert.equal(listed[0].deviceRecords, 2);
  assert.equal((await getClientConfig(database, source, sourceSeed)).status, 200);
  const sourceConfig = await getClientConfig(database, source, sourceSeed);
  assert.equal((await sourceConfig.json()).config.subscriptionUrl, 'https://example.com/target');

  const aliasActivation = await activate(database, {
    name: 'Alice-old',
    deviceSeed: '33333333-3333-4333-8333-333333333333'
  });
  assert.equal(aliasActivation.status, 200);
  const aliasIdentity = await aliasActivation.json();
  assert.equal(aliasIdentity.userId, target.userId);
  assert.equal(aliasIdentity.name, 'Alice');

  const repeated = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({
      targetUserId: target.userId,
      configResolution: 'keep_target',
      requestId: mergeRequestId.toUpperCase()
    })
  });
  assert.equal(repeated.status, 200);
  const repeatedBody = await repeated.json();
  assert.equal(repeatedBody.alreadyMerged, true);
  assert.equal(repeatedBody.requestId, mergeRequestId);
});

test('multi-hop user merges flatten old aliases so registration and signatures stay canonical', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const firstSeed = '11111111-1111-4111-8111-111111111111';
  const secondSeed = '22222222-2222-4222-8222-222222222222';
  const thirdSeed = '33333333-3333-4333-8333-333333333333';
  const first = await (await activate(database, { name: 'Alice-old', deviceSeed: firstSeed })).json();
  const second = await (await activate(database, { name: 'Alice-mid', deviceSeed: secondSeed })).json();
  const third = await (await activate(database, { name: 'Alice', deviceSeed: thirdSeed })).json();
  const firstRequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  assert.equal(
    (
      await requestAdmin(database, `/api/admin/users/${encodeURIComponent(first.userId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: second.userId, requestId: firstRequestId })
      })
    ).status,
    200
  );
  assert.equal(
    (
      await requestAdmin(database, `/api/admin/users/${encodeURIComponent(second.userId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: third.userId })
      })
    ).status,
    200
  );

  const aliasSeed = '44444444-4444-4444-8444-444444444444';
  const aliasActivationResponse = await activate(database, { name: 'Alice-old', deviceSeed: aliasSeed });
  assert.equal(aliasActivationResponse.status, 200);
  const aliasIdentity = await aliasActivationResponse.json();
  assert.equal(aliasIdentity.userId, third.userId);
  assert.equal((await getClientConfig(database, aliasIdentity, aliasSeed)).status, 200);
  const oldAlias = database.queryAll('SELECT merged_into_user_id FROM users WHERE id = ?', first.userId)[0];
  assert.equal(oldAlias.merged_into_user_id, third.userId);

  const replay = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(first.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: second.userId, requestId: firstRequestId })
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.alreadyMerged, true);
  assert.equal(replayBody.targetUserId, second.userId);
});

test('use_source removes a target override when the source follows global config', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const source = await (
    await activate(database, { name: 'Source', deviceSeed: '11111111-1111-4111-8111-111111111111' })
  ).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  assert.equal(
    (await updateAdminUserConfig(database, target.userId, { subscriptionUrl: 'https://example.com/target' })).status,
    200
  );

  const merge = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId, configResolution: 'use_source' })
  });
  assert.equal(merge.status, 200);
  assert.equal(database.queryAll('SELECT user_id FROM user_remote_config WHERE user_id = ?', target.userId).length, 0);
});

test('merge request ids cannot report success for a different active source user', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const first = await (
    await activate(database, { name: 'Alice-old', deviceSeed: '11111111-1111-4111-8111-111111111111' })
  ).json();
  const second = await (
    await activate(database, { name: 'Alice-other', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  const target = await (
    await activate(database, { name: 'Alice', deviceSeed: '33333333-3333-4333-8333-333333333333' })
  ).json();
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const firstMerge = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(first.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId, requestId })
  });
  assert.equal(firstMerge.status, 200);
  const collision = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(second.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId, requestId })
  });
  assert.equal(collision.status, 409);
  assert.deepEqual(await collision.json(), { error: 'merge request conflict' });
  const secondUser = database.queryAll('SELECT status, merged_into_user_id FROM users WHERE id = ?', second.userId)[0];
  assert.equal(secondUser.status, 'active');
  assert.equal(secondUser.merged_into_user_id, null);
});

test('merge batch rejects a target that became an alias after the preview read', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const source = await (
    await activate(database, { name: 'Source', deviceSeed: '11111111-1111-4111-8111-111111111111' })
  ).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  const ultimate = await (
    await activate(database, { name: 'Ultimate', deviceSeed: '33333333-3333-4333-8333-333333333333' })
  ).json();
  let interceptBatch = true;
  const racedDatabase = {
    ...database,
    async batch(statements) {
      if (interceptBatch) {
        interceptBatch = false;
        const targetMerge = await requestAdmin(
          database,
          `/api/admin/users/${encodeURIComponent(target.userId)}/merge`,
          { method: 'POST', body: JSON.stringify({ targetUserId: ultimate.userId }) }
        );
        assert.equal(targetMerge.status, 200);
      }
      return database.batch(statements);
    }
  };

  const racedMerge = await requestAdmin(racedDatabase, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId })
  });
  assert.equal(racedMerge.status, 409);
  assert.deepEqual(await racedMerge.json(), { error: 'merge state changed' });
  const sourceUser = database.queryAll('SELECT status, merged_into_user_id FROM users WHERE id = ?', source.userId)[0];
  assert.equal(sourceUser.status, 'active');
  assert.equal(sourceUser.merged_into_user_id, null);
});

test('merge batch rejects a target config created after conflict evaluation', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const source = await (
    await activate(database, { name: 'Source', deviceSeed: '11111111-1111-4111-8111-111111111111' })
  ).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  assert.equal(
    (await updateAdminUserConfig(database, source.userId, { subscriptionUrl: 'https://example.com/source' })).status,
    200
  );
  let interceptBatch = true;
  const racedDatabase = {
    ...database,
    async batch(statements) {
      if (interceptBatch) {
        interceptBatch = false;
        await database
          .prepare(
            `INSERT INTO user_remote_config (user_id, enabled, subscription_url, rule_profile, updated_at)
             VALUES (?, 1, ?, 'ruleset', ?)`
          )
          .bind(target.userId, 'https://example.com/concurrent', '2026-07-19T01:02:03.000Z')
          .run();
      }
      return database.batch(statements);
    }
  };

  const racedMerge = await requestAdmin(racedDatabase, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: target.userId })
  });
  assert.equal(racedMerge.status, 409);
  assert.deepEqual(await racedMerge.json(), { error: 'merge state changed' });
  const targetConfig = database.queryAll(
    'SELECT subscription_url FROM user_remote_config WHERE user_id = ?',
    target.userId
  )[0];
  assert.equal(targetConfig.subscription_url, 'https://example.com/concurrent');
});

test('traffic reports use the device owner committed by a concurrent user merge', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const sourceSeed = '11111111-1111-4111-8111-111111111111';
  const source = await (await activate(database, { name: 'Source', deviceSeed: sourceSeed })).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  let interceptBatch = true;
  const racedDatabase = {
    ...database,
    async batch(statements) {
      if (interceptBatch) {
        interceptBatch = false;
        const merge = await requestAdmin(database, `/api/admin/users/${encodeURIComponent(source.userId)}/merge`, {
          method: 'POST',
          body: JSON.stringify({ targetUserId: target.userId })
        });
        assert.equal(merge.status, 200);
      }
      return database.batch(statements);
    }
  };

  const response = await reportTraffic(racedDatabase, source, sourceSeed, {
    reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadDelta: 1234,
    downloadDelta: 5678
  });
  assert.equal(response.status, 200);
  const [report] = database.queryAll(
    'SELECT user_id FROM traffic_reports WHERE id = ?',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  assert.equal(report.user_id, target.userId);
  const [daily] = database.queryAll(
    'SELECT user_id, upload_bytes, download_bytes FROM traffic_daily WHERE device_id = ?',
    source.deviceId
  );
  assert.equal(daily.user_id, target.userId);
  assert.equal(daily.upload_bytes, 1234);
  assert.equal(daily.download_bytes, 5678);
  const body = await response.json();
  assert.equal(body.traffic.totalUpload, 1234);
  assert.equal(body.traffic.totalDownload, 5678);
});

test('a concurrent merge cannot recreate a source user config override', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const source = await (
    await activate(database, { name: 'Source', deviceSeed: '11111111-1111-4111-8111-111111111111' })
  ).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  assert.equal(
    (await updateAdminUserConfig(database, target.userId, { subscriptionUrl: 'https://example.com/target' })).status,
    200
  );
  let interceptWrite = true;
  const racedDatabase = {
    ...database,
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!interceptWrite || !sql.includes('INSERT INTO user_remote_config (user_id,')) return statement;
      return {
        bind(...bindings) {
          const bound = statement.bind(...bindings);
          return {
            async run() {
              interceptWrite = false;
              const merge = await requestAdmin(
                database,
                `/api/admin/users/${encodeURIComponent(source.userId)}/merge`,
                { method: 'POST', body: JSON.stringify({ targetUserId: target.userId }) }
              );
              assert.equal(merge.status, 200);
              return bound.run();
            }
          };
        }
      };
    }
  };

  const response = await updateAdminUserConfig(racedDatabase, source.userId, {
    subscriptionUrl: 'https://example.com/stale-source'
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'unknown user' });
  assert.equal(database.queryAll('SELECT user_id FROM user_remote_config WHERE user_id = ?', source.userId).length, 0);
  const [targetConfig] = database.queryAll(
    'SELECT subscription_url FROM user_remote_config WHERE user_id = ?',
    target.userId
  );
  assert.equal(targetConfig.subscription_url, 'https://example.com/target');
});

test('client config reads the device current owner after a concurrent merge', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const sourceSeed = '11111111-1111-4111-8111-111111111111';
  const source = await (await activate(database, { name: 'Source', deviceSeed: sourceSeed })).json();
  const target = await (
    await activate(database, { name: 'Target', deviceSeed: '22222222-2222-4222-8222-222222222222' })
  ).json();
  assert.equal(
    (await updateAdminUserConfig(database, source.userId, { subscriptionUrl: 'https://example.com/source' })).status,
    200
  );
  assert.equal(
    (await updateAdminUserConfig(database, target.userId, { subscriptionUrl: 'https://example.com/target' })).status,
    200
  );
  let interceptRead = true;
  const racedDatabase = {
    ...database,
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!interceptRead || !sql.includes('INNER JOIN remote_config ON remote_config.id = 1')) return statement;
      return {
        bind(...bindings) {
          const bound = statement.bind(...bindings);
          return {
            async first() {
              interceptRead = false;
              const merge = await requestAdmin(
                database,
                `/api/admin/users/${encodeURIComponent(source.userId)}/merge`,
                {
                  method: 'POST',
                  body: JSON.stringify({ targetUserId: target.userId, configResolution: 'keep_target' })
                }
              );
              assert.equal(merge.status, 200);
              return bound.first();
            }
          };
        }
      };
    }
  };

  const response = await getClientConfig(racedDatabase, source, sourceSeed);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.subscriptionUrl, 'https://example.com/target');
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
    subscriptionUrl: 'https://example.com/bob-sub'
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

test('admin page exposes the redesigned two-profile workspace without removed controls', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const response = await worker.fetch(new Request('https://worker.example/admin'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: adminToken
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  const contentSecurityPolicy = response.headers.get('content-security-policy') ?? '';
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  assert.match(contentSecurityPolicy, /script-src 'unsafe-inline';/);
  assert.doesNotMatch(contentSecurityPolicy, /static\.cloudflareinsights\.com/);
  assert.match(contentSecurityPolicy, /connect-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const page = await response.text();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(page, /class="admin-workspace"/);
  assert.match(page, /id="changeToken"[^>]*aria-expanded="true"/);
  assert.match(page, /class="management-grid"/);
  assert.match(page, /<table class="users-table">\s*<colgroup>/);
  assert.match(page, /html\s*\{[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable both-edges;/);
  assert.match(page, /table\s*\{[^}]*table-layout:\s*fixed;/);
  assert.match(page, /\.sort-mark\s*\{[^}]*width:\s*16px;/);
  assert.doesNotMatch(page, /scrollIntoView\(/);
  assert.doesNotMatch(page, /button\[aria-busy="true"\]\s*\{[^}]*padding-right:/);
  assert.match(page, /let committedToken = sessionToken \|\| legacyToken;/);
  assert.match(page, /const token = tokenOverride \|\| committedToken;/);
  assert.doesNotMatch(page, /tokenInput\.value\.trim\(\) \|\| sessionStorage/);
  assert.match(page, /value="ruleset">智能规则/);
  assert.match(page, /value="subscription">机场规则/);
  assert.match(page, /id="mergeTitle">合并用户/);
  for (const removed of [
    '兼容机场',
    '本地规则',
    '全局代理',
    '直联规则',
    '代理规则',
    '异常阈值',
    '启动选择',
    'preferredNode',
    'preferredStrategy',
    'directRules',
    'proxyRules',
    'anomalyThresholdBytes'
  ]) {
    assert.equal(page.includes(removed), false, removed);
  }
});

test('admin page never uses an unsubmitted token draft for API requests', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const response = await worker.fetch(new Request('https://worker.example/admin'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: adminToken
  });
  const page = await response.text();
  const requests = [];
  const dom = new JSDOM(page, {
    beforeParse(window) {
      window.sessionStorage.setItem('youyu_admin_token', 'committed-token');
      window.fetch = async (input, init = {}) => {
        const path = String(input);
        requests.push({ path, authorization: init.headers?.authorization });
        const body = path.endsWith('/config')
          ? { config: {} }
          : path.endsWith('/users')
            ? { users: [] }
            : { anomalies: [] };
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status: 200
        });
      };
    },
    runScripts: 'dangerously',
    url: 'https://worker.example/admin'
  });
  context.after(() => dom.window.close());

  const document = dom.window.document;
  await waitFor(() => document.getElementById('adminWorkspace').hidden === false);
  assert.equal(document.getElementById('changeToken').getAttribute('aria-expanded'), 'false');
  assert.ok(requests.length >= 3);
  assert.ok(requests.every((request) => request.authorization === 'Bearer committed-token'));

  document.getElementById('changeToken').click();
  const tokenInput = document.getElementById('token');
  tokenInput.value = 'unsaved-token';
  const refreshButton = document.getElementById('refresh');
  const requestCount = requests.length;
  refreshButton.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  refreshButton.click();

  await waitFor(() => requests.length >= requestCount + 3);
  assert.equal(tokenInput.value, 'committed-token');
  assert.equal(document.getElementById('changeToken').getAttribute('aria-expanded'), 'false');
  assert.ok(requests.slice(requestCount).every((request) => request.authorization === 'Bearer committed-token'));
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

test('admin config exposes only status, subscription, and the two supported rule profiles', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  for (const ruleProfile of ['ruleset', 'subscription']) {
    const response = await updateAdminConfig(database, { enabled: true, ruleProfile });
    assert.equal(response.status, 200, ruleProfile);
    assert.equal((await response.json()).config.ruleProfile, ruleProfile);
  }

  for (const ruleProfile of ['smart', 'global']) {
    const response = await updateAdminConfig(database, { ruleProfile });
    assert.equal(response.status, 400, ruleProfile);
    assert.deepEqual(await response.json(), { error: 'invalid rule profile' });
  }

  for (const field of [
    { preferredNode: 'Node A' },
    { preferredStrategy: 'auto' },
    { directRules: ['DOMAIN,direct.test'] },
    { proxyRules: ['DOMAIN,proxy.test'] },
    { anomalyThresholdBytes: 1024 }
  ]) {
    const response = await updateAdminConfig(database, field);
    assert.equal(response.status, 400, JSON.stringify(field));
    assert.deepEqual(await response.json(), { error: 'unsupported config field' });
  }

  const config = (await (await getAdminConfig(database)).json()).config;
  assert.deepEqual(config.directRules, []);
  assert.deepEqual(config.proxyRules, []);
  assert.equal(config.anomalyThresholdBytes, 1024 * 1024 * 1024);
  for (const removedField of ['preferredNode', 'preferredStrategy']) {
    assert.equal(removedField in config, false, removedField);
  }
});

test('global config rejects invalid recognized fields without changing stored config', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baselineResponse = await updateAdminConfig(database, {
    enabled: true,
    subscriptionUrl: 'https://example.com/sub',
    ruleProfile: 'ruleset'
  });
  assert.equal(baselineResponse.status, 200);
  const baseline = (await baselineResponse.json()).config;

  const cases = [
    { input: { enabled: 'true' }, error: 'invalid enabled' },
    { input: { subscriptionUrl: 42 }, error: 'invalid subscription url' },
    { input: { enabled: false, ruleProfile: 'unsupported' }, error: 'invalid rule profile' },
    { input: { preferredNode: 42 }, error: 'unsupported config field' },
    { input: { preferredStrategy: 'unsupported' }, error: 'unsupported config field' },
    { input: { anomalyThresholdBytes: null }, error: 'unsupported config field' }
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
    ruleProfile: 'subscription'
  });
  assert.equal(baselineResponse.status, 200);

  const patchedResponse = await updateAdminUserConfig(database, 'user-1', { ruleProfile: 'ruleset' });
  assert.equal(patchedResponse.status, 200);
  const patched = (await patchedResponse.json()).override;
  assert.equal(patched.enabled, false);
  assert.equal(patched.subscriptionUrl, 'https://example.com/user-sub');
  assert.equal(patched.ruleProfile, 'ruleset');

  const clearedResponse = await updateAdminUserConfig(database, 'user-1', { subscriptionUrl: null });
  assert.equal(clearedResponse.status, 200);
  const cleared = (await clearedResponse.json()).override;
  assert.equal('subscriptionUrl' in cleared, false);
  assert.equal(cleared.ruleProfile, 'ruleset');

  const invalidResponse = await updateAdminUserConfig(database, 'user-1', {
    enabled: true,
    ruleProfile: 'unsupported'
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: 'invalid rule profile' });

  const unsupportedThreshold = await updateAdminUserConfig(database, 'user-1', { anomalyThresholdBytes: 1024 });
  assert.equal(unsupportedThreshold.status, 400);
  assert.deepEqual(await unsupportedThreshold.json(), { error: 'unsupported config field' });

  const currentResponse = await getAdminUserConfig(database, 'user-1');
  assert.equal(currentResponse.status, 200);
  const current = (await currentResponse.json()).override;
  assert.equal(current.enabled, false);
  assert.equal('subscriptionUrl' in current, false);
  assert.equal(current.ruleProfile, 'ruleset');
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
    subscriptionUrl: 'https://example.com/initial'
  });
  assert.equal(baselineResponse.status, 200);
  const baseline = (await baselineResponse.json()).config;

  const responses = await Promise.all([
    updateAdminConfig(database, { ruleProfile: 'subscription' }),
    updateAdminConfig(database, { subscriptionUrl: 'https://example.com/final' })
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  );

  const finalResponse = await getAdminConfig(database);
  assert.equal(finalResponse.status, 200);
  const final = (await finalResponse.json()).config;
  assert.equal(final.ruleProfile, 'subscription');
  assert.equal(final.subscriptionUrl, 'https://example.com/final');
  assert.equal(final.version, baseline.version + 2);
});

test('explicit null clears nullable global choices and restores the default rule profile', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baseline = await updateAdminConfig(database, {
    ruleProfile: 'subscription',
    subscriptionUrl: 'https://example.com/sub'
  });
  assert.equal(baseline.status, 200);

  const cleared = await updateAdminConfig(database, {
    ruleProfile: null,
    subscriptionUrl: null
  });
  assert.equal(cleared.status, 200);
  const config = (await cleared.json()).config;
  assert.equal(config.ruleProfile, 'ruleset');
  assert.equal('subscriptionUrl' in config, false);
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

async function reportTraffic(database, identity, deviceSeed, input) {
  const url = new URL('https://worker.example/api/traffic/report');
  const body = JSON.stringify({
    reportId: input.reportId,
    userId: identity.userId,
    deviceId: identity.deviceId,
    uploadDelta: input.uploadDelta,
    downloadDelta: input.downloadDelta,
    reportedAt: input.reportedAt ?? new Date().toISOString(),
    appVersion: input.appVersion ?? '1.6.6'
  });
  const timestamp = String(Date.now());
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = ['POST', url.pathname, timestamp, bodyHash].join('\n');
  const signature = createHmac('sha256', deviceSeed).update(canonical).digest('hex');

  return worker.fetch(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-youyu-timestamp': timestamp,
        'x-youyu-signature': signature
      },
      body
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
  return requestAdmin(database, path, { method: 'POST', body });
}

async function requestAdmin(database, path, options = {}) {
  return worker.fetch(
    new Request(`https://worker.example${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      }
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
