# Managed Python Environments V1

Visualization Companion owns two isolated Python environment identities. The environments are derived from web-managed repository bindings and never write into an upstream checkout.

| Environment | Source authority | Consumers |
| --- | --- | --- |
| `core-env` | Connection → Agent Core | Agent Core, fixed Subagent |
| `swarm-core-env` | Connection → JiuwenSwarm plus its inspected `openjiuwen` source | JiuwenSwarm Agent Team, SwarmFlow |

The standalone Agent Core binding does not override the Core selected by JiuwenSwarm. A remote Swarm Core source is identified by its credential-free Git URL, declared ref, and exact `uv.lock` revision. A local Swarm Core source is identified by its allowed-root path and Git revision.

## Desired-state contract

`GET /api/v1/environments` computes the current desired state without writing files. `POST /api/v1/environments/refresh` accepts an empty JSON object and atomically refreshes generated specs.

Each spec contains:

- bound project path, connection type, HEAD revision, branch, and dirty state;
- `pyproject.toml` and `uv.lock` SHA-256 evidence;
- managed CPython `3.11` policy and the project's `requires-python` constraint;
- fixed consumer mapping;
- the inspected Swarm Core source when applicable;
- a canonical SHA-256 fingerprint that excludes timestamps;
- a frozen, project-lock synchronization contract.

Missing or malformed locks, unsupported Python constraints, unavailable repositories, unlocked remote Core dependencies, and mismatched Swarm lock evidence produce a blocked spec. A blocked spec may be recorded for diagnostics but must never be activated.

## Local storage boundary

Companion stores generated state below:

```text
.openjiuwen-visualization/environments/
├── specs/
│   ├── core-env.json
│   └── swarm-core-env.json
├── core-env/
│   ├── active.json
│   └── generations/
└── swarm-core-env/
    ├── active.json
    └── generations/
```

Only `specs/` is populated by the desired-state stage. `active.json` and generation directories are reserved for verified reconciliation and atomic activation. The whole root is local-only and ignored by Git.

Generated specs contain no provider credential or model/context payload. Direct dependency URLs containing credentials are rejected and never echoed. Source `pyproject.toml`, `uv.lock`, and framework files are read only; project code is never imported during planning.

## Reconciliation boundary

The contract reserves `uv` as the package manager, CPython `3.11` as the runtime line, `uv.lock` as dependency authority, and an atomic generation switch as the activation strategy. Actual Python provisioning, `uv sync --frozen`, health probes, cleanup, and runtime executor binding are implemented as separate layers so a failed build cannot replace a working generation.
