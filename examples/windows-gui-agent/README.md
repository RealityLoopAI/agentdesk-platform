# Windows GUI Agent worker

This operator-specific example connects AgentDesk to the Windows accessibility
service described by `README_a11y.md`. The current endpoint is:

```text
http://192.168.66.31:8000
```

`192.168.66.31` is the active WLAN address. Do not use the Tailscale adapter's
`169.254.83.107`: it is an automatically assigned link-local address and has no
default route in the supplied `ipconfig` output.

The platform core remains business- and desktop-agnostic. A dedicated `gui`
worker receives a private stdio MCP bridge that exposes bounded health,
screen-size, screenshot, accessibility-tree, element-search, pointer, typing,
and executable-launch operations. Its private `operate-windows-gui` Skill
defines the observe → target → confirm → act → verify workflow. Other workers
receive neither the tools nor the Skill.

## Windows setup

On the Windows machine:

```powershell
pip install -r requirements_remote_agent.txt
python remote_agent.py
```

The service must listen on `0.0.0.0:8000`. Allow inbound TCP 8000 only from the
AgentDesk host or its trusted subnet. The supplied service has no authentication
layer, so never expose it to the public Internet or an untrusted LAN.

Verify from the AgentDesk host:

```bash
curl --noproxy '*' --fail http://192.168.66.31:8000/health
```

Expected:

```json
{ "status": "ok", "message": "Remote agent is running" }
```

## Install the worker topology

Start with the normal enterprise initialization, then run:

```bash
pnpm exec tsx examples/windows-gui-agent/configure-topology.ts
```

The reconciler creates `agentdesk-windows-gui-worker`, copies its private MCP
bridge, Skill, and prompt into the group directory, adds the Frontdesk
destination alias `gui`, and writes the endpoint into the worker's
`container.json`.
Running it again is safe and refreshes the copied bridge/configuration.
The MCP child also receives `NO_PROXY=192.168.66.31` (upper- and lowercase)
so a Host/container LLM proxy cannot accidentally intercept LAN GUI traffic.

Start a fresh session after changing the endpoint or bridge. MCP processes and
container configuration are loaded at session startup.

## Smoke checks

Before asking the worker to act, confirm these read-only endpoints:

```bash
curl --noproxy '*' --fail http://192.168.66.31:8000/screen_size
curl --noproxy '*' --fail \
  'http://192.168.66.31:8000/a11y_tree?scope=foreground&max_depth=1'
```

Then ask Frontdesk to inspect the current Windows foreground window. The worker
must call `gui_health`, observe the UI, and report the current window without
performing a consequential action.

## Security and rollback

This service can control the logged-in Windows desktop. Keep the worker
restricted to trusted users, retain per-user/root-session isolation, and use
network policy to allow only `192.168.66.31:8000` where available. The prompt
requires fresh observation and explicit confirmation for sends, saves,
overwrites, deletes, runs, settings changes, and other consequential actions.

To roll back, stop the Windows `remote_agent.py` service, remove the Frontdesk
`gui` destination and managed `<!-- windows-gui-agent:start -->` prompt block,
then archive/remove the dedicated GUI worker group. No DB schema or platform
contract migration is involved.
