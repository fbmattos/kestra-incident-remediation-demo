const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { server, evaluatePolicy } = require('../server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, method = 'GET') {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' } });
  return { status: response.status, body: await response.json() };
}

async function completedState(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request('/api/state');
    if (!result.body.running && result.body.completedAt) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Simulation did not complete in time');
}

test('policy evaluation is based on structured diagnostics', () => {
  const authorized = evaluatePolicy({ errorRate: .178, deploymentAgeMinutes: 6, errorSignature: 'MEMORY_LEAK_AFTER_DEPLOY', previousStable: 'billing-v41' });
  const blocked = evaluatePolicy({ errorRate: .214, deploymentAgeMinutes: 1140, errorSignature: 'DB_CONNECTION_SATURATION', previousStable: 'billing-v41' });
  assert.equal(authorized.status, 'AUTHORIZED');
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.checks.map((check) => check.pass), [true, false, false, true]);
});

test('known regression reaches verified recovery and updates the same incident', async () => {
  await request('/api/demo/reset', 'POST');
  const started = await request('/api/demo/known-failure', 'POST');
  assert.equal(started.status, 202);
  const conflict = await request('/api/demo/unknown-failure', 'POST');
  assert.equal(conflict.status, 409);
  const state = await completedState();
  assert.equal(state.service.status, 'HEALTHY');
  assert.equal(state.service.deployment, 'billing-v41');
  assert.equal(state.service.errorRate, .002);
  assert.equal(state.service.readyReplicas, 6);
  assert.equal(state.policy.status, 'AUTHORIZED');
  assert.equal(state.incident.number, 'INC001042');
  assert.equal(state.incident.state_label, 'Resolved');
  assert.equal(state.service.humanIntervention, 'NONE');
  assert.equal(state.interactions.servicenow.length, 2);
  assert.equal(state.interactions.servicenow[0].response.result.sys_id, state.interactions.servicenow[1].response.result.sys_id);
  const diagnostics = state.timeline.filter((item) => item.parallelGroup === 'diagnostics');
  assert.equal(diagnostics.length, 3);
  assert.equal(new Set(diagnostics.map((item) => item.timestamp)).size, 1);
  const reset = await request('/api/demo/reset', 'POST');
  assert.equal(reset.body.service.status, 'HEALTHY');
  assert.equal(reset.body.timeline.length, 0);
});

test('unknown failure blocks production action and escalates diagnostics', async () => {
  const started = await request('/api/demo/unknown-failure', 'POST');
  assert.equal(started.status, 202);
  const state = await completedState();
  assert.equal(state.service.status, 'CRITICAL');
  assert.equal(state.policy.status, 'BLOCKED');
  assert.equal(state.service.resolution, 'HUMAN INTERVENTION REQUIRED');
  assert.equal(state.diagnosticPackage.production_action, 'NONE');
  assert.equal(state.diagnosticPackage.error_signature, 'DB_CONNECTION_SATURATION');
  assert.equal(state.interactions.argocd.some((item) => item.method === 'POST'), false);
  assert.equal(state.incident.sys_id, '8f291aa2db4010107a9c4410cf961921');
  assert.equal(state.interactions.servicenow.length, 2);
  const reset = await request('/api/demo/reset', 'POST');
  assert.equal(reset.body.incident, null);
  assert.equal(reset.body.service.deployment, 'billing-v42');
});

test('external simulated service APIs return structured JSON', async () => {
  const [datadog, argo, kube, snow] = await Promise.all([
    request('/api/datadog/health'), request('/api/argocd/application'),
    request('/api/kubernetes/deployment'), request('/api/servicenow/incidents')
  ]);
  assert.equal(datadog.body.service, 'billing-service');
  assert.equal(argo.body.application, 'billing-service');
  assert.equal(kube.body.pods.length, 6);
  assert.deepEqual(snow.body.result, []);
});

test('presentation uses the official logo and preserves payload history selection', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /kestra-monogram\.svg/);
  assert.doesNotMatch(html, /Kestra Solution Simulation|Simulated enterprise systems|Production control plane/);
  assert.doesNotMatch(html, /Production service|Decision outcome|Choose one deterministic production event/);
  assert.match(app, /inspectorSelectedIndex/);
  assert.match(app, /renderInspector\(inspectorSystem, inspectorSelectedIndex\)/);
});
