# Bitable single-record CRUD pilot topology

This example keeps the platform core business-agnostic while provisioning a
dedicated `agentdesk-bitable-worker`.

```bash
pnpm exec tsx examples/bitable-pilot/configure-topology.ts
```

The reconciler is idempotent. It:

- creates or reuses `agentdesk-frontdesk`, `agentdesk-unnamed`, and
  `agentdesk-bitable-worker`;
- keeps `root-session` A2A isolation;
- exposes the Worker to Frontdesk as destination `bitable`;
- exposes Frontdesk back to the Worker as destination `frontdesk`;
- refreshes destination files for active Frontdesk sessions;
- teaches the Worker bounded structured queries and Host-confirmed single
  Create/Update/Delete while keeping Batch operations closed.

Worker configuration and instructions live in
`groups/agentdesk-bitable-worker/`. Gateway secrets and physical Feishu
resource IDs do not belong in this example; follow
`docs/feishu-bitable-pilot.md`.

For the local pilot, start the Gateway from the repository root:

```bash
node examples/bitable-pilot/start-gateway.mjs
```

The launcher reads the ignored `.env` (or `BITABLE_GATEWAY_ENV_FILE`) but
injects only Gateway/Bitable variables into the Gateway process. Empty
Bitable-specific app credentials fall back to the existing Feishu app
credentials. The local reconciler and launcher also share a purpose-separated
HMAC key: `GATEWAY_SIGNING_KEY` wins when configured; otherwise both derive the
same pilot-only key from the Feishu app secret. With
`AGENTDESK_GATEWAY_SIGNING_PROXY=true`, the Host keeps that key out of the Agent
container and signs on its behalf. Re-running the reconciler replaces a stale
materialized Worker key with the key selected by this precedence. Use dedicated
app credentials and a dedicated random `GATEWAY_SIGNING_KEY` for a production
deployment.
