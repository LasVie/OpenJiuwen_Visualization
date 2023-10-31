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
├── python/                      # uv-managed CPython 3.11
├── cache/                       # environment-only uv cache
├── specs/
│   ├── core-env.json
│   └── swarm-core-env.json
├── core-env/
│   ├── active.json
│   └── generations/<fingerprint-prefix>/
│       ├── generation.json
│       └── venv/
└── swarm-core-env/
    ├── active.json
    └── generations/<fingerprint-prefix>/
```

The whole root is local-only and ignored by Git. Generation names use a bounded fingerprint prefix to stay below Windows path limits; manifests retain the complete SHA-256 identity.

Generated specs contain no provider credential or model/context payload. Direct dependency URLs containing credentials are rejected and never echoed. Source `pyproject.toml`, `uv.lock`, and framework files are read only; project code is never imported during planning.

## Reconciliation boundary

`POST /api/v1/environments/{core-env|swarm-core-env}/reconcile` accepts an empty JSON object and reconciles only the selected identity. The same operation is available from each repository card in the web “连接” page; normal users do not need a Terminal command.

Reconciliation performs the following fixed pipeline:

1. resolve the current desired fingerprint and reject blocked lock/source evidence;
2. locate or provision uv-managed CPython `3.11` below the local environment root;
3. create a new staging generation and run `uv sync --frozen --no-default-groups` against the bound project's exact `uv.lock`;
4. require exact CPython 3.11, `uv sync --check`, `uv pip check`, and both consumer bridge probes;
5. promote the verified staging directory and atomically replace `active.json`;
6. retain the active generation and at most one previous generation, removing older managed generations only.

`core-env` selects the bounded Agent Core extras `observability` and `sqlite` when declared. `swarm-core-env` follows JiuwenSwarm's own lock, including its exact Core Git revision or allowed local Core path; it never borrows the standalone Agent Core binding.

Commands use fixed argv with `shell=false`, disable interactive Git credentials and keyring lookup, strip Provider secrets from the child environment, and suppress raw child output. A failed build, dependency check, or probe never replaces the prior active generation. Existing generations are revalidated before reuse; a tampered generation is rebuilt in staging and replaced only after all checks pass. Reconciliation is rejected while a Runtime invocation is active and concurrent reconciliation of the same identity returns a conflict.

Verified TLS remains mandatory for Python and dependency downloads. The implementation does not silently disable certificate checks; a host clock that makes certificates “not yet valid” returns `system_clock_invalid` with an actionable web diagnostic.

## Current integration boundary

This stage owns desired-state generation, provisioning, verification, activation, cleanup, API control, and web status. Binding the four Runtime executors to the active manifest and recording environment identity in Trace evidence is the next layer; until that layer is complete, existing executor-specific Python configuration remains their runtime authority.
