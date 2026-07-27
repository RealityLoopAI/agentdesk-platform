# Security Policy

AgentDesk is an open, business-agnostic baseline for a multi-user enterprise
agent platform. Its headline property is an **unforgeable identity trust chain**:
every backend call is attributable to the real end user, and a prompt-injected
agent cannot forge that identity. Security reports against that property — or any
other trust boundary below — are taken seriously.

## Reporting a Vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
<https://github.com/WarriorXu0302/agentdesk-platform/security/advisories/new>.

Please include:

- the affected component (host, container runner, a channel adapter, the gateway
  contract, the observability stack, …) and version / commit,
- a description of the trust boundary you believe is crossed,
- a minimal reproduction or proof-of-concept if you have one,
- the impact you can demonstrate (identity forgery, audit bypass, cross-session
  leakage, RCE, credential disclosure, …).

This is a community-maintained baseline, not a vendored product with an SLA — we
acknowledge reports on a best-effort basis and will coordinate a fix and
disclosure timeline with you. If you operate your own deployment, also notify
your own security team: much of production hardening is operator responsibility
(see "Operator hardening" below).

## Supported Versions

Security fixes land on `main` (and the current `2.x` line). There is no
long-term-support branch — this is a baseline you fork and deploy, so track
`main` and apply the operator hardening checklist for your deployment.

## Security Model & Trust Boundaries

The load-bearing security invariants (do not weaken without an ADR documenting
the trade-off — see `CLAUDE.md` and `docs/decisions/`):

| Boundary | Mechanism | Reference |
|---|---|---|
| **Identity trust chain** | Batch-level `RequestIdentity`; `origin_user_id` propagated across a2a hops; host cross-validates the container's self-reported identity against the trusted `inbound.db` set (agent rows trust only the `origin_user_id` column, never `content.senderId`) | ADR-0017 |
| **Gateway authentication** | HMAC request signing; unsigned groups are observable + alertable (`gateway_unsigned_groups`) | ADR-0018 |
| **Credential isolation** | Host-side signing-credential proxy keeps `signingKey` out of the container (per-session unforgeable token, redacted `container.json`, structural fail-closed, default OFF); OpenAI key routed via OneCLI vault so it never enters the container | ADR-0034, ADR-0035 |
| **Audit** | Central append-only audit tables — `gateway_audit` (one row per backend call), `enterprise_audit` (role grants/revokes, command-gate denials, a2a delegations, approval decisions/expiries, roster-grant lifecycle), `dm_audit` (DM delivery decisions). The pre-forward intent write is fail-closed (no signed call without an audit row). Export a deterministic, HMAC-SHA256-signed bundle for an auditor with `pnpm audit:export` (set `AGENTDESK_AUDIT_EXPORT_KEY` to sign); retention is opt-in via `AGENTDESK_AUDIT_RETAIN_DAYS`. | ADR-0034 |
| **Fail-closed defaults** | Missing admin table → deny; uncompilable engage regex → drop, never hijack; approval card without an actor → deny; config validation rejects placeholder secrets at startup | ADR-0019, ADR-0025 |
| **Ingress durability** | Persist-before-route: the raw envelope is persisted before routing; failures are retained + operator-replayable, not silently dropped | ADR-0022 |
| **Session isolation** | Per-user / per-thread session isolation; each session maps to its own container with per-group cgroup limits | `docs/isolation-model.md` |
| **Session-dir path containment** | The session dir is bind-mounted RW into the container, so every host-side attachment path (`inbox/`, `outbox/`, and the a2a file forwarder) resolves its containment root through `resolveSessionIoRoot`, which lstats the `inbox`/`outbox` component itself and anchors containment at the **session root** — the mount source, which the container cannot replace. Never derive a containment root by realpath'ing a path that traverses a container-writable component. | `src/session-manager.ts` |
| **Memory / prompt-injection** | Long-term business memory lives only behind the backend gateway; retrieved memory is fenced with a nonce-delimited injection boundary | ADR-0033 |
| **Observability is read-only** | The Phoenix/Grafana + OpenTelemetry stack must never mutate the identity trust chain or message flow; trace content capture is opt-in and off by default | ADR-0007, ADR-0027 |

### Out of scope

- The **operator's own backend gateway, ERP/CRM, and business prompts** — the
  platform fronts these but does not define their security; a vulnerable backend
  behind the gateway is the operator's responsibility.
- **Third-party channel adapters** installed out-of-tree.
- Misconfiguration that the shipped fail-fast / hardening checklist warns against
  (e.g. disabling signing, opening container egress, running with placeholder
  secrets). These are documented operator decisions, not platform vulnerabilities.

### Accepted residuals

Deliberate trade-offs, re-affirmed by the maintainer. Please don't file these as
vulnerabilities, and don't "fix" them without raising the trade-off first.

- **`accumulate` stores non-engaging messages without consulting the access gate**
  (`src/router.ts`, the `ignored_message_policy === 'accumulate'` branch). The
  access/sender-scope gates are evaluated as `engages && …`, so a message that
  never triggered the agent is stored as silent context with the gate
  short-circuited. A sender the gate *would* refuse can therefore have their
  message persisted into the agent's `inbound.db` — and, via
  `writeSessionMessage` → `extractAttachmentFiles`, their **attachments staged to
  disk** — simply by not triggering the agent; the accumulated rows then ride
  along into the agent's context on the next legitimate trigger.
  **Why accepted:** group messages are already public to everyone in that group,
  and accumulate exists precisely so the agent can read the conversation it is
  part of; gating it would leave the agent with a truncated view and visibly
  "dropped" traffic. **Residual:** attachment bytes from a gate-refused sender do
  land on the host filesystem (inside that session's `inbox/`, path-contained per
  the session-dir row above). Revisit if untrusted-attachment storage becomes a
  concern for a deployment — the narrow fix is to keep accumulating text while
  refusing attachments from senders the gate would reject.

