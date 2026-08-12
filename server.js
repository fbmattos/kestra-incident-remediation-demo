const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const ids = {
  event: 'evt-884219',
  incident: '8f291aa2db4010107a9c4410cf961921',
  number: 'INC001042'
};

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pods(version = 'v42', ready = 6) {
  const suffixes = ['d2k8p', 'fr7nq', 'h9w2m', 'k4p6x', 'm8t3v', 'q2z5b'];
  return suffixes.map((suffix, index) => ({
    name: `billing-7d86c5d7f9-${suffix}`,
    version,
    phase: 'Running',
    ready: index < ready,
    restart_count: index < ready ? 0 : 4
  }));
}

function initialState() {
  return {
    runId: 0,
    running: false,
    scenario: null,
    startedAt: null,
    completedAt: null,
    elapsedSeconds: 0,
    orchestrator: { mode: 'SIMULATED', status: 'Waiting', detail: 'Ready for a scenario' },
    service: {
      name: 'Billing Service', environment: 'Production', status: 'HEALTHY',
      deployment: 'billing-v42', previousDeployment: 'billing-v41', errorRate: 0.003,
      desiredReplicas: 6, readyReplicas: 6, errorSignature: null, incident: null,
      resolution: null, humanIntervention: null
    },
    policy: { status: 'NOT EVALUATED', checks: [] },
    timeline: [],
    interactions: { datadog: [], argocd: [], kubernetes: [], servicenow: [] },
    incident: null,
    diagnosticPackage: null
  };
}

let state = initialState();

function timeline(system, message, options = {}) {
  state.timeline.push({ timestamp: now(), system, message, parallelGroup: options.parallelGroup || null, tone: options.tone || 'neutral' });
}

function interaction(system, method, endpoint, request, response, summary, status = 200) {
  const item = { id: `${system}-${state.interactions[system].length + 1}`, timestamp: now(), method, endpoint, request, responseStatus: status, response, summary };
  state.interactions[system].push(item);
  return item;
}

function eventPayload(rate) {
  return {
    id: ids.event, monitor_id: '7348291', transition: 'Triggered', priority: 'P1',
    title: 'Billing Service 5xx rate above threshold', service: 'billing-service', env: 'production',
    metric: 'http.server.errors', value: rate, threshold: 0.05, timestamp: now()
  };
}

function argoApplication(recentDeployment, degraded = true) {
  return {
    application: 'billing-service', environment: 'production',
    sync: { status: 'Synced', revision: 'a82fd91' },
    health: { status: degraded ? 'Degraded' : 'Healthy' },
    deployment: {
      version: state.service.deployment,
      deployed_at: recentDeployment ? new Date(Date.now() - 6 * 60_000).toISOString() : new Date(Date.now() - 19 * 60 * 60_000).toISOString()
    },
    previous_deployment: { version: 'billing-v41', revision: '91c7e62', health: 'Healthy' }
  };
}

function kubernetesDeployment() {
  return {
    namespace: 'production', deployment: 'billing-service',
    desired_replicas: state.service.desiredReplicas, ready_replicas: state.service.readyReplicas,
    pods: pods(state.service.deployment.replace('billing-', ''), state.service.readyReplicas)
  };
}

function datadogHealth() {
  return {
    service: 'billing-service', window: '2m', http_5xx_rate: state.service.errorRate,
    threshold: 0.05, status: state.service.errorRate < 0.05 ? 'healthy' : 'critical',
    error_signature: state.service.errorSignature
  };
}

function createIncident() {
  const request = {
    short_description: 'Billing Service elevated 5xx rate', priority: '1',
    assignment_group: 'Digital Commerce SRE', correlation_id: ids.event
  };
  state.incident = {
    sys_id: ids.incident, number: ids.number, state: '2', state_label: 'In Progress',
    priority: '1', assignment_group: 'Digital Commerce SRE', correlation_id: ids.event,
    short_description: request.short_description, opened_at: now(), updated_at: now(), close_notes: null,
    diagnostic_context: null
  };
  state.service.incident = ids.number;
  interaction('servicenow', 'POST', '/api/now/table/incident', request, { result: clone(state.incident) }, `${ids.number} created`, 201);
  timeline('ServiceNow', `${ids.number} created`, { tone: 'active' });
}

function evaluatePolicy(diagnostics) {
  const checks = [
    { label: 'Critical error threshold', pass: diagnostics.errorRate >= 0.05, evidence: `${(diagnostics.errorRate * 100).toFixed(1)}% ≥ 5.0%` },
    { label: 'Recent deployment', pass: diagnostics.deploymentAgeMinutes <= 15, evidence: diagnostics.deploymentAgeMinutes <= 15 ? `${diagnostics.deploymentAgeMinutes} minutes ago` : 'No deployment in 15-minute window' },
    { label: 'Known remediation signature', pass: diagnostics.errorSignature === 'MEMORY_LEAK_AFTER_DEPLOY', evidence: diagnostics.errorSignature },
    { label: 'Previous stable revision available', pass: Boolean(diagnostics.previousStable), evidence: diagnostics.previousStable || 'Unavailable' }
  ];
  const authorized = checks.every((check) => check.pass);
  return { status: authorized ? 'AUTHORIZED' : 'BLOCKED', policy: authorized ? 'deployment-regression-v1' : null, checks };
}

