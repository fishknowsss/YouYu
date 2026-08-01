import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import worker, { cleanupExpiredData } from '../src/index.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const trafficDedupMigration = readFileSync(
  new URL('../migrations/2026-08-01-persist-traffic-report-dedup.sql', import.meta.url),
  'utf8'
);
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

async function assertWorkerError(response, status, message, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(await response.json(), {
    error: message,
    code: code ?? message.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    requestId
  });
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

test('admin collection routes use bounded pages and disclose whether more rows exist', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  for (let index = 0; index < 5; index += 1) {
    await addKnownUser(database, `user-${index}`);
  }
  await database
    .prepare(
      `INSERT INTO devices
         (id, user_id, device_seed, device_name, platform, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind('device-0', 'user-0', 'seed-0', 'Primary PC', 'win32', '2026-07-10T00:00:00.000Z', '2026-07-13T00:00:00.000Z')
    .run();
  for (let index = 1; index <= 3; index += 1) {
    const day = `2026-07-${String(index).padStart(2, '0')}`;
    await database
      .prepare(
        `INSERT INTO traffic_daily
           (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind('user-0', 'device-0', day, index, index * 2, `${day}T00:00:00.000Z`)
      .run();
    await database
      .prepare(
        `INSERT INTO traffic_anomalies
           (id, user_id, device_id, date, upload_delta, download_delta, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(`anomaly-${index}`, 'user-0', 'device-0', day, index, index * 2, 'traffic_spike', `${day}T00:00:00.000Z`)
      .run();
  }

  const users = await (await requestAdmin(database, '/api/admin/users?limit=2&offset=1')).json();
  assert.equal(users.users.length, 2);
  assert.deepEqual(users.page, { limit: 2, offset: 1, returned: 2, hasMore: true, nextOffset: 3 });

  const traffic = await (await requestAdmin(database, '/api/admin/users/user-0/traffic?limit=1&offset=1')).json();
  assert.equal(traffic.rows.length, 1);
  assert.deepEqual(traffic.page, { limit: 1, offset: 1, returned: 1, hasMore: true, nextOffset: 2 });

  const anomalies = await (await requestAdmin(database, '/api/admin/anomalies?limit=2&offset=1')).json();
  assert.equal(anomalies.anomalies.length, 2);
  assert.deepEqual(anomalies.page, { limit: 2, offset: 1, returned: 2, hasMore: false, nextOffset: null });
});

test('admin collection routes reject ambiguous, unsupported, or excessive pagination', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  for (const query of [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'offset=-1',
    'offset=1000001',
    'limit=1&limit=2',
    'unknown=1'
  ]) {
    const response = await requestAdmin(database, `/api/admin/users?${query}`);
    await assertWorkerError(response, 400, 'invalid pagination', 'INVALID_PAGINATION');
  }
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
  await assertWorkerError(unresolved, 409, 'config conflict');

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
  await assertWorkerError(collision, 409, 'merge request conflict');
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
  await assertWorkerError(racedMerge, 409, 'merge state changed');
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
  await assertWorkerError(racedMerge, 409, 'merge state changed');
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

test('traffic report deduplication survives audit cleanup and rejects a reused id with a changed payload', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceSeed = '11111111-1111-4111-8111-111111111111';
  const identity = await (await activate(database, { name: 'Alice', deviceSeed })).json();
  const input = {
    reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadDelta: 1234,
    downloadDelta: 5678,
    reportedAt: '2026-08-01T01:02:03.000Z',
    appVersion: '1.6.6'
  };

  const accepted = await reportTraffic(database, identity, deviceSeed, input);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).duplicate, undefined);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_reports')[0].count, 1);
  const [proof] = database.queryAll(
    `SELECT
       payload_hash,
       legacy_device_id,
       legacy_upload_delta,
       legacy_download_delta,
       legacy_reported_at
     FROM traffic_report_dedup
     WHERE id = ?`,
    input.reportId
  );
  assert.match(proof.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(proof.legacy_device_id, null);
  assert.equal(proof.legacy_upload_delta, null);
  assert.equal(proof.legacy_download_delta, null);
  assert.equal(proof.legacy_reported_at, null);

  const cleanup = await cleanupExpiredData({ DB: database }, Date.now() + 91 * 24 * 60 * 60 * 1000);
  assert.equal(cleanup.deletedReportRows, 1);
  assert.deepEqual(database.queryAll('SELECT id FROM traffic_reports'), []);
  assert.deepEqual(
    database.queryAll('SELECT id FROM traffic_report_dedup').map((row) => ({ ...row })),
    [{ id: input.reportId }]
  );

  const retry = await reportTraffic(database, identity, deviceSeed, input);
  assert.equal(retry.status, 200);
  const retried = await retry.json();
  assert.equal(retried.duplicate, true);
  assert.equal(retried.anomaly, false);

  for (const changedInput of [
    { ...input, downloadDelta: input.downloadDelta + 1 },
    { ...input, reportedAt: '2026-08-01T01:02:04.000Z' }
  ]) {
    const conflict = await reportTraffic(database, identity, deviceSeed, changedInput);
    await assertWorkerError(conflict, 409, 'report id conflict', 'REPORT_ID_CONFLICT');
  }

  const [daily] = database.queryAll(
    'SELECT upload_bytes, download_bytes FROM traffic_daily WHERE device_id = ?',
    identity.deviceId
  );
  assert.deepEqual({ ...daily }, { upload_bytes: input.uploadDelta, download_bytes: input.downloadDelta });

  const upgradedAppRetry = await reportTraffic(database, identity, deviceSeed, { ...input, appVersion: '1.6.7' });
  assert.equal(upgradedAppRetry.status, 200);
  assert.equal((await upgradedAppRetry.json()).duplicate, true);
});

test('zero-traffic heartbeats stay idempotent without permanent proofs and do not reserve report ids', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceSeed = '11111111-1111-4111-8111-111111111111';
  const identity = await (await activate(database, { name: 'Alice', deviceSeed })).json();
  const input = {
    reportId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    uploadDelta: 0,
    downloadDelta: 0,
    reportedAt: '2026-08-01T01:02:03.000Z',
    appVersion: '1.6.6'
  };

  assert.equal((await reportTraffic(database, identity, deviceSeed, input)).status, 200);
  const retry = await reportTraffic(database, identity, deviceSeed, input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, undefined);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_report_dedup')[0].count, 0);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_reports')[0].count, 0);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_daily')[0].count, 0);

  const counted = await reportTraffic(database, identity, deviceSeed, { ...input, uploadDelta: 1 });
  assert.equal(counted.status, 200);
  assert.equal((await counted.json()).duplicate, undefined);
  const duplicate = await reportTraffic(database, identity, deviceSeed, { ...input, uploadDelta: 1 });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_report_dedup')[0].count, 1);
  assert.equal(database.queryAll('SELECT COUNT(*) AS count FROM traffic_reports')[0].count, 1);
  assert.equal(database.queryAll('SELECT upload_bytes FROM traffic_daily')[0].upload_bytes, 1);
});

test('the first retry of a migrated audit row seals its exact payload without recounting traffic', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceSeed = '11111111-1111-4111-8111-111111111111';
  const identity = await (await activate(database, { name: 'Alice', deviceSeed })).json();
  const receivedAt = new Date();
  const trafficDate = toTrafficDateKey(receivedAt);
  const input = {
    reportId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    uploadDelta: 321,
    downloadDelta: 654,
    reportedAt: '2026-08-01T02:03:04.000Z',
    appVersion: '1.6.6'
  };

  database.exec('DROP TABLE traffic_report_dedup');
  await database
    .prepare(
      `INSERT INTO traffic_reports
         (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.reportId,
      identity.userId,
      identity.deviceId,
      input.uploadDelta,
      input.downloadDelta,
      input.reportedAt,
      receivedAt.toISOString()
    )
    .run();
  await database
    .prepare(
      `INSERT INTO traffic_daily
         (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      identity.userId,
      identity.deviceId,
      trafficDate,
      input.uploadDelta,
      input.downloadDelta,
      receivedAt.toISOString()
    )
    .run();
  database.exec(trafficDedupMigration);

  const retry = await reportTraffic(database, identity, deviceSeed, input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  const [proof] = database.queryAll(
    `SELECT payload_hash, legacy_device_id, legacy_upload_delta, legacy_download_delta, legacy_reported_at
     FROM traffic_report_dedup WHERE id = ?`,
    input.reportId
  );
  assert.match(proof.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(proof.legacy_device_id, null);
  assert.equal(proof.legacy_upload_delta, null);
  assert.equal(proof.legacy_download_delta, null);
  assert.equal(proof.legacy_reported_at, null);
  const [daily] = database.queryAll(
    'SELECT upload_bytes, download_bytes FROM traffic_daily WHERE device_id = ?',
    identity.deviceId
  );
  assert.deepEqual({ ...daily }, { upload_bytes: input.uploadDelta, download_bytes: input.downloadDelta });

  const conflict = await reportTraffic(database, identity, deviceSeed, {
    ...input,
    reportedAt: '2026-08-01T02:03:05.000Z'
  });
  await assertWorkerError(conflict, 409, 'report id conflict', 'REPORT_ID_CONFLICT');
});

test('a report accepted between schema migration and Worker rollout self-heals its missing proof', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceSeed = '11111111-1111-4111-8111-111111111111';
  const identity = await (await activate(database, { name: 'Alice', deviceSeed })).json();
  const receivedAt = new Date();
  const input = {
    reportId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    uploadDelta: 111,
    downloadDelta: 222,
    reportedAt: '2026-08-01T03:04:05.000Z',
    appVersion: '1.6.6'
  };
  await database
    .prepare(
      `INSERT INTO traffic_reports
         (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.reportId,
      identity.userId,
      identity.deviceId,
      input.uploadDelta,
      input.downloadDelta,
      input.reportedAt,
      receivedAt.toISOString()
    )
    .run();
  await database
    .prepare(
      `INSERT INTO traffic_daily
         (user_id, device_id, date, upload_bytes, download_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      identity.userId,
      identity.deviceId,
      toTrafficDateKey(receivedAt),
      input.uploadDelta,
      input.downloadDelta,
      receivedAt.toISOString()
    )
    .run();

  const retry = await reportTraffic(database, identity, deviceSeed, input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.match(
    database.queryAll('SELECT payload_hash FROM traffic_report_dedup WHERE id = ?', input.reportId)[0].payload_hash,
    /^[0-9a-f]{64}$/
  );
  const [daily] = database.queryAll(
    'SELECT upload_bytes, download_bytes FROM traffic_daily WHERE device_id = ?',
    identity.deviceId
  );
  assert.deepEqual({ ...daily }, { upload_bytes: input.uploadDelta, download_bytes: input.downloadDelta });
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
  await assertWorkerError(response, 404, 'unknown user');
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
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(await response.json(), {
    error: 'invalid json',
    code: 'INVALID_JSON',
    requestId
  });
});

test('JSON write routes reject unsupported media types and invalid declared lengths before reading', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const env = {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase
  };

  const wrongType = await worker.fetch(
    new Request('https://worker.example/api/activate', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    }),
    env
  );
  await assertWorkerError(wrongType, 415, 'unsupported media type', 'UNSUPPORTED_MEDIA_TYPE');

  for (const declaredLength of ['-1', '1.5', 'not-a-number']) {
    const request = createStreamRequest('/api/activate', [new TextEncoder().encode('{}')], {
      'content-length': declaredLength
    });
    const response = await worker.fetch(request, env);
    await assertWorkerError(response, 400, 'invalid content length', 'INVALID_CONTENT_LENGTH');
  }
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
  await assertWorkerError(response, 403, 'admin disabled');
});

test('a valid admin token bypasses rate-limit storage entirely', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const rateLimitStatements = [];
  const observedDatabase = {
    ...database,
    prepare(sql) {
      if (/\brate_limits\b/i.test(sql)) rateLimitStatements.push(sql);
      return database.prepare(sql);
    }
  };

  const response = await worker.fetch(
    new Request('https://worker.example/api/admin/users', {
      headers: { authorization: `Bearer ${adminToken}`, 'cf-connecting-ip': '203.0.113.10' }
    }),
    {
      DB: observedDatabase,
      REGISTRATION_PASSPHRASE: registrationPassphrase,
      ADMIN_TOKEN: adminToken
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(rateLimitStatements, []);
});

test('invalid admin tokens consume the failure window and return 429 only after the threshold', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const requestInvalidAdmin = () =>
    worker.fetch(
      new Request('https://worker.example/api/admin/users', {
        headers: { authorization: 'Bearer invalid-admin-token', 'cf-connecting-ip': '203.0.113.11' }
      }),
      {
        DB: database,
        REGISTRATION_PASSPHRASE: registrationPassphrase,
        ADMIN_TOKEN: adminToken
      }
    );

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await assertWorkerError(await requestInvalidAdmin(), 403, 'forbidden', 'FORBIDDEN');
  }
  await assertWorkerError(await requestInvalidAdmin(), 429, 'too many attempts', 'TOO_MANY_ATTEMPTS');

  assert.deepEqual(
    database
      .queryAll('SELECT attempts FROM rate_limits WHERE key = ?', 'admin:203.0.113.11')
      .map((row) => row.attempts),
    [11]
  );
});

test('prior admin failures never block or clear a valid token and expire naturally', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const clientIp = '203.0.113.12';
  const requestAdminToken = (token) =>
    worker.fetch(
      new Request('https://worker.example/api/admin/users', {
        headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': clientIp }
      }),
      {
        DB: database,
        REGISTRATION_PASSPHRASE: registrationPassphrase,
        ADMIN_TOKEN: adminToken
      }
    );

  for (let attempt = 1; attempt <= 11; attempt += 1) {
    await requestAdminToken('invalid-admin-token');
  }

  const validResponse = await requestAdminToken(adminToken);
  assert.equal(validResponse.status, 200);
  assert.deepEqual(
    database.queryAll('SELECT attempts FROM rate_limits WHERE key = ?', `admin:${clientIp}`).map((row) => row.attempts),
    [11]
  );

  database
    .prepare('UPDATE rate_limits SET reset_at = ? WHERE key = ?')
    .bind(Date.now() - 1, `admin:${clientIp}`)
    .run();
  await assertWorkerError(await requestAdminToken('invalid-admin-token'), 403, 'forbidden', 'FORBIDDEN');
  assert.deepEqual(
    database.queryAll('SELECT attempts FROM rate_limits WHERE key = ?', `admin:${clientIp}`).map((row) => row.attempts),
    [1]
  );
});

test('admin page exposes the fixed-viewport management workspace without removed controls', async (context) => {
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
  assert.match(contentSecurityPolicy, /script-src 'self'/);
  assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);
  assert.match(contentSecurityPolicy, /(?:^|; )style-src 'self'(?:;|$)/);
  assert.match(contentSecurityPolicy, /style-src-attr 'unsafe-inline'/);
  assert.doesNotMatch(contentSecurityPolicy, /static\.cloudflareinsights\.com/);
  assert.match(contentSecurityPolicy, /connect-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const page = await response.text();
  assert.match(page, /<link rel="stylesheet" href="\/admin\/assets\/app\.css" \/>/);
  assert.match(page, /<script src="\/admin\/assets\/app\.js" defer><\/script>/);
  assert.doesNotMatch(page, /<script>([\s\S]*?)<\/script>/);
  assert.doesNotMatch(page, /<style>([\s\S]*?)<\/style>/);

  const scriptResponse = await worker.fetch(new Request('https://worker.example/admin/assets/app.js'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: adminToken
  });
  assert.equal(scriptResponse.status, 200);
  assert.equal(scriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(scriptResponse.headers.get('x-content-type-options'), 'nosniff');
  const script = await scriptResponse.text();
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /localStorage|sessionStorage|\.innerHTML|\.outerHTML|insertAdjacentHTML/);

  const styleResponse = await worker.fetch(new Request('https://worker.example/admin/assets/app.css'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: adminToken
  });
  assert.equal(styleResponse.status, 200);
  assert.equal(styleResponse.headers.get('content-type'), 'text/css; charset=utf-8');
  const styles = await styleResponse.text();
  assert.match(page, /class="admin-workspace"/);
  assert.match(page, /id="changeToken"[^>]*aria-expanded="true"/);
  assert.match(page, /class="management-grid"/);
  assert.match(page, /<table class="users-table">\s*<colgroup>/);
  assert.match(styles, /html,\s*body\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/);
  assert.match(styles, /\.view-panel:not\(\[hidden\]\)\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/);
  assert.match(page, /id="trafficPagination"/);
  assert.match(page, /data-section-switcher="overview"/);
  assert.match(page, /data-overview-pane="trend"/);
  assert.match(page, /data-trend-range="hour">分时/);
  assert.match(page, /data-trend-range="day">日/);
  assert.match(page, /data-trend-range="month">月/);
  assert.match(page, /data-stat="todayReported"/);
  assert.match(page, /class="metric-pair"/);
  assert.match(page, /<th class="num">上传<\/th><th class="num">下载<\/th>/);
  assert.match(page, /id="trafficExpiresAt" type="datetime-local"/);
  assert.match(styles, /grid-template-areas:\s*"trend quota"\s*"users ranking"\s*"users anomalies"/);
  assert.doesNotMatch(page, /实时在线|当日在线/);
  assert.match(styles, /table\s*\{[^}]*table-layout:\s*fixed;/);
  assert.match(styles, /\.sort-mark\s*\{[^}]*width:\s*16px;/);
  assert.doesNotMatch(script, /scrollIntoView\(/);
  assert.doesNotMatch(styles, /button\[aria-busy="true"\]\s*\{[^}]*padding-right:/);
  assert.match(script, /let committedToken = '';/);
  assert.match(script, /const token = tokenOverride \|\| committedToken;/);
  assert.match(page, /value="ruleset">智能规则/);
  assert.match(page, /value="subscription">机场规则/);
  assert.match(page, /data-drawer-tab="merge">合并用户/);
  assert.match(page, /id="previewMerge"[^>]*>预览合并/);
  assert.doesNotMatch(page, /查看、筛选和配置(?:登记)?用户/);
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
  const script = await (
    await worker.fetch(new Request('https://worker.example/admin/assets/app.js'), {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase,
      ADMIN_TOKEN: adminToken
    })
  ).text();
  const requests = [];
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    url: 'https://worker.example/admin'
  });
  context.after(() => dom.window.close());

  const document = dom.window.document;
  dom.window.fetch = async (input, init = {}) => {
    const path = String(input);
    const url = new URL(path, 'https://worker.example');
    const headers = new Headers(init.headers);
    requests.push({ path, authorization: headers.get('authorization') });
    const body = url.pathname.endsWith('/config')
      ? { config: {} }
      : url.pathname === '/api/admin/users'
        ? url.searchParams.get('offset') === '1'
          ? { users: [], page: { limit: 200, offset: 1, returned: 0, hasMore: false, nextOffset: null } }
          : {
              users: [{ id: 'user-1', name: 'Paged User' }],
              page: { limit: 200, offset: 0, returned: 1, hasMore: true, nextOffset: 1 }
            }
        : url.pathname.includes('/traffic-limit')
          ? { trafficLimitBytes: 3380139261952, trafficExpiresAt: '2026-08-11T20:00:00.000Z' }
          : url.pathname.includes('/traffic-trend')
            ? { points: [] }
            : { anomalies: [], page: { limit: 100, offset: 0, returned: 0, hasMore: false, nextOffset: null } };
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status: 200
    });
  };
  dom.window.eval(script);
  const tokenInput = document.getElementById('token');
  tokenInput.value = 'committed-token';
  document
    .getElementById('authPanel')
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(tokenInput.value, '', 'the submitted token must leave the DOM before network requests settle');
  await waitFor(() => document.getElementById('adminWorkspace').hidden === false);
  assert.equal(document.getElementById('changeToken').getAttribute('aria-expanded'), 'false');
  assert.equal(tokenInput.value, '');
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
  assert.ok(requests.length >= 5);
  assert.ok(requests.every((request) => request.authorization === 'Bearer committed-token'));
  assert.ok(requests.some((request) => request.path.includes('/api/admin/users?limit=200&offset=1')));

  document.getElementById('changeToken').click();
  tokenInput.value = 'unsaved-token';
  const refreshButton = document.getElementById('refresh');
  const requestCount = requests.length;
  refreshButton.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  refreshButton.click();

  await waitFor(() => requests.length >= requestCount + 5);
  assert.equal(tokenInput.value, '');
  assert.equal(document.getElementById('changeToken').getAttribute('aria-expanded'), 'false');
  assert.ok(requests.slice(requestCount).every((request) => request.authorization === 'Bearer committed-token'));
});

test('admin writes reject non-object JSON and bodies larger than 64 KiB', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  for (const path of ['/api/admin/config', '/api/admin/traffic-limit', '/api/admin/users/user-1/config']) {
    const nonObject = await requestAdminConfig(database, path, '[]');
    assert.equal(nonObject.status, 400, path);
    await assertWorkerError(nonObject, 400, 'invalid json');

    const oversized = await requestAdminConfig(
      database,
      path,
      JSON.stringify({ padding: 'x'.repeat(maxAdminConfigBodyBytes) })
    );
    assert.equal(oversized.status, 413, path);
    await assertWorkerError(oversized, 413, 'request too large');
  }
});

test('admin traffic limit reports cumulative usage for active canonical users', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await database.batch([
    database.prepare(`
      INSERT INTO users (id, name, normalized_name, status, created_at, merged_into_user_id) VALUES
        ('user-1', 'Alice', 'alice', 'active', '2026-07-19T00:00:00.000Z', NULL),
        ('user-2', 'Bob', 'bob', 'active', '2026-07-19T00:00:00.000Z', NULL),
        ('user-merged', 'Merged', 'merged', 'merged', '2026-07-19T00:00:00.000Z', 'user-1'),
        ('user-disabled', 'Disabled', 'disabled', 'disabled', '2026-07-19T00:00:00.000Z', NULL)`),
    database.prepare(`
      INSERT INTO devices (id, user_id, device_seed, first_seen_at, last_seen_at) VALUES
        ('device-1', 'user-1', 'seed-1', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
        ('device-2', 'user-2', 'seed-2', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
        ('device-merged', 'user-merged', 'seed-merged', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
        ('device-disabled', 'user-disabled', 'seed-disabled', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')`),
    database.prepare(`
      INSERT INTO traffic_daily (user_id, device_id, date, upload_bytes, download_bytes, updated_at) VALUES
        ('user-1', 'device-1', '2026-07-18', 100, 200, '2026-07-19T00:00:00.000Z'),
        ('user-1', 'device-1', '2026-07-19', 50, 75, '2026-07-19T00:00:00.000Z'),
        ('user-2', 'device-2', '2026-07-19', 25, 50, '2026-07-19T00:00:00.000Z'),
        ('user-merged', 'device-merged', '2026-07-19', 1000, 2000, '2026-07-19T00:00:00.000Z'),
        ('user-disabled', 'device-disabled', '2026-07-19', 1000, 2000, '2026-07-19T00:00:00.000Z')`)
  ]);

  const defaultResponse = await getAdminTrafficLimit(database);
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(await defaultResponse.json(), {
    trafficLimitBytes: 3380139261952,
    trafficExpiresAt: '2026-08-11T20:00:00.000Z',
    uploadBytes: 175,
    downloadBytes: 325,
    usedBytes: 500,
    remainingBytes: 3380139261452,
    exceededBytes: 0,
    usagePercent: (500 / 3380139261952) * 100
  });

  const updatedResponse = await updateAdminTrafficLimit(database, { trafficLimitBytes: 400 });
  assert.equal(updatedResponse.status, 200);
  assert.deepEqual(await updatedResponse.json(), {
    trafficLimitBytes: 400,
    trafficExpiresAt: '2026-08-11T20:00:00.000Z',
    uploadBytes: 175,
    downloadBytes: 325,
    usedBytes: 500,
    remainingBytes: 0,
    exceededBytes: 100,
    usagePercent: 125
  });
});

test('admin traffic limit strictly validates input and leaves the stored value unchanged', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const baseline = await updateAdminTrafficLimit(database, { trafficLimitBytes: 1000 });
  assert.equal(baseline.status, 200);

  for (const input of [
    {},
    { trafficLimitBytes: null },
    { trafficLimitBytes: '1000' },
    { trafficLimitBytes: 0 },
    { trafficLimitBytes: -1 },
    { trafficLimitBytes: 1.5 },
    { trafficLimitBytes: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const response = await updateAdminTrafficLimit(database, input);
    assert.equal(response.status, 400, JSON.stringify(input));
    await assertWorkerError(response, 400, 'invalid traffic limit');
  }

  const unsupported = await updateAdminTrafficLimit(database, { trafficLimitBytes: 1000, enabled: true });
  assert.equal(unsupported.status, 400);
  await assertWorkerError(unsupported, 400, 'unsupported traffic limit field');

  const current = await getAdminTrafficLimit(database);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).trafficLimitBytes, 1000);

  const expiryOnly = await updateAdminTrafficLimit(database, {
    trafficExpiresAt: '2026-08-12T04:00:00+08:00'
  });
  assert.equal(expiryOnly.status, 200);
  const expiryPayload = await expiryOnly.json();
  assert.equal(expiryPayload.trafficLimitBytes, 1000);
  assert.equal(expiryPayload.trafficExpiresAt, '2026-08-11T20:00:00.000Z');

  for (const trafficExpiresAt of [
    null,
    '2026-08-12',
    '2026-08-12T04:00:00',
    '2026-02-30T04:00:00+08:00',
    'not-a-date'
  ]) {
    const invalidExpiry = await updateAdminTrafficLimit(database, { trafficExpiresAt });
    assert.equal(invalidExpiry.status, 400, String(trafficExpiresAt));
    await assertWorkerError(invalidExpiry, 400, 'invalid traffic expiry');
  }

  const existingConfig = await updateAdminConfig(database, { trafficLimitBytes: 1000 });
  assert.equal(existingConfig.status, 400);
  await assertWorkerError(existingConfig, 400, 'unsupported config field');
});

test('admin traffic trend aggregates trusted active canonical data and fills each range', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const now = new Date();
  const shiftedNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const today = shiftedNow.toISOString().slice(0, 10);
  const yesterday = new Date(shiftedNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const olderDate = new Date(Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth() - 3, 15))
    .toISOString()
    .slice(0, 10);
  await database.batch([
    database
      .prepare(
        `
      INSERT INTO users (id, name, normalized_name, status, created_at, merged_into_user_id) VALUES
        ('user-1', 'Alice', 'alice', 'active', ?, NULL),
        ('user-2', 'Bob', 'bob', 'active', ?, NULL),
        ('user-merged', 'Merged', 'merged', 'merged', ?, 'user-1'),
        ('user-disabled', 'Disabled', 'disabled', 'disabled', ?, NULL)`
      )
      .bind(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString()),
    database
      .prepare(
        `
      INSERT INTO devices (id, user_id, device_seed, first_seen_at, last_seen_at) VALUES
        ('device-1', 'user-1', 'seed-1', ?, ?),
        ('device-2', 'user-2', 'seed-2', ?, ?),
        ('device-merged', 'user-merged', 'seed-merged', ?, ?),
        ('device-disabled', 'user-disabled', 'seed-disabled', ?, ?)`
      )
      .bind(
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString()
      ),
    database
      .prepare(
        `
      INSERT INTO traffic_reports (id, user_id, device_id, upload_delta, download_delta, reported_at, created_at) VALUES
        ('report-1', 'user-1', 'device-1', 100, 200, '2001-01-01T00:00:00.000Z', ?),
        ('report-2', 'user-2', 'device-2', 25, 50, '2099-01-01T00:00:00.000Z', ?),
        ('report-merged', 'user-merged', 'device-merged', 1000, 2000, ?, ?),
        ('report-disabled', 'user-disabled', 'device-disabled', 1000, 2000, ?, ?)`
      )
      .bind(
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString()
      ),
    database
      .prepare(
        `
      INSERT INTO traffic_daily (user_id, device_id, date, upload_bytes, download_bytes, updated_at) VALUES
        ('user-1', 'device-1', ?, 100, 200, ?),
        ('user-2', 'device-2', ?, 25, 50, ?),
        ('user-1', 'device-1', ?, 10, 20, ?),
        ('user-1', 'device-1', ?, 400, 600, ?),
        ('user-merged', 'device-merged', ?, 1000, 2000, ?),
        ('user-disabled', 'device-disabled', ?, 1000, 2000, ?)`
      )
      .bind(
        today,
        now.toISOString(),
        today,
        now.toISOString(),
        yesterday,
        now.toISOString(),
        olderDate,
        now.toISOString(),
        today,
        now.toISOString(),
        today,
        now.toISOString()
      )
  ]);

  const unauthorized = await worker.fetch(new Request('https://worker.example/api/admin/traffic-trend?range=day'), {
    DB: database,
    REGISTRATION_PASSPHRASE: registrationPassphrase,
    ADMIN_TOKEN: adminToken
  });
  assert.equal(unauthorized.status, 403);

  const invalid = await getAdminTrafficTrend(database, 'week');
  assert.equal(invalid.status, 400);
  await assertWorkerError(invalid, 400, 'invalid traffic trend range');

  const hour = await (await getAdminTrafficTrend(database, 'hour')).json();
  assert.equal(hour.range, 'hour');
  assert.equal(hour.timeZone, 'Asia/Shanghai');
  assert.ok(hour.points.length >= 1 && hour.points.length <= 24);
  assert.equal(
    hour.points.reduce((sum, point) => sum + point.uploadBytes, 0),
    125
  );
  assert.equal(
    hour.points.reduce((sum, point) => sum + point.downloadBytes, 0),
    250
  );

  const day = await (await getAdminTrafficTrend(database, 'day')).json();
  assert.equal(day.points.length, 30);
  assert.equal(
    day.points.reduce((sum, point) => sum + point.uploadBytes, 0),
    135
  );
  assert.equal(
    day.points.reduce((sum, point) => sum + point.downloadBytes, 0),
    270
  );

  const month = await (await getAdminTrafficTrend(database, 'month')).json();
  assert.equal(month.points.length, 12);
  assert.equal(
    month.points.reduce((sum, point) => sum + point.uploadBytes, 0),
    535
  );
  assert.equal(
    month.points.reduce((sum, point) => sum + point.downloadBytes, 0),
    870
  );
});

test('admin traffic limit stays out of client and per-user remote config responses', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const deviceSeed = '11111111-1111-4111-8111-111111111111';
  const activation = await activate(database, { name: 'Alice', deviceSeed });
  assert.equal(activation.status, 200);
  const identity = await activation.json();

  const updated = await updateAdminTrafficLimit(database, { trafficLimitBytes: 1000 });
  assert.equal(updated.status, 200);

  const clientConfig = (await (await getClientConfig(database, identity, deviceSeed)).json()).config;
  assert.equal(Object.hasOwn(clientConfig, 'trafficLimitBytes'), false);
  assert.equal(Object.hasOwn(clientConfig, 'trafficExpiresAt'), false);

  const userConfig = await getAdminUserConfig(database, identity.userId);
  assert.equal(userConfig.status, 200);
  const userConfigBody = await userConfig.json();
  assert.equal(Object.hasOwn(userConfigBody.effective, 'trafficLimitBytes'), false);
  assert.equal(Object.hasOwn(userConfigBody.effective, 'trafficExpiresAt'), false);
  assert.equal(Object.hasOwn(userConfigBody.override ?? {}, 'trafficLimitBytes'), false);
  assert.equal(Object.hasOwn(userConfigBody.override ?? {}, 'trafficExpiresAt'), false);
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
    await assertWorkerError(response, 400, 'invalid rule profile');
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
    await assertWorkerError(response, 400, 'unsupported config field');
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
    await assertWorkerError(response, 400, item.error);
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
  await assertWorkerError(invalidResponse, 400, 'invalid rule profile');

  const unsupportedThreshold = await updateAdminUserConfig(database, 'user-1', { anomalyThresholdBytes: 1024 });
  assert.equal(unsupportedThreshold.status, 400);
  await assertWorkerError(unsupportedThreshold, 400, 'unsupported config field');

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
  await assertWorkerError(response, 413, 'request too large');
});

test('activation accepts a bounded UTF-8 stream split inside a multibyte character', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const body = JSON.stringify({
    name: '张三',
    passphrase: registrationPassphrase,
    deviceSeed: '11111111-1111-4111-8111-111111111111',
    deviceName: '测试电脑',
    platform: 'win32',
    appVersion: '1.6.8'
  });
  const encoded = new TextEncoder().encode(body);
  assert.ok(encoded.byteLength < maxRequestBodyBytes);
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
    await assertWorkerError(response, 413, 'request too large');
    assert.equal(streamed.state.cancelled, true, `${path} should cancel its reader`);
    assert.equal(streamed.state.pulls, 2, `${path} should stop before requesting another chunk`);
  }
});

test('activation and traffic reports enforce exact schemas instead of ignoring or coercing fields', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());

  const unsupportedActivation = await activate(database, {
    name: 'Alice',
    deviceSeed: '11111111-1111-4111-8111-111111111111',
    ignored: true
  });
  await assertWorkerError(unsupportedActivation, 400, 'unsupported activation field', 'UNSUPPORTED_ACTIVATION_FIELD');
  assert.deepEqual(database.queryAll('SELECT id FROM users'), []);

  const identityResponse = await activate(database, {
    name: 'Alice',
    deviceSeed: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();

  for (const input of [
    {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uploadDelta: -1,
      downloadDelta: 0
    },
    {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uploadDelta: 1.5,
      downloadDelta: 0
    },
    {
      reportId: 'a'.repeat(121),
      uploadDelta: 1,
      downloadDelta: 0
    },
    {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uploadDelta: 1,
      downloadDelta: 0,
      ignored: true
    },
    {
      reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uploadDelta: 1,
      downloadDelta: 0,
      reportedAt: '2026-02-30T00:00:00Z'
    }
  ]) {
    const response = await reportTraffic(database, identity, '11111111-1111-4111-8111-111111111111', input);
    assert.equal(response.status, 400, JSON.stringify(input));
    const error = await response.json();
    assert.match(
      error.code,
      /^(?:INVALID_UPLOAD_DELTA|INVALID_REPORT_ID|INVALID_REPORTED_AT|UNSUPPORTED_TRAFFIC_REPORT_FIELD)$/
    );
    assert.equal(error.requestId, response.headers.get('x-request-id'));
  }
  assert.deepEqual(database.queryAll('SELECT id FROM traffic_reports'), []);
});

test('every bodyless admin write rejects a supplied request body', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  await addKnownUser(database);

  for (const path of [
    '/api/admin/config/sync-users',
    '/api/admin/maintenance',
    '/api/admin/users/user-1/config/reset'
  ]) {
    const response = await requestAdmin(database, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    await assertWorkerError(response, 400, 'unexpected request body', 'UNEXPECTED_REQUEST_BODY');
  }
});

test('traffic reports require a JSON media type before signature or database work', async (context) => {
  const database = createD1Database();
  context.after(() => database.close());
  const response = await worker.fetch(
    new Request('https://worker.example/api/traffic/report', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    }),
    {
      DB: database,
      REGISTRATION_PASSPHRASE: registrationPassphrase
    }
  );
  await assertWorkerError(response, 415, 'unsupported media type', 'UNSUPPORTED_MEDIA_TYPE');
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
      await assertWorkerError(response, 400, item.error);
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
    ...input,
    userId: identity.userId,
    deviceId: identity.deviceId,
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

async function getAdminTrafficLimit(database) {
  return requestAdmin(database, '/api/admin/traffic-limit');
}

async function updateAdminTrafficLimit(database, input) {
  return requestAdminConfig(database, '/api/admin/traffic-limit', JSON.stringify(input));
}

async function getAdminTrafficTrend(database, range) {
  return requestAdmin(database, `/api/admin/traffic-trend?range=${encodeURIComponent(range)}`);
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
    exec(sql) {
      sqlite.exec(sql);
    },
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
