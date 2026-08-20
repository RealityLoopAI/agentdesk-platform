# Local full-evaluation service manager (macOS)

This example manages the business-specific local evaluation topology used by
the Xiaohuan voice/photo/JSON flow. It intentionally lives under `examples/`:
the generic platform host does not assume that Bitable, Vision Archive, or the
Xiaohuan bridge is installed.

The manager starts and supervises:

- one combined Node process containing the Xiaohuan audio/Bitable bridge,
  photo and JSON adapters, Web/Feishu channels, and the AgentDesk Host;
- the local Bitable Gateway on port `8088`;
- the local Vision Archive Gateway on port `8090`;
- the production observability Compose stack (enabled by default).

The three Node processes are installed as per-user macOS LaunchAgents with
`RunAtLoad` and `KeepAlive`. Closing Terminal or ending a Codex task therefore
does not stop them; if a process exits unexpectedly, `launchd` starts it again.
The observability containers use `restart: unless-stopped`.

For a step-by-step release acceptance checklist and a 20-minute live demo
script, see [MANUAL-ACCEPTANCE.md](./MANUAL-ACCEPTANCE.md).

## First installation

Prerequisites:

- macOS with Docker Desktop installed;
- Node.js 20 or newer and project dependencies installed;
- the root `.env` plus
  `examples/xiaohuan-doubao-audio/.env` and
  `examples/xiaohuan-bitable-bridge/.env`;
- the AgentDesk container image already built with `pnpm container:build`.

Run once:

```bash
pnpm services:install
```

This replaces transient jobs with persistent plists under
`~/Library/LaunchAgents`, starts Docker Desktop when necessary, starts every
service, and waits for the Host, Voice Bridge, Web, Gateway, and observability
health checks. It also fails closed when the configured photo/JSON or Vision
Archive directory is not mounted and readable; an open Gateway port alone is
not treated as a healthy data path.

## Daily commands

```bash
pnpm services:start
pnpm services:status
pnpm services:restart
pnpm services:stop
pnpm services:logs
```

Service-specific logs:

```bash
bash examples/local-evaluation-stack/manage-services.sh logs host
bash examples/local-evaluation-stack/manage-services.sh logs bitable
bash examples/local-evaluation-stack/manage-services.sh logs archive
bash examples/local-evaluation-stack/manage-services.sh logs observability
```

Node logs persist under `data/runtime-logs/`. `stop` preserves databases,
logs, plists, and Docker volumes; a later `start` resumes the stack. To remove
the generated LaunchAgents as well:

```bash
bash examples/local-evaluation-stack/manage-services.sh uninstall
```

## Useful overrides

Skip the observability stack when only the core evaluation flow is needed:

```bash
AGENTDESK_START_OBSERVABILITY=0 pnpm services:start
```

Render and validate the plists without loading or restarting anything:

```bash
bash examples/local-evaluation-stack/manage-services.sh render
```

The plists never contain application secrets. The combined Host reads the
three existing env files through Node's `--env-file`; each Gateway launcher
loads only its least-privilege subset from the root `.env`.

## Availability boundary

`launchd` keeps the Node processes alive after terminal closure and restarts
process crashes. Docker's restart policy keeps the monitoring containers alive
after Docker daemon restarts. A full machine reboot still requires the user to
log in so macOS can load per-user LaunchAgents, and Docker Desktop must be
configured or allowed to start in that login session.