class SimulatedOrchestrationAdapter {
  async run(scenario, runId) {
    const active = () => state.runId === runId;
    const known = scenario === 'known';
    const ensureActive = () => { if (!active()) throw new Error('RUN_CANCELLED'); };
    try {
      state.orchestrator = { mode: 'SIMULATED', status: 'Incident received', detail: 'Datadog webhook accepted' };
      const alert = eventPayload(known ? 0.178 : 0.214);
      interaction('datadog', 'POST', '/api/datadog/alert', alert, { accepted: true, event_id: ids.event }, 'Alert webhook sent', 202);
      timeline('Datadog', 'Alert webhook sent', { tone: 'critical' });
      await wait(350); ensureActive();

      createIncident();
      state.orchestrator = { mode: 'SIMULATED', status: 'Gathering diagnostics', detail: 'Three evidence requests running in parallel' };
      await wait(350); ensureActive();
      const parallelAt = now();
      const dd = datadogHealth();
      const argo = argoApplication(known);
      const kube = kubernetesDeployment();
      interaction('datadog', 'GET', '/api/datadog/health?service=billing-service&window=5m', null, dd, 'Diagnostic metrics returned');
      interaction('argocd', 'GET', '/api/argocd/application/billing-service', null, argo, known ? 'Recent deployment found' : 'Deployment history returned');
      interaction('kubernetes', 'GET', '/api/kubernetes/deployment/billing-service', null, kube, `${kube.ready_replicas}/${kube.desired_replicas} replicas Ready`);
      state.timeline.push(
        { timestamp: parallelAt, system: 'Datadog', message: 'Diagnostic metrics requested', parallelGroup: 'diagnostics', tone: 'active' },
        { timestamp: parallelAt, system: 'Argo CD', message: 'Deployment history requested', parallelGroup: 'diagnostics', tone: 'active' },
        { timestamp: parallelAt, system: 'Kubernetes', message: 'Workload health requested', parallelGroup: 'diagnostics', tone: 'active' }
      );
      await wait(950); ensureActive();

      state.orchestrator = { mode: 'SIMULATED', status: 'Evaluating policy', detail: 'Applying Approved Automation Envelope' };
      const diagnostics = {
        errorRate: state.service.errorRate,
        deploymentAgeMinutes: known ? 6 : 1140,
        errorSignature: state.service.errorSignature,
        previousStable: 'billing-v41'
      };
      state.policy = evaluatePolicy(diagnostics);
      timeline('Kestra', state.policy.status === 'AUTHORIZED' ? `Policy matched: ${state.policy.policy}` : 'Production action blocked by policy', { tone: state.policy.status === 'AUTHORIZED' ? 'success' : 'warning' });
      await wait(700); ensureActive();

      if (state.policy.status === 'AUTHORIZED') {
        state.orchestrator = { mode: 'SIMULATED', status: 'Executing rollback', detail: 'Approved change via Argo CD' };
        const rollbackRequest = { application: 'billing-service', environment: 'production', target_revision: '91c7e62', target_version: 'billing-v41', reason: `${ids.number}: deployment-regression-v1` };
        interaction('argocd', 'POST', '/api/argocd/rollback', rollbackRequest, { operation_id: 'op-rollback-1042', status: 'Running', from: 'billing-v42', to: 'billing-v41' }, 'Rollback requested v42 → v41', 202);
        timeline('Argo CD', 'Rollback requested v42 → v41', { tone: 'active' });
        await wait(1200); ensureActive();
        state.service.deployment = 'billing-v41';
        state.service.readyReplicas = 6;
        interaction('kubernetes', 'GET', '/api/kubernetes/deployment/billing-service', null, kubernetesDeployment(), '6/6 replicas Ready');
        timeline('Kubernetes', '6/6 replicas Ready', { tone: 'success' });
        state.orchestrator = { mode: 'SIMULATED', status: 'Verifying recovery', detail: 'Checking health after production change' };
        await wait(850); ensureActive();
        state.service.errorRate = 0.002;
        state.service.status = 'HEALTHY';
        state.service.errorSignature = null;
        const recovery = datadogHealth();
        interaction('datadog', 'GET', '/api/datadog/health?service=billing-service&window=2m', null, recovery, 'Recovery verified');
        timeline('Datadog', 'Recovery verified below threshold', { tone: 'success' });
        await wait(500); ensureActive();
        state.incident = { ...state.incident, state: '6', state_label: 'Resolved', updated_at: now(), resolved_at: now(), resolution_code: 'Solved (Permanently)', close_notes: 'Automated rollback to billing-v41. Datadog verified 5xx rate at 0.2%; Kubernetes 6/6 Ready.' };
        interaction('servicenow', 'PATCH', `/api/now/table/incident/${ids.incident}`, { state: '6', close_code: 'Solved (Permanently)', close_notes: state.incident.close_notes }, { result: clone(state.incident) }, `${ids.number} resolved`);
        timeline('ServiceNow', `${ids.number} resolved`, { tone: 'success' });
        state.service.resolution = 'AUTOMATED REMEDIATION';
        state.service.humanIntervention = 'NONE';
        state.orchestrator = { mode: 'SIMULATED', status: 'Complete', detail: 'Verified Recovery' };
      } else {
        state.orchestrator = { mode: 'SIMULATED', status: 'Escalation required', detail: 'No production-changing action executed' };
        state.diagnosticPackage = {
          elevated_5xx_rate: state.service.errorRate,
          recent_deployment: false,
          kubernetes_readiness: `${state.service.readyReplicas}/${state.service.desiredReplicas}`,
          error_signature: state.service.errorSignature,
          policy_result: 'OUTSIDE APPROVED REMEDIATION POLICY',
          production_action: 'NONE'
        };
        state.incident = { ...state.incident, state: '2', state_label: 'Human Intervention Required', updated_at: now(), assignment_group: 'Digital Commerce SRE', work_notes: 'Automated action blocked. Diagnostic context attached.', diagnostic_context: clone(state.diagnosticPackage) };
        interaction('servicenow', 'PATCH', `/api/now/table/incident/${ids.incident}`, { assignment_group: 'Digital Commerce SRE', work_notes: state.incident.work_notes, diagnostic_context: state.diagnosticPackage }, { result: clone(state.incident) }, `${ids.number} escalated with diagnostics`);
        timeline('ServiceNow', `${ids.number} escalated to Digital Commerce SRE`, { tone: 'warning' });
        state.service.resolution = 'HUMAN INTERVENTION REQUIRED';
        state.service.humanIntervention = 'REQUIRED';
        await wait(450); ensureActive();
        state.orchestrator = { mode: 'SIMULATED', status: 'Complete', detail: 'Escalated with Diagnostic Context' };
      }
      state.running = false;
      state.completedAt = now();
      state.elapsedSeconds = Number(((Date.now() - new Date(state.startedAt).getTime()) / 1000).toFixed(1));
    } catch (error) {
      if (error.message !== 'RUN_CANCELLED') throw error;
    }
  }
}

