# Kestra Governed Incident Remediation — Proof of Value Simulator

A local Proof of Value environment demonstrating governed incident remediation across a fictional Digital Commerce Platform & SRE architecture.

> **Fictional Proof of Value scenario.** Target and all incident data, architecture assumptions, and operational metrics are simulated for demonstration purposes. This project does not represent a real Target system or engagement.

## Runtime architecture

Kestra is the real orchestration layer. The surrounding enterprise systems remain deterministic, in-memory simulations:

```text
Browser
  → PoV simulator at localhost:3000 establishes an incident condition
  → server sends a simulated Datadog event to Kestra at localhost:8080
  → real Kestra execution calls host.docker.internal:3000
  → simulated system APIs mutate in-memory state
  → browser polls simulator state and displays the real execution's progress
```

| Component | Mode | Responsibility |
| --- | --- | --- |
| Kestra | **Real** | Workflow execution, parallel diagnostics, policy evaluation, branching, and sequencing |
| Datadog | Simulated | Alert payloads and service health |
| Argo CD | Simulated | Deployment history and rollback action |
| Kubernetes | Simulated | Workload and pod readiness |
| ServiceNow | Simulated | Persistent incident creation and update |
| GitHub | **Real** | Flow and application version control |

The application does not advance orchestration with timers or a fake adapter. After it submits the Datadog webhook, only callbacks from the real Kestra execution can gather diagnostics, publish a policy decision, roll back, verify recovery, or complete the incident.

## Prerequisites and environment

- Node.js 20 or newer
- Kestra running locally at `http://localhost:8080`
- The committed `demo.incident.governed_incident_remediation` flow available in Kestra
- Kestra secret `INCIDENT_WEBHOOK_KEY` configured for that flow's webhook trigger

Copy the example configuration:

```bash
cp .env.example .env.local
```

Set the same local webhook secret configured in Kestra:

```dotenv
KESTRA_BASE_URL=http://localhost:8080
KESTRA_WEBHOOK_KEY=your-local-secret
```

`.env.local` and other local environment files are ignored by Git. Never commit the webhook key.

## Start

```bash
npm start
```

Open **http://localhost:3000**.

The server binds to `0.0.0.0:3000`, allowing Kestra in Docker Desktop to call it at `http://host.docker.internal:3000`. Confirm Docker-to-host connectivity from the appropriate environment with:

```text
GET http://host.docker.internal:3000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "kestra-pov-simulator"
}
```

## Run the demo

1. Click **Simulate known deployment regression**. The backend establishes the 17.8% 5xx / 3-of-6 state and sends the event to the real Kestra webhook. Kestra creates one incident, gathers three diagnostics in parallel, authorizes policy, invokes the simulated Argo CD rollback, verifies recovery, and resolves that same incident.
2. Click **Reset simulation**. This clears the execution ID, incident, policy, timeline, and every interaction/payload history.
3. Click **Simulate unknown production failure**. Kestra sees the 21.4% 5xx / 5-of-6 state, blocks remediation, never calls rollback, and escalates the same incident with diagnostic context.
4. Use **View payload** on any system card to inspect calls made during the real execution.

Concurrent scenario starts return HTTP 409. If the Kestra webhook cannot be reached or rejects the event, the central card reports a connection error and the scenario buttons are re-enabled.

## API contract

The real flow at `kestra/flows/governed_incident_remediation.yml` calls:

```text
POST /api/servicenow/incidents
GET  /api/datadog/health
GET  /api/argocd/application
GET  /api/kubernetes/deployment
POST /api/kestra/policy-decision
POST /api/argocd/rollback
PUT  /api/servicenow/incidents/:sysId
```

Kestra supplies `X-Kestra-Execution-Id` and `X-Kestra-Phase`. The simulator captures both in payload history and rejects invalid or conflicting callbacks.

## Tests

```bash
npm test
```

The test suite uses a local webhook receiver to verify that scenario start stops after submitting to Kestra, then drives the exact flow callback contract for authorized and blocked paths. It also checks reset determinism, same-incident updates, rollback exclusion from the blocked path, health, validation errors, and the live-Kestra UI semantics.

## Kestra artifacts

The `kestra/` directory contains the real, version-controlled Kestra flow and dashboard definitions. In particular:

- `kestra/flows/governed_incident_remediation.yml` — real webhook-driven orchestration used by this application
- `kestra/flows/incident_remediation_sanity.yml` — earlier workflow sanity artifact
- `kestra/dashboards/Incident Remediation Operations.yml` — operational dashboard
