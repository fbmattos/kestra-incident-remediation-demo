# Kestra Governed Incident Remediation — Proof of Value Simulator

A polished, local Proof of Value simulation environment showing how Kestra can coordinate diagnosis, governed remediation, verification, escalation, and operational evidence across an enterprise toolchain.

> **Fictional Proof of Value scenario. All incident data, architecture assumptions, and operational metrics are simulated for demonstration purposes.** Target is used only as a fictional prospect context. This project does not use Target branding and does not represent a real Target system or engagement.

## What the demo proves

The fictional Digital Commerce Platform & SRE organization operates a revenue-critical `billing-service`. Datadog, Argo CD, Kubernetes, and ServiceNow already automate their own domains, but incident response between them is manually coordinated. The simulator demonstrates two outcomes:

- **Known deployment regression:** structured diagnostics match an approved policy, a rollback from `billing-v42` to `billing-v41` is authorized, health is verified, and the original ServiceNow incident is resolved.
- **Unknown production failure:** the evidence falls outside the Approved Automation Envelope, no production-changing action runs, and the original incident is escalated with diagnostic context.

The core point is governed automation that knows when not to act—not automation for its own sake.

## Architecture

The application intentionally uses one dependency-free Node.js process:

```text
Browser SPA ──polls──> In-memory simulation state
                         ▲
Datadog ──event──> Orchestration adapter ──> Argo CD
                         │                  Kubernetes
                         └────────────────> ServiceNow
```

- `server.js` serves static assets and exposes the simulated JSON APIs.
- `SimulatedOrchestrationAdapter` in `server.js` runs the deterministic orchestration sequence behind a clean boundary.
- `public/` contains the single-page presentation UI.
- State and one persistent incident object live in memory; reset always restores the same healthy baseline.
- The server binds to `0.0.0.0` on port `4173`, allowing a future Kestra container to reach it through `host.docker.internal:4173`.
- API responses include permissive local CORS headers to avoid constraining the next integration phase.

No database, Docker container, external service, or runtime network access is required.

## Simulated systems and APIs

The UI displays realistic request/response history for Datadog, Argo CD, Kubernetes, and ServiceNow. Representative externally callable endpoints include:

```text
POST /api/demo/reset
POST /api/demo/known-failure
POST /api/demo/unknown-failure
GET  /api/state

POST /api/datadog/alert
GET  /api/datadog/health
GET  /api/argocd/application
POST /api/argocd/rollback
GET  /api/kubernetes/deployment
GET  /api/servicenow/incidents
POST /api/servicenow/incidents
PATCH /api/servicenow/incidents/:id
```

GitHub and HashiCorp Vault appear only as non-interactive production control-plane context. They are not fake products in the simulator.

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open **http://localhost:4173**.

For automatic server restarts during development:

```bash
npm run dev
```

No `npm install` is required because the application has no third-party packages.

## Demo operation

1. Click **Simulate known deployment regression** and follow the Live Interaction Timeline through Verified Recovery.
2. Click **Reset simulation** to return to the deterministic healthy baseline.
3. Click **Simulate unknown production failure** and observe the policy block plus Human Intervention Required outcome.
4. Use **View payload** on any system card to inspect its complete interaction history, HTTP metadata, requests, and responses.

The two scenario controls are disabled while a run is active. Reset can interrupt any run and always returns the app to its initial state, so the demo can be repeated without restarting the server.

## Tests

```bash
npm test
```

The tests execute both scenarios through their HTTP controls, validate same-incident create/update behavior, check parallel diagnostic timestamps, confirm unknown failures produce no Argo CD production action, exercise resets, and inspect the structured service APIs.

## Future real Kestra integration

This version explicitly uses a **simulated orchestration adapter**. It is not connected to the local Kestra instance. In the next phase, replace `SimulatedOrchestrationAdapter` in `server.js` with an adapter that submits or receives real Kestra webhook execution events. From Kestra running in Docker, the simulator will be reachable at approximately `http://host.docker.internal:4173`.

## Existing Kestra artifacts

The committed `kestra/` directory contains the actual Kestra flow and dashboard work that predates this simulator. Those files are intentionally preserved and remain separate from the simulated adapter:

- `kestra/flows/incident_remediation_sanity.yml`
- `kestra/dashboards/Incident Remediation Operations.yml`