const orchestrator = new SimulatedOrchestrationAdapter();

function startScenario(scenario) {
  if (state.running) return false;
  const runId = state.runId + 1;
  state = initialState();
  state.runId = runId;
  state.running = true;
  state.scenario = scenario;
  state.startedAt = now();
  state.service.status = 'CRITICAL';
  state.service.errorRate = scenario === 'known' ? 0.178 : 0.214;
  state.service.readyReplicas = scenario === 'known' ? 3 : 5;
  state.service.errorSignature = scenario === 'known' ? 'MEMORY_LEAK_AFTER_DEPLOY' : 'DB_CONNECTION_SATURATION';
  void orchestrator.run(scenario, runId);
  return true;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
    if (req.method === 'POST' && url.pathname === '/api/demo/reset') {
      const nextRun = state.runId + 1;
      state = initialState(); state.runId = nextRun;
      return json(res, 200, state);
    }
    if (req.method === 'POST' && ['/api/demo/known-failure', '/api/demo/unknown-failure'].includes(url.pathname)) {
      const scenario = url.pathname === '/api/demo/known-failure' ? 'known' : 'unknown';
      if (!startScenario(scenario)) return json(res, 409, { error: 'A simulation is already running.' });
      return json(res, 202, { accepted: true, scenario, state_url: '/api/state' });
    }
    if (req.method === 'POST' && url.pathname === '/api/datadog/alert') return json(res, 202, { accepted: true, event_id: (await body(req)).id || ids.event });
    if (req.method === 'GET' && url.pathname === '/api/datadog/health') return json(res, 200, datadogHealth());
    if (req.method === 'GET' && url.pathname === '/api/argocd/application') return json(res, 200, argoApplication(state.scenario === 'known', state.service.status !== 'HEALTHY'));
    if (req.method === 'POST' && url.pathname === '/api/argocd/rollback') return json(res, 202, { operation_id: 'op-rollback-1042', status: 'Accepted', request: await body(req) });
    if (req.method === 'GET' && url.pathname === '/api/kubernetes/deployment') return json(res, 200, kubernetesDeployment());
    if (req.method === 'GET' && url.pathname === '/api/servicenow/incidents') return json(res, 200, { result: state.incident ? [state.incident] : [] });
    if (req.method === 'POST' && url.pathname === '/api/servicenow/incidents') return json(res, 201, { result: { ...await body(req), sys_id: ids.incident, number: ids.number, state: '2' } });
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/servicenow/incidents/')) return json(res, 200, { result: { ...state.incident, ...await body(req), updated_at: now() } });
    if (!url.pathname.startsWith('/api/') && serveStatic(req, res)) return;
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Kestra PoV simulator listening on http://localhost:${PORT}`));
}

module.exports = { server, initialState, evaluatePolicy };
