# ADR-0064: 建立同源 React Web UI 与公开品牌投影

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decider(s)**: 用户（确认 Web 端与推荐 UI 方案）；coding agent（提案与执行）
- **Tags**: `web`, `frontend`, `branding`, `security`, `testing`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

ADR-0062 已确定用独立 Web Listener、HTTP API 和 SSE 承载浏览器入口，但没有确定浏览器应用的工程
边界。前端需要支持飞书 SSO、会话历史、实时消息和响应式布局，同时不能把飞书应用凭证、内部机器
命名空间或任意运营配置打包进公开 JavaScript。

用户选择在 UI 中融入公司 Logo 的深青色和连结感。平台核心仍必须保持可重品牌化，不能把某一公司
名称或业务逻辑写死在前端。

## Options Considered

- **Option A：Host 模板渲染与原生 JavaScript。** 依赖少，但会话状态、SSE 重连、Markdown 与
  可访问交互需要自行维护大量基础设施，后续组件测试成本高。
- **Option B：React 单页应用，前后端同源发布。** 引入构建依赖，但路由、服务端状态、可访问组件
  和测试生态成熟；Cookie、CSRF 与 CSP 可以保持同源。
- **Option C：独立前端域名和独立部署。** 发布解耦，但需要跨域凭证、CORS 和更复杂的 Cookie
  策略，扩大当前首期安全面。

## Decision

> **拍板**：选择 Option B。

在仓库顶层建立 `web/` React + Vite + TypeScript 应用。React Router 管理 URL，TanStack Query
保存服务端权威状态，Tailwind CSS 与仓库自有的 shadcn 风格组件承载视觉层，Radix UI 提供需要的
可访问交互原语。Vitest、React Testing Library、MSW 和 Playwright 分别覆盖组件、网络契约与
浏览器流程。

生产环境由同一个 Host 版本提供 `web/dist/`，浏览器 API 始终使用相对同源路径和 HttpOnly
Cookie。唯一允许进入 Vite Bundle 的环境变量采用显式白名单；飞书 App Secret、Session Secret
和机器内部路径不得出现在前端环境变量中。

`src/branding.ts` 继续是品牌单一来源。公开 `/api/branding` 只返回经过校验的显示名、同源图片路径
和十六进制颜色 Token；非法值回退到通用的深青色/暖白色主题。Logo 加载失败时前端显示可访问的
文字回退。

## Consequences

- **Positive**: Web 与 API 同源，Cookie/CSRF/CSP 边界清晰；前端状态和交互可以分层测试；下游
  部署无需改源码即可替换显示名、Logo 与主题。
- **Negative**: 增加 Node 前端构建链和依赖更新责任；生产发布必须先构建 `web/dist/`。
- **Neutral / Trade-offs**: 首期只提供浅色主题；如果以后需要前后端独立域名，必须重新审查
  CORS、Cookie 与 CSRF 策略，而不能只改一个 URL。

## Implementation Notes

- 前端工程：`web/`
- 公开品牌投影：`src/branding.ts`、`GET /api/branding`
- 运行说明：`docs/web-channel.md`
- 依赖 ADR-0061、ADR-0062。
- 验收至少包括 Host/前端类型检查、品牌接口测试、组件测试和生产构建。

## References

- `openspec/changes/add-web-feishu-unified-messaging/design.md`
- `openspec/changes/add-web-feishu-unified-messaging/tasks.md`
- ADR-0061、ADR-0062
