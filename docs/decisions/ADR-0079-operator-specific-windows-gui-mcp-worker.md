# ADR-0079: 以专用 MCP Worker 接入 Windows GUI 控制服务

- **Status**: Accepted
- **Date**: 2026-07-30
- **Decider(s)**: 用户（需求与目标地址），coding agent（提案、实现与验证）
- **Tags**: `examples`, `windows`, `gui-agent`, `mcp`, `a11y`, `security`, `topology`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

运营者提供了一个运行在 Windows 上的 FastAPI 服务：通过 `/a11y_tree`、
`/screenshot`、`/click`、`/type`、`/run_exe` 等 HTTP GET 接口读取并控制
当前登录桌面。当前有效 WLAN 地址是 `192.168.66.31/24`，服务端口为
`8000`；同一台机器的 `169.254.83.107` 是无默认路由的自动配置链路本地
地址，不适合作为接入端点。

接入必须同时满足：

- Windows、Chromeleon 和实验桌面操作不能进入业务无关的平台核心；
- 不能把 GUI 工具发给所有 Frontdesk/Worker；
- 不改变 Host ↔ Runner、Backend Gateway 或三 DB 单写者契约；
- 服务本身没有身份认证，能够控制登录桌面，必须明确部署边界；
- a2a 委派仍沿用既有 `origin_user_id` 可信传播和 `root-session` 隔离。

该能力不是 Backend Gateway 的替代品。ERP/CRM/业务记忆与业务授权仍只能
走 Gateway；本接入只适用于运营者明确分配、Windows 自身已限定权限的专用
工作站。若目标 GUI 承载需要逐用户后端授权的业务操作，应先为其建设 Gateway
operation，而不是把本示例当成平行业务授权路径。

## Options Considered

- **Option A：把 Windows HTTP 接口加入 Runner 内建工具。** 调用链最短，
  但所有组都会继承桌面专用面，平台核心也会硬编码 Windows/GUI 语义。
- **Option B：专用 Worker + 私有 stdio MCP bridge。** 复用既有
  `container.json.mcpServers` 扩展点，只把工具装入一个组；无需新依赖和公共
  契约，但运营者必须自行限制 Worker 可访问用户及网络边界。
- **Option C：把桌面操作建模为 Backend Gateway operations。** 能获得逐请求
  身份授权与统一审计，适合 ERP/CRM 类业务写入；但现有 GUI 服务没有
  Gateway contract、身份入参或截图内容类型，改造范围超出本次“接通既有
  GUI agent”的目标。
- **Option D：由 Frontdesk 直接调用 HTTP。** 无独立权限面、提示词和会话
  隔离，任何 Frontdesk 请求都可能触达登录桌面。

## Decision

> **拍板**：选 Option B；对需要逐用户业务授权的 GUI 操作保留 Option C 作为
> 强制升级路径。

在 `examples/windows-gui-agent/` 提供 operator-specific Worker：

1. 私有、零第三方依赖的 stdio MCP bridge 只代理固定白名单端点；
2. endpoint 由 Worker 配置集中为 `http://192.168.66.31:8000`，模型不能提供
   host、port 或 pathname；
3. MCP 子进程显式设置大小写两种 `NO_PROXY=192.168.66.31`，避免 LAN 控制流量
   被 Host/container 的 LLM HTTP proxy 截获；
4. 所有参数做类型/长度/坐标校验，请求有超时，JSON 与截图有响应大小上限；
5. Worker 使用 `root-session`，先观察再动作，对发送、保存、删除、启动程序等
   后果性动作先向原用户确认；
6. `operate-windows-gui` 作为 Worker 私有 Skill，固化
   observe → target → confirm → act → verify 工作流，只在该组启用；
7. 拓扑安装器只在专用 Worker 注册该 MCP，并用 `gui` alias 接入 Frontdesk；
8. 运营者必须用 AgentDesk 组访问控制及网络 ACL 把该 Worker 限定给可信用户，
   不得将无认证端口暴露到公网或不可信 LAN。

## Consequences

- **Positive**: 平台核心、DB、Gateway contract 和通道契约零改动；GUI 能力按组
  隔离；a11y tree 与截图可在一次观察中共同返回；端点漂移只改一处配置。
- **Negative**: Windows 服务不接收 AgentDesk 可信身份，也没有服务端确认令牌；
  因而本示例不能为 ERP/CRM 等逐用户业务授权场景提供安全边界。提示词确认是
  人机交互保护，不等价于后端授权。
- **Neutral / Trade-offs**: Worker 的操作权限不会超过当前 Windows 登录会话，
  但也不会比它更细。若未来要求逐用户授权、不可抵赖审计或服务端幂等，必须把
  操作迁入 Gateway（Option C）或建设 Host-mediated capability token 协议，并
  另写 ADR。

## Implementation Notes

- `examples/windows-gui-agent/agent-group/gui-agent-mcp.ts`
- `examples/windows-gui-agent/agent-group/container.json`
- `examples/windows-gui-agent/agent-group/CLAUDE.local.md`
- `examples/windows-gui-agent/agent-group/skills/operate-windows-gui/`
- `examples/windows-gui-agent/configure-topology.ts`
- `examples/windows-gui-agent/README.md`
- `scripts/windows-gui-agent.test.ts`

验收包括：`pnpm typecheck`、定向 Vitest、真实 `/health`、`/screen_size` 与有界
`/a11y_tree` 只读调用。Windows 防火墙应仅允许 AgentDesk Host/可信网段访问
TCP 8000。

## References

- 用户提供的 `README_a11y.md`
- `docs/configuration-reference.md` 的 per-group MCP/network 配置
- ADR-0032（容器 egress）
- ADR-0052（Host 侧多租户访问闸）
