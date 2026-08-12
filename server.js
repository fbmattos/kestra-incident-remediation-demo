const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function loadLocalEnv() {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
let kestraBaseUrl = process.env.KESTRA_BASE_URL || 'http://localhost:8080';
let kestraWebhookKey = process.env.KESTRA_WEBHOOK_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INCIDENT_ID = '8f291aa2db4010107a9c4410cf961921';
const INCIDENT_NUMBER = 'INC001042';

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);

function pods(version = 'v42', ready = 6) {
  const suffixes = ['d2k8p', 'fr7nq', 'h9w2m', 'k4p6x', 'm8t3v', 'q2z5b'];
  return suffixes.map((suffix, index) => ({
    name: `billing-7d86c5d7f9-${suffix}`, version, phase: 'Running', ready: index < ready,
    restart_count: index < ready ? 0 : 4
  }));
}

function initialState() {
  return {
    runId: 0, running: false, scenario: null, startedAt: null, completedAt: null,
    kestraExecutionId: null, webhookError: null,
    orchestrator: { mode: 'LIVE', status: 'Waiting', detail: 'Ready for a scenario' },
    service: {
      name: 'Billing Service', environment: 'Production', status: 'HEALTHY', deployment: 'billing-v42',
      previousDeployment: 'billing-v41', errorRate: 0.003, desiredReplicas: 6, readyReplicas: 6,
      errorSignature: null, incident: null, resolution: null, humanIntervention: null
    },
    deployment: { recent: false, minutesSince: null, deployedAt: null },
    policy: { status: 'NOT EVALUATED', policy: null, checks: [] },
    timeline: [], interactions: { datadog: [], argocd: [], kubernetes: [], servicenow: [] },
    incident: null, diagnosticPackage: null
  };
}

let state = initialState();

function timeline(system, message, options = {}) {
  state.timeline.push({ timestamp: now(), system, message, parallelGroup: options.parallelGroup || null, tone: options.tone || 'neutral' });
}

function interaction(system, method, endpoint, request, response, summary, status = 200, metadata = {}) {
  const item = {
    id: `${system}-${state.interactions[system].length + 1}`, timestamp: now(), method, endpoint,
    request, responseStatus: status, response, summary, ...metadata
  };
  state.interactions[system].push(item);
  return item;
}

function eventPayload(rate) {
  return {
    id: `evt-${Date.now()}`, monitor_id: '7348291', transition: 'Triggered', priority: 'P1',
    title: 'Billing Service 5xx rate above threshold', service: 'billing-service', env: 'production',
    metric: 'http.server.errors', value: rate, threshold: 0.05, timestamp: now()
  };
}

function datadogHealth() {
  return {
    service: 'billing-service', environment: 'production', window: state.service.status === 'HEALTHY' ? '2m' : '5m',
    http_5xx_rate: state.service.errorRate, threshold: 0.05,
    status: state.service.errorRate < 0.05 ? 'healthy' : 'critical', error_signature: state.service.errorSignature
  };
}

function argoApplication() {
  return {
    application: 'billing-service', environment: 'production',
    sync: { status: 'Synced', revision: state.service.deployment === 'billing-v41' ? '91c7e62' : 'a82fd91' },
    health: { status: state.service.status === 'HEALTHY' ? 'Healthy' : 'Degraded' },
    deployment: { version: state.service.deployment, revision: state.service.deployment === 'billing-v41' ? '91c7e62' : 'a82fd91', deployed_at: state.deployment.deployedAt },
    recent_deployment: state.deployment.recent,
    minutes_since_deployment: state.deployment.minutesSince,
    recent_deployment_description: state.deployment.recent ? `${state.deployment.minutesSince} minutes ago` : 'No deployment in 15-minute window',
    previous_deployment: { version: 'billing-v41', revision: '91c7e62' }
  };
}

function kubernetesDeployment() {
  return {
    namespace: 'production', deployment: 'billing-service', desired_replicas: state.service.desiredReplicas,
    ready_replicas: state.service.readyReplicas,
    pods: pods(state.service.deployment.replace('billing-', ''), state.service.readyReplicas)
  };
}

function establishExecution(req) {
  const executionId = req.headers['x-kestra-execution-id'];
  if (!executionId) return null;
  if (state.kestraExecutionId && state.kestraExecutionId !== executionId) return false;
  state.kestraExecutionId = executionId;
  state.running = true;
  return executionId;
}

function kestraMetadata(req) {
  return { kestraExecutionId: req.headers['x-kestra-execution-id'] || null, kestraPhase: req.headers['x-kestra-phase'] || null };
}

