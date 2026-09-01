const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { server, configureKestra } = require('../server');

let base;
let kestraServer;
let kestraBase;
let webhookEvents = [];

test.before(async () => {
  kestraServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    webhookEvents.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'execution-accepted' }));
  });
  await new Promise((resolve) => kestraServer.listen(0, '127.0.0.1', resolve));
  kestraBase = `http://127.0.0.1:${kestraServer.address().port}`;
  configureKestra({ baseUrl: kestraBase, webhookKey: 'test-webhook-key' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => kestraServer.close(resolve));
});

async function request(urlPath, method = 'GET', payload, headers = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}

const callbackHeaders = (phase) => ({ 'X-Kestra-Execution-Id': 'exec-test-001', 'X-Kestra-Phase': phase });

async function createIncident(eventId) {
  return request('/api/servicenow/incidents', 'POST', {
    short_description: 'Billing Service 5xx rate above threshold', priority: '1', assignment_group: 'Digital Commerce SRE',
    correlation_id: eventId, service: 'billing-service', environment: 'production', kestra_execution_id: 'exec-test-001'
  }, callbackHeaders('incident-create'));
}

async function diagnostics() {
  return Promise.all([
    request('/api/datadog/health?service=billing-service&env=production', 'GET', undefined, callbackHeaders('diagnostics')),
    request('/api/argocd/application?application=billing-service&environment=production', 'GET', undefined, callbackHeaders('diagnostics')),
    request('/api/kubernetes/deployment?namespace=production&deployment=billing-service', 'GET', undefined, callbackHeaders('diagnostics'))
  ]);
}

test('health and reset expose a deterministic clean state', async () => {
  const health = await request('/api/health');
  assert.deepEqual(health.body, { status: 'ok', service: 'kestra-pov-simulator' });
  const reset = await request('/api/demo/reset', 'POST');
  assert.equal(reset.body.orchestrator.status, 'Waiting');
  assert.equal(reset.body.kestraExecutionId, null);
  assert.equal(reset.body.policy.status, 'NOT EVALUATED');
  assert.deepEqual(reset.body.timeline, []);
  assert.deepEqual(reset.body.interactions, { datadog: [], argocd: [], kubernetes: [], servicenow: [] });
});

test('scenario start only establishes incident state and sends the real Kestra webhook', async () => {
  webhookEvents = [];
  const started = await request('/api/demo/known-failure', 'POST');
  assert.equal(started.status, 202);
  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].url, '/api/v1/main/executions/webhook/demo.incident/governed_incident_remediation/test-webhook-key');
  assert.equal(webhookEvents[0].body.value, 0.178);
  const state = (await request('/api/state')).body;
  assert.equal(state.service.errorRate, 0.178);
  assert.equal(state.service.readyReplicas, 3);
  assert.equal(state.service.errorSignature, 'MEMORY_LEAK_AFTER_DEPLOY');
  assert.equal(state.incident, null);
  assert.equal(state.policy.status, 'NOT EVALUATED');
  assert.equal(state.timeline.length, 1);
  assert.equal(state.interactions.servicenow.length, 0);
  assert.equal((await request('/api/demo/unknown-failure', 'POST')).status, 409);
});

