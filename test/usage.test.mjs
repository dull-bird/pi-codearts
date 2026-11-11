import test from 'node:test';
import assert from 'node:assert/strict';
import { queryUsage, summarizeUsage, formatUsage } from '../usage.mjs';
import { OFFICIAL, bindEnvironment } from '../environments.mjs';
import { auth } from './helpers.mjs';
const bound = bindEnvironment(auth);
const payload = () => ({ code: 0, start_date: '2026-11-01', end_date: '2026-11-30',
  package: { spec_code: 'codearts.agent.professional', package_name_cn: '专业版', status: 'normal', is_token_package: true, is_credit_package: false },
  metrics: [{ name: 'usageTokenChatMessages', usage_token_num: 24079378, package_token_amount: 60000000, value: 40, show: true }, { name: 'usageDataChatMessages', value: -1, show: false }],
  model_metrics: [{ model_sku: 'glm-5.2', usage_token: 25.5, enable: true, status: 'normal' }],
  private_account: 'must-not-be-rendered',
});

test('official usage request is signed GET with cancellation, without body or redirect', async () => {
  let request;
  const result = await queryUsage(bound, undefined, OFFICIAL, async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify(payload()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(request.url, OFFICIAL.apiOrigin + '/snap-manager/v1/statistics/plugin');
  assert.equal(request.method, 'GET'); assert.equal(request.body, undefined); assert.equal(request.redirect, 'error');
  assert.match(request.headers.Authorization, /^SDK-HMAC-SHA256 Access=/);
  assert.equal(result.token.remaining, 35920622);
  assert.equal(result.models[0].usedPercent, 25.5);
  assert.doesNotMatch(formatUsage(result), /private_account|must-not/);
  assert.match(formatUsage(result), /剩余 35,920,622/);
  assert.match(formatUsage(result), /已用 25.5%/);
});

test('invalid, HTTP and business failures do not leak response/account details', async () => {
  for (const [response, expected] of [
    [new Response('private server text', { status: 403 }), /HTTP 403/],
    [new Response(JSON.stringify({ error_code: 'denied', error_msg: 'private' }), { status: 200 }), /denied/],
    [new Response('[]', { status: 200 }), /响应格式/],
  ]) await assert.rejects(queryUsage(bound, undefined, OFFICIAL, async () => response), error => expected.test(error.message) && !/private|token-secret/.test(error.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queryUsage(bound, controller.signal, OFFICIAL, async () => { throw new Error('network'); }));
});

test('usage is restricted to the verified official path; percentages are never called remaining token counts', async () => {
  for (const environment of [{ ...OFFICIAL, id: 'company' }, { ...OFFICIAL, paths: { ...OFFICIAL.paths, usage: '/unknown' } }, { ...OFFICIAL, paths: { ...OFFICIAL.paths, usage: null } }]) {
    await assert.rejects(queryUsage(bound, undefined, environment, async () => { throw new Error('must not request'); }));
  }
  assert.equal(summarizeUsage(payload()).token.remaining, 35920622);
  assert.equal(summarizeUsage({ package: {}, model_metrics: [{ model_sku: 'model', usage_token: 99 }] }).models[0].remaining, undefined);
  assert.match(formatUsage(summarizeUsage({ package: { is_credit_package: true } })), /积分余额.*不是同一/);
});
