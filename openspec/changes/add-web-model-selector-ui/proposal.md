## Why

Web 会话输入区目前没有模型选择入口，无法预览未来按模型切换的交互形态。先提供一个纯前端、可操作的模型选择器，可以低成本确认布局、文案和可用性，同时避免在尚未确定后端模型路由契约前扩大实现范围。

## What Changes

- 在 Web 消息输入框底栏增加模型选择按钮，视觉位置参考现有聊天产品的“当前模型 + 展开箭头”样式。
- 点击按钮后展示一个轻量弹出列表，固定包含自动选择、GPT-5.6 Sol、GPT-5.6 Terra、Claude Opus 5、Claude Sonnet 5 和 Gemini 3.6 Flash；当前选择以勾选状态和按钮文案同步反馈。
- 默认选中一个模型，并允许用户在当前页面生命周期内切换展示状态。
- 选择结果仅保存在前端组件状态中，不随消息提交、不调用后端、不改变真实推理模型，也不写入浏览器持久化存储。
- 保留现有发送、回车换行、禁用态和响应式布局行为。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `web-channel`: 为可访问且响应式的 Web 会话界面补充纯展示型模型选择器的行为、可访问性和非功能边界。

## Impact

- 主要影响 `web/src/messages/MessageComposer.tsx`，并新增或复用一个前端弹出选择组件。
- 增加 MessageComposer 组件测试，必要时更新 Web 会话 E2E 截图。
- 不改 Web API、`submitMessage` 请求体、数据库、容器运行配置、Provider 配置或身份/隔离链路。
- 优先使用现有 React、Lucide 和 Tailwind 能力；若项目没有合适的可访问菜单基元，使用原生按钮与受控弹层实现，避免为演示 UI 引入新的依赖类别。
