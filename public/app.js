const $ = (id) => document.getElementById(id);
const systemNames = { datadog: 'Datadog', argocd: 'Argo CD', kubernetes: 'Kubernetes', servicenow: 'ServiceNow' };
let currentState;
let inspectorSystem = null;
let inspectorSelectedIndex = null;
let elapsedTimer;

function clock(iso, withDate = false) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso));
}

function pct(value) { return `${(value * 100).toFixed(1)}%`; }

function syntax(value) {
  const escaped = JSON.stringify(value, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")|\b(true|false)\b|\b(null)\b|-?\d+(?:\.\d+)?/g, (match, key, string, bool, nil) => {
    if (key) return `<span class="json-key">${key}</span>`;
    if (string) return `<span class="json-string">${string}</span>`;
    if (bool) return `<span class="json-boolean">${bool}</span>`;
    if (nil) return `<span class="json-null">${nil}</span>`;
    return `<span class="json-number">${match}</span>`;
  });
}

function renderPolicy(policy) {
  const status = $('policy-status');
  status.textContent = policy.status;
  status.className = policy.status === 'AUTHORIZED' ? 'authorized' : policy.status === 'BLOCKED' ? 'blocked' : 'not-evaluated';
  $('policy-checks').innerHTML = policy.checks.length ? policy.checks.map((check) => `
    <div class="policy-check ${check.pass ? 'pass' : 'fail'}">
      <i>${check.pass ? '✓' : '×'}</i><span>${check.label}</span><small>${check.evidence}</small>
    </div>`).join('') : '<p class="empty-policy">Structured diagnostics determine whether a production change is permitted.</p>';
}

function renderSystems(state) {
  Object.entries(state.interactions).forEach(([system, history]) => {
    const latest = history.at(-1);
    if (latest) {
      $(`${system}-latest`).textContent = latest.summary;
      $(`${system}-time`).textContent = clock(latest.timestamp);
    }
    document.querySelector(`[data-system="${system}"]`)?.classList.toggle('active', Boolean(latest && Date.now() - new Date(latest.timestamp).getTime() < 1250));
  });
  $('datadog-state').textContent = state.service.errorRate >= .05 ? 'Alerting' : 'Healthy';
  $('argocd-state').textContent = state.service.deployment === 'billing-v41' ? 'Rolled back' : 'Synced';
  $('kubernetes-state').textContent = `${state.service.readyReplicas} / ${state.service.desiredReplicas}`;
  $('servicenow-state').textContent = state.incident ? state.incident.state_label : 'No incident';
}

function renderTimeline(items) {
  $('timeline').innerHTML = items.length ? items.map((item) => `
    <div class="timeline-row ${item.parallelGroup ? 'parallel' : ''} ${item.tone}">
      <time>${clock(item.timestamp)}</time><strong>${item.system}</strong><span>${item.message}</span>
    </div>`).join('') : '<div class="empty-state"><span>◇</span><p>Run a scenario to observe governed orchestration across systems.</p></div>';
  if (items.length) $('timeline').scrollTop = $('timeline').scrollHeight;
}

function renderOutcome(state) {
  if (!state.scenario) {
    $('outcome-title').textContent = 'Awaiting incident';
    $('outcome-content').innerHTML = '<p>The service is healthy. No orchestration is active.</p>';
    return;
  }
  if (state.running && state.policy.status === 'NOT EVALUATED') {
    $('outcome-title').textContent = 'Diagnosis in progress';
    $('outcome-content').innerHTML = '<p>Diagnostic evidence is being assembled before any production action is considered.</p>';
    return;
  }
  if (state.policy.status === 'AUTHORIZED') {
    $('outcome-title').textContent = state.running ? 'Automated Remediation' : 'Verified Recovery';
    $('outcome-content').innerHTML = `<div class="outcome-hero"><strong>${state.running ? 'PRODUCTION CHANGE AUTHORIZED' : 'AUTOMATED REMEDIATION'}</strong><span>${state.running ? 'Inside approved policy boundaries' : `Time to verified recovery: ${state.elapsedSeconds.toFixed(1)} seconds`}</span></div>
      <div class="outcome-grid"><div><span>Deployment</span><b>${state.service.deployment}</b></div><div><span>HTTP 5xx</span><b>${pct(state.service.errorRate)}</b></div><div><span>Kubernetes</span><b>${state.service.readyReplicas} / ${state.service.desiredReplicas} Ready</b></div><div><span>Human intervention</span><b>${state.service.humanIntervention || 'NONE'}</b></div></div>`;
    return;
  }
  if (state.policy.status === 'BLOCKED') {
    const pkg = state.diagnosticPackage;
    $('outcome-title').textContent = 'Human Intervention Required';
    $('outcome-content').innerHTML = `<div class="outcome-hero blocked"><strong>AUTOMATED ACTION: BLOCKED</strong><span>Outside Approved Remediation Policy</span></div>${pkg ? `<div class="outcome-grid"><div><span>5xx rate</span><b>${pct(pkg.elevated_5xx_rate)}</b></div><div><span>Recent deployment</span><b>NONE</b></div><div><span>Kubernetes</span><b>${pkg.kubernetes_readiness} Ready</b></div><div><span>Error signature</span><b>${pkg.error_signature}</b></div><div><span>Policy result</span><b>${pkg.policy_result}</b></div><div><span>Production action</span><b>${pkg.production_action}</b></div></div>` : '<p>Policy evaluation blocked the production change.</p>'}`;
  }
}