test('Kestra callbacks drive the authorized path and update one incident', async () => {
  const eventId = webhookEvents[0].body.id;
  const created = await createIncident(eventId);
  assert.equal(created.status, 201);
  assert.equal(created.body.result.number, 'INC001042');
  const [dd, argo, kube] = await diagnostics();
  assert.equal(dd.body.http_5xx_rate, 0.178);
  assert.equal(argo.body.recent_deployment, true);
  assert.equal(argo.body.minutes_since_deployment, 6);
  assert.equal(kube.body.ready_replicas, 3);
  const policy = await request('/api/kestra/policy-decision', 'POST', {
    execution_id: 'exec-test-001', policy: 'deployment-regression-v1', decision: 'AUTHORIZED', checks: [
      { label: 'Critical error threshold', passed: true, value: '0.178' },
      { label: 'Recent deployment', passed: true, value: '6 minutes ago' },
      { label: 'Known remediation signature', passed: true, value: 'MEMORY_LEAK_AFTER_DEPLOY' },
      { label: 'Previous stable revision available', passed: true, value: 'billing-v41' }
    ]
  }, callbackHeaders('policy'));
  assert.equal(policy.status, 200);
  const rollback = await request('/api/argocd/rollback', 'POST', {
    application: 'billing-service', environment: 'production', from_version: 'billing-v42', to_version: 'billing-v41',
    target_revision: '91c7e62', kestra_execution_id: 'exec-test-001'
  }, callbackHeaders('remediation'));
  assert.equal(rollback.status, 200);
  const verifiedKube = await request('/api/kubernetes/deployment?namespace=production&deployment=billing-service', 'GET', undefined, callbackHeaders('recovery-verification'));
  const verifiedDd = await request('/api/datadog/health?service=billing-service&env=production', 'GET', undefined, callbackHeaders('recovery-verification'));
  assert.equal(verifiedKube.body.ready_replicas, 6);
  assert.equal(verifiedDd.body.http_5xx_rate, 0.002);
  const resolved = await request(`/api/servicenow/incidents/${created.body.result.sys_id}`, 'PUT', {
    state: 'resolved', resolution: 'automated_remediation', resolution_code: 'deployment_rollback',
    close_notes: 'Verified.', restored_version: 'billing-v41', kestra_execution_id: 'exec-test-001'
  }, callbackHeaders('incident-resolve'));
  assert.equal(resolved.body.result.state_label, 'Resolved');
  const state = (await request('/api/state')).body;
  assert.equal(state.running, false);
  assert.equal(state.orchestrator.detail, 'Verified Recovery');
  assert.equal(state.interactions.servicenow.length, 2);
  assert.equal(state.interactions.servicenow[0].response.result.sys_id, state.interactions.servicenow[1].response.result.sys_id);
});

test('Kestra callbacks drive blocked path without rollback and reset remains deterministic', async () => {
  await request('/api/demo/reset', 'POST');
  webhookEvents = [];
  assert.equal((await request('/api/demo/unknown-failure', 'POST')).status, 202);
  const created = await createIncident(webhookEvents[0].body.id);
  const [dd, argo, kube] = await diagnostics();
  assert.equal(dd.body.http_5xx_rate, 0.214);
  assert.equal(argo.body.recent_deployment, false);
  assert.equal(kube.body.ready_replicas, 5);
  await request('/api/kestra/policy-decision', 'POST', {
    execution_id: 'exec-test-001', policy: 'deployment-regression-v1', decision: 'BLOCKED', checks: [
      { label: 'Critical error threshold', passed: true, value: '0.214' },
      { label: 'Recent deployment', passed: false, value: 'No deployment in 15-minute window' },
      { label: 'Known remediation signature', passed: false, value: 'DB_CONNECTION_SATURATION' },
      { label: 'Previous stable revision available', passed: true, value: 'billing-v41' }
    ]
  }, callbackHeaders('policy'));
  const escalated = await request(`/api/servicenow/incidents/${created.body.result.sys_id}`, 'PUT', {
    state: 'human_intervention_required', assignment_group: 'Digital Commerce SRE', reason: 'Outside approved remediation policy',
    automated_action: 'none', diagnostic_context: { http_5xx_rate: .214, error_signature: 'DB_CONNECTION_SATURATION', recent_deployment: false, ready_replicas: 5, desired_replicas: 6 },
    kestra_execution_id: 'exec-test-001'
  }, callbackHeaders('incident-escalate'));
  assert.equal(escalated.body.result.state_label, 'Human Intervention Required');
  const state = (await request('/api/state')).body;
  assert.equal(state.policy.status, 'BLOCKED');
  assert.equal(state.interactions.argocd.some((item) => item.method === 'POST'), false);
  assert.equal(state.orchestrator.detail, 'Escalated with Diagnostic Context');
  const reset = await request('/api/demo/reset', 'POST');
  assert.equal(reset.body.incident, null);
  assert.equal(reset.body.kestraExecutionId, null);
  assert.equal(reset.body.timeline.length, 0);
  assert.equal(reset.body.interactions.datadog.length, 0);
});

test('invalid callbacks return useful 4xx errors without mutation', async () => {
  await request('/api/demo/known-failure', 'POST');
  const invalid = await request('/api/kestra/policy-decision', 'POST', { decision: 'MAYBE' }, callbackHeaders('policy'));
  assert.equal(invalid.status, 400);
  assert.equal((await request('/api/state')).body.policy.status, 'NOT EVALUATED');
  await request('/api/demo/reset', 'POST');
});

test('presentation preserves approved layout and identifies live Kestra', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /LIVE KESTRA/);
  assert.doesNotMatch(html, /SIMULATED ORCHESTRATION/);
  assert.match(app, /inspectorSelectedIndex/);
});