function requireActiveScenario(res) {
  if (!state.scenario) {
    json(res, 409, { error: 'No active incident scenario. Start a scenario before invoking simulated services.' });
    return false;
  }
  return true;
}

function validateObject(payload, required) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Request body must be a JSON object.';
  const missing = required.filter((key) => payload[key] === undefined || payload[key] === null || payload[key] === '');
  return missing.length ? `Missing required field(s): ${missing.join(', ')}` : null;
}

async function triggerKestra(payload) {
  const key = kestraWebhookKey;
  if (!key) throw new Error('KESTRA_WEBHOOK_KEY is not configured');
  const url = `${kestraBaseUrl.replace(/\/$/, '')}/api/v1/main/executions/webhook/demo.incident/governed_incident_remediation/${encodeURIComponent(key)}`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await response.text();
  let responseBody = text;
  try { responseBody = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Kestra webhook returned ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
  return { status: response.status, body: responseBody };
}

async function startScenario(scenario) {
  if (state.running) return { accepted: false, status: 409, error: 'A simulation is already running.' };
  const nextRun = state.runId + 1;
  state = initialState();
  state.runId = nextRun;
  state.running = true;
  state.scenario = scenario;
  state.startedAt = now();
  const known = scenario === 'known';
  state.service.status = 'CRITICAL';
  state.service.errorRate = known ? 0.178 : 0.214;
  state.service.readyReplicas = known ? 3 : 5;
  state.service.errorSignature = known ? 'MEMORY_LEAK_AFTER_DEPLOY' : 'DB_CONNECTION_SATURATION';
  state.deployment = { recent: known, minutesSince: known ? 6 : null, deployedAt: known ? new Date(Date.now() - 6 * 60_000).toISOString() : new Date(Date.now() - 19 * 60 * 60_000).toISOString() };
  state.orchestrator = { mode: 'LIVE', status: 'Incident received', detail: 'Sending Datadog event to Kestra' };
  const alert = eventPayload(state.service.errorRate);
  timeline('Datadog', 'Alert webhook sent', { tone: 'critical' });
  try {
    const result = await triggerKestra(alert);
    interaction('datadog', 'POST', '/api/v1/main/executions/webhook/demo.incident/governed_incident_remediation/[redacted]', alert, result.body, 'Alert webhook sent', result.status);
    state.orchestrator = { mode: 'LIVE', status: 'Incident received', detail: 'Kestra webhook accepted; awaiting execution callbacks' };
    return { accepted: true, status: 202, event_id: alert.id };
  } catch (error) {
    state.running = false;
    state.webhookError = error.message;
    state.orchestrator = { mode: 'LIVE', status: 'Connection error', detail: error.message };
    interaction('datadog', 'POST', '/api/v1/main/executions/webhook/demo.incident/governed_incident_remediation/[redacted]', alert, { error: error.message }, 'Alert webhook failed', 502);
    timeline('Datadog', 'Alert webhook failed', { tone: 'critical' });
    return { accepted: false, status: 502, error: error.message };
  }
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Kestra-Execution-Id,X-Kestra-Phase' });
  res.end(status === 204 ? '' : JSON.stringify(payload));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Request body too large.'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 }); }
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'kestra-pov-simulator' });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
    if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
      const nextRun = state.runId + 1;
      state = initialState(); state.runId = nextRun;
      return json(res, 200, state);
    }
    if (req.method === 'POST' && ['/api/demo/known-failure', '/api/demo/unknown-failure'].includes(url.pathname)) {
      const result = await startScenario(url.pathname === '/api/demo/known-failure' ? 'known' : 'unknown');
      return json(res, result.status, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/servicenow/incidents') {
      if (!requireActiveScenario(res)) return;
      const payload = await body(req);
      const invalid = validateObject(payload, ['short_description', 'priority', 'assignment_group', 'correlation_id', 'kestra_execution_id']);
      if (invalid) return json(res, 400, { error: invalid });
      const executionId = establishExecution(req);
      if (!executionId) return json(res, 409, { error: executionId === false ? 'Callback execution ID does not match the active execution.' : 'X-Kestra-Execution-Id header is required.' });
      if (payload.kestra_execution_id !== executionId) return json(res, 400, { error: 'kestra_execution_id must match X-Kestra-Execution-Id.' });
      state.incident = { sys_id: INCIDENT_ID, number: INCIDENT_NUMBER, state: '2', state_label: 'In Progress', ...payload, opened_at: now(), updated_at: now(), close_notes: null, diagnostic_context: null };
      state.service.incident = INCIDENT_NUMBER;
      state.orchestrator = { mode: 'LIVE', status: 'Gathering diagnostics', detail: `Execution ${executionId}` };
      const response = { result: { sys_id: INCIDENT_ID, number: INCIDENT_NUMBER, state: '2' } };
      interaction('servicenow', 'POST', '/api/servicenow/incidents', payload, response, `${INCIDENT_NUMBER} created`, 201, kestraMetadata(req));
      timeline('ServiceNow', `${INCIDENT_NUMBER} created`, { tone: 'active' });
      return json(res, 201, response);
    }

    if (req.method === 'GET' && url.pathname === '/api/datadog/health') {
      if (!requireActiveScenario(res)) return;
      const executionId = establishExecution(req);
      if (!executionId) return json(res, 409, { error: executionId === false ? 'Callback execution ID does not match the active execution.' : 'X-Kestra-Execution-Id header is required.' });
      const phase = req.headers['x-kestra-phase'];
      if (!['diagnostics', 'recovery-verification'].includes(phase)) return json(res, 400, { error: 'X-Kestra-Phase must be diagnostics or recovery-verification.' });
      const response = datadogHealth();
      const summary = phase === 'diagnostics' ? 'Diagnostic metrics requested' : 'Recovery verified';
      interaction('datadog', 'GET', `${url.pathname}${url.search}`, null, response, summary, 200, kestraMetadata(req));
      timeline('Datadog', summary, { parallelGroup: phase, tone: phase === 'diagnostics' ? 'active' : 'success' });
      state.orchestrator = { mode: 'LIVE', status: phase === 'diagnostics' ? 'Gathering diagnostics' : 'Verifying recovery', detail: `Execution ${state.kestraExecutionId}` };
      return json(res, 200, response);
    }

    if (req.method === 'GET' && url.pathname === '/api/argocd/application') {
      if (!requireActiveScenario(res)) return;
      if (!establishExecution(req)) return json(res, 409, { error: 'Valid X-Kestra-Execution-Id header is required.' });
      const response = argoApplication();
      interaction('argocd', 'GET', `${url.pathname}${url.search}`, null, response, 'Deployment history requested', 200, kestraMetadata(req));
      timeline('Argo CD', 'Deployment history requested', { parallelGroup: 'diagnostics', tone: 'active' });
      return json(res, 200, response);
    }

    if (req.method === 'GET' && url.pathname === '/api/kubernetes/deployment') {
      if (!requireActiveScenario(res)) return;
      if (!establishExecution(req)) return json(res, 409, { error: 'Valid X-Kestra-Execution-Id header is required.' });
      const phase = req.headers['x-kestra-phase'];
      if (!['diagnostics', 'recovery-verification'].includes(phase)) return json(res, 400, { error: 'X-Kestra-Phase must be diagnostics or recovery-verification.' });
      const response = kubernetesDeployment();
      const summary = phase === 'diagnostics' ? 'Workload health requested' : `${response.ready_replicas}/${response.desired_replicas} replicas Ready`;
      interaction('kubernetes', 'GET', `${url.pathname}${url.search}`, null, response, summary, 200, kestraMetadata(req));
      timeline('Kubernetes', summary, { parallelGroup: phase, tone: phase === 'diagnostics' ? 'active' : 'success' });
      return json(res, 200, response);
    }

    if (req.method === 'POST' && url.pathname === '/api/kestra/policy-decision') {
      if (!requireActiveScenario(res)) return;
      const payload = await body(req);
      const invalid = validateObject(payload, ['execution_id', 'policy', 'decision', 'checks']);
      if (invalid || !['AUTHORIZED', 'BLOCKED'].includes(payload.decision) || !Array.isArray(payload.checks)) return json(res, 400, { error: invalid || 'decision must be AUTHORIZED or BLOCKED and checks must be an array.' });
      if (!establishExecution(req)) return json(res, 409, { error: 'Valid X-Kestra-Execution-Id header is required.' });
      if (payload.execution_id !== state.kestraExecutionId) return json(res, 400, { error: 'execution_id must match X-Kestra-Execution-Id.' });
      state.policy = { status: payload.decision, policy: payload.policy, checks: payload.checks.map((check) => ({ label: check.label, pass: Boolean(check.passed), evidence: String(check.value ?? '') })) };
      state.orchestrator = { mode: 'LIVE', status: payload.decision === 'AUTHORIZED' ? 'Remediation authorized' : 'Escalation required', detail: payload.decision === 'AUTHORIZED' ? payload.policy : 'No production-changing action permitted' };
      timeline('Kestra', payload.decision === 'AUTHORIZED' ? `Policy matched: ${payload.policy}` : 'Production action blocked by policy', { tone: payload.decision === 'AUTHORIZED' ? 'success' : 'warning' });
      return json(res, 200, { accepted: true, decision: payload.decision });
    }

    if (req.method === 'POST' && url.pathname === '/api/argocd/rollback') {
      if (!requireActiveScenario(res)) return;
      const payload = await body(req);
      const invalid = validateObject(payload, ['application', 'environment', 'from_version', 'to_version', 'target_revision', 'kestra_execution_id']);
      if (invalid) return json(res, 400, { error: invalid });
      if (!establishExecution(req)) return json(res, 409, { error: 'Valid X-Kestra-Execution-Id header is required.' });
      if (payload.kestra_execution_id !== state.kestraExecutionId) return json(res, 400, { error: 'kestra_execution_id must match X-Kestra-Execution-Id.' });
      if (state.policy.status !== 'AUTHORIZED') return json(res, 409, { error: 'Rollback requires an AUTHORIZED Kestra policy callback.' });
      state.service.deployment = payload.to_version;
      state.service.readyReplicas = 6;
      state.service.errorRate = 0.002;
      state.service.errorSignature = null;
      state.service.status = 'HEALTHY';
      state.deployment = { recent: true, minutesSince: 0, deployedAt: now() };
      state.orchestrator = { mode: 'LIVE', status: 'Executing rollback', detail: `${payload.from_version} → ${payload.to_version}` };
      const response = { operation_id: `rollback-${state.runId}`, status: 'Succeeded', from_version: payload.from_version, to_version: payload.to_version, target_revision: payload.target_revision };
      interaction('argocd', 'POST', '/api/argocd/rollback', payload, response, 'Rollback requested v42 → v41', 200, kestraMetadata(req));
      timeline('Argo CD', 'Rollback requested v42 → v41', { tone: 'active' });
      return json(res, 200, response);
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/api/servicenow/incidents/')) {
      if (!requireActiveScenario(res)) return;
      if (!state.incident || url.pathname.split('/').pop() !== state.incident.sys_id) return json(res, 404, { error: 'Incident not found.' });
      const payload = await body(req);
      if (!['resolved', 'human_intervention_required'].includes(payload.state)) return json(res, 400, { error: 'state must be resolved or human_intervention_required.' });
      if (!establishExecution(req)) return json(res, 409, { error: 'Valid X-Kestra-Execution-Id header is required.' });
      if (payload.kestra_execution_id !== state.kestraExecutionId) return json(res, 400, { error: 'kestra_execution_id must match X-Kestra-Execution-Id.' });
      const resolved = payload.state === 'resolved';
      state.incident = { ...state.incident, ...payload, state: resolved ? '6' : '2', state_label: resolved ? 'Resolved' : 'Human Intervention Required', updated_at: now() };
      state.service.resolution = resolved ? 'AUTOMATED REMEDIATION' : 'HUMAN INTERVENTION REQUIRED';
      state.service.humanIntervention = resolved ? 'NONE' : 'REQUIRED';
      if (!resolved) state.diagnosticPackage = payload.diagnostic_context || { reason: payload.reason, production_action: payload.automated_action };
      state.running = false;
      state.completedAt = now();
      state.orchestrator = { mode: 'LIVE', status: 'Complete', detail: resolved ? 'Verified Recovery' : 'Escalated with Diagnostic Context' };
      const response = { result: clone(state.incident) };
      const summary = resolved ? `${INCIDENT_NUMBER} resolved` : `${INCIDENT_NUMBER} escalated to Digital Commerce SRE`;
      interaction('servicenow', 'PUT', url.pathname, payload, response, summary, 200, kestraMetadata(req));
      timeline('ServiceNow', summary, { tone: resolved ? 'success' : 'warning' });
      return json(res, 200, response);
    }

    if (req.method === 'GET' && url.pathname === '/api/servicenow/incidents') return json(res, 200, { result: state.incident ? [state.incident] : [] });
    if (!url.pathname.startsWith('/api/') && serveStatic(req, res)) return;
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, error.status || 500, { error: error.message });
  }
});

if (require.main === module) server.listen(PORT, HOST, () => console.log(`Kestra PoV simulator listening on http://localhost:${PORT}`));

function configureKestra({ baseUrl, webhookKey }) {
  if (baseUrl !== undefined) kestraBaseUrl = baseUrl;
  if (webhookKey !== undefined) kestraWebhookKey = webhookKey;
}

module.exports = { server, initialState, datadogHealth, argoApplication, kubernetesDeployment, configureKestra };