function render(state) {
  currentState = state;
  document.body.classList.toggle('running', state.running);
  $('service-status').textContent = state.service.status;
  $('service-status').className = `status ${state.service.status.toLowerCase()}`;
  $('health-dot').style.background = state.service.status === 'HEALTHY' ? 'var(--green)' : state.service.status === 'CRITICAL' ? 'var(--red)' : 'var(--amber)';
  $('deployment').textContent = state.service.deployment;
  $('error-rate').textContent = pct(state.service.errorRate);
  $('replicas').textContent = `${state.service.readyReplicas} / ${state.service.desiredReplicas} Ready`;
  $('active-incident').textContent = state.incident ? `${state.incident.number} · ${state.incident.state_label}` : 'No active incident';
  const elapsed = state.startedAt ? (state.running ? (Date.now() - new Date(state.startedAt).getTime()) / 1000 : state.elapsedSeconds) : null;
  $('elapsed').textContent = elapsed === null ? '—' : `${elapsed.toFixed(1)} sec`;
  $('orchestrator-status').textContent = state.orchestrator.status;
  $('orchestrator-detail').textContent = state.orchestrator.detail;
  $('known-button').disabled = state.running;
  $('unknown-button').disabled = state.running;
  $('live-indicator').className = state.running ? 'live-indicator live' : 'live-indicator';
  $('live-indicator').innerHTML = `<i></i>${state.running ? 'LIVE' : state.completedAt ? 'COMPLETE' : 'IDLE'}`;
  renderPolicy(state.policy);
  renderSystems(state);
  renderTimeline(state.timeline);
  renderOutcome(state);
  if (inspectorSystem && !$('inspector').hidden) renderInspector(inspectorSystem, inspectorSelectedIndex);
}

async function fetchState() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`State request failed: ${response.status}`);
    render(await response.json());
  } catch (error) {
    console.error(error);
  }
}

async function action(endpoint) {
  const response = await fetch(endpoint, { method: 'POST' });
  if (!response.ok) throw new Error((await response.json()).error || `Request failed: ${response.status}`);
  await fetchState();
}

function renderInspector(system, selectedIndex) {
  inspectorSystem = system;
  const history = currentState?.interactions[system] || [];
  $('inspector-title').textContent = `${systemNames[system]} interaction history`;
  if (!history.length) {
    $('history-tabs').innerHTML = '<span class="empty-policy">No API interactions recorded yet.</span>';
    $('request-meta').innerHTML = '<span>Run a scenario to capture request and response evidence.</span>';
    $('request-section').hidden = true;
    $('response-json').innerHTML = syntax({ status: 'No interaction data' });
    return;
  }
  const index = selectedIndex ?? history.length - 1;
  inspectorSelectedIndex = Math.min(index, history.length - 1);
  const item = history[inspectorSelectedIndex];
  $('history-tabs').innerHTML = history.map((entry, i) => `<button class="${i === inspectorSelectedIndex ? 'active' : ''}" data-history-index="${i}">${i + 1}. ${entry.summary}</button>`).join('');
  $('request-meta').innerHTML = `<span class="method">${item.method}</span><span>${item.endpoint}</span><span class="response-ok">${item.responseStatus}</span><time>${clock(item.timestamp, true)}</time>`;
  $('request-section').hidden = !item.request;
  $('request-json').innerHTML = syntax(item.request);
  $('response-json').innerHTML = syntax(item.response);
  document.querySelectorAll('[data-history-index]').forEach((button) => button.addEventListener('click', () => renderInspector(system, Number(button.dataset.historyIndex))));
}

document.querySelectorAll('[data-payload]').forEach((button) => button.addEventListener('click', () => {
  $('inspector').hidden = false;
  inspectorSelectedIndex = null;
  renderInspector(button.dataset.payload);
}));
$('close-inspector').addEventListener('click', () => { $('inspector').hidden = true; inspectorSystem = null; inspectorSelectedIndex = null; });
$('inspector').addEventListener('click', (event) => { if (event.target === $('inspector')) { $('inspector').hidden = true; inspectorSystem = null; inspectorSelectedIndex = null; } });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('inspector').hidden = true; inspectorSystem = null; inspectorSelectedIndex = null; } });
$('known-button').addEventListener('click', () => action('/api/demo/known-failure').catch(console.error));
$('unknown-button').addEventListener('click', () => action('/api/demo/unknown-failure').catch(console.error));
$('reset-button').addEventListener('click', () => action('/api/demo/reset').catch(console.error));

fetchState();
setInterval(fetchState, 300);
elapsedTimer = setInterval(() => { if (currentState?.running) render(currentState); }, 100);