## Supply-chain / Dependency Posture

- CI runs `pnpm run audit` (`pnpm audit --prod --audit-level high`) on every PR
  and fails on any high/critical advisory in the **shipped** dependency tree.
- Dependabot (`.github/dependabot.yml`) opens weekly update PRs for the host npm
  tree, the container base image, and GitHub Actions.
- The container agent-runner uses a `bun.lock` lockfile, which Dependabot does not
  understand; its dependencies are tracked manually against upstream advisories
  via `bun audit` (run in `container/agent-runner/`). Reachable advisories are
  remediated with bun `overrides` in `container/agent-runner/package.json`
  (currently `hono`, `fast-uri`, `ip-address`, `qs` pinned to patched in-major
  versions, clearing the `fast-uri` path-traversal/host-confusion HIGHs).

### Suppressed advisories

A small number of advisories are suppressed in
`package.json` → `pnpm.auditConfig.ignoreGhsas` because the vulnerable code path
is provably unreachable in this platform. Each is justified here and re-evaluated
when the dependency tree changes:

| GHSA | Package | Why not applicable |
|---|---|---|
| `GHSA-qwww-vcr4-c8h2` | `react-router@7.18.1` (via the Web SPA's `react-router-dom`) | The advisory applies only to React Server Components mode and server-side Action execution. This repository ships a static Vite SPA: it has no React Router framework/RSC server, server routes, loaders, or Actions; the Host serves immutable assets and implements API endpoints independently. The advisory's stated patched release (`8.3.0`) is not published in the configured npm registry as of 2026-07-27, so there is no installable patched release. Re-evaluate this suppression when an upstream release becomes available or if the Web application adopts SSR/RSC. |

`GHSA-q7rr-3cgh-j5r3` (`@opentelemetry/exporter-prometheus`) was previously
suppressed here; it is now **resolved** by the host OTEL upgrade to the
0.221 train (`@opentelemetry/exporter-prometheus@0.221.0` carries the fix that
landed in ≥0.217). The suppression has been removed from
`package.json` → `pnpm.auditConfig.ignoreGhsas`.

`GHSA-w5hq-g745-h8pq` (`uuid@9`) was previously suppressed here. It is now
absent from the production dependency tree after overriding the OTEL GCP
resource detector's `gaxios` dependency to `7.3.0`; the suppression has been
removed.

Reachable advisories are remediated via `pnpm.overrides` (currently
`axios`, `gaxios`, `ws`, `qs`, `protobufjs`, `form-data`, and
`@opentelemetry/propagator-jaeger` pinned to patched in-major versions).
Notable pins:

| Override | Clears | Path / rationale |
|---|---|---|
| `form-data@^4.0.6` | `GHSA-hmw2-7cc7-3qxx` | CRLF injection via unescaped multipart field/filenames on `@larksuiteoapi/node-sdk → axios → form-data` — same-major patch bump. |
| `axios@^1.18.0` | `GHSA-gcfj-64vw-6mp9` | Node HTTP adapter can use an inherited proxy config; reached through the Feishu SDK's own axios dependency. |
| `gaxios@^7.3.0` | `GHSA-w5hq-g745-h8pq` | Removes the affected `uuid@9` path pulled in by the OTEL GCP resource detector. |
| `@opentelemetry/propagator-jaeger@^2.9.0` | `GHSA-45rx-2jwx-cxfr` | OTEL propagator DoS, pulled in transitively by `@opentelemetry/sdk-node`. |

These pins address reachable or production-tree advisories that turned the CI audit gate red
without any dependency change on our side — a reminder that a green local test
run does not imply green CI. Reproduce the gate locally with `pnpm run audit`
before assuming a push is clean.

### Known-deferred (container)

One container advisory is deferred rather than fixed, because the only fix is
a major dependency bump that is not safe to apply blind:

- **`GHSA-p7fg-763f-g4gf` — `@anthropic-ai/sdk`** (moderate). "Insecure default file permissions in the Local Filesystem Memory Tool." `@anthropic-ai/claude-agent-sdk@0.2.116` pins `@anthropic-ai/sdk@^0.81.0`, and the fix (`>=0.91.1`) is outside that range — clearing it requires bumping `claude-agent-sdk` (0.2 → 0.3), which changes the core Claude execution path (including the `SDKResultMessage` shape the ADR-0026 usage span depends on) and needs real-API verification. Low in-context impact: containers are single-session-isolated and this platform uses gateway-mode memory, not the local filesystem memory tool. Tracked for a deliberate, separately-verified SDK upgrade.

The runner's former OpenTelemetry 0.55 deferral was resolved on 2026-07-27 by
upgrading its trace-only SDK/exporter/resources stack to the 0.221/2.10 train.
This removes the Prometheus-exporter and Jaeger-propagator high advisories; the
runner still disables OTEL metrics and logs by default and exports only traces.

## Operator Hardening

Production safety is a shared responsibility. Before deploying, follow the
checklist in `deploy/README.md` and `docs/build-and-runtime.md`: enable HMAC
signing, lock container egress, run under a process supervisor with backups and
alerting wired, and keep `a2aSessionMode=root-session`. The shipped Alertmanager
config routes to a no-op receiver by design (dev runs credential-free) — run
`pnpm obs:alertmanager:check` in your deploy pipeline so a placeholder routing
never reaches production silently.
