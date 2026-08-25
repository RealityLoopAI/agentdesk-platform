## 1. 组件与交互

- [x] 1.1 在 `web/src/messages/` 定义集中管理的 UI-only 模型清单：自动选择（默认）、GPT-5.6 Sol、GPT-5.6 Terra、Claude Opus 5、Claude Sonnet 5 和 Gemini 3.6 Flash，确保选项不进入 API 类型或消息请求
- [x] 1.2 实现可访问的 `ModelSelector` 受控弹层，包括当前项、勾选态、点外部关闭、Escape 关闭、方向键导航和焦点恢复
- [x] 1.3 将模型按钮接入 `MessageComposer` 输入框底栏，在窄屏隐藏次要快捷键提示，并保持发送按钮、草稿和禁用态行为不变
- [x] 1.4 完成列表选项、当前项勾选以及桌面/窄屏视觉细节，不展示“界面预览，暂不影响实际模型”或同类免责声明

## 2. 自动化验证

- [x] 2.1 新增组件测试，覆盖默认项、切换、重新打开后的选中态、键盘操作、点外部关闭和禁用态
- [x] 2.2 扩展 MessageComposer 或 ConversationPage 测试，断言选择模型后 `onSend` / `submitMessage` 仍只收到既有消息字段
- [x] 2.3 运行 `pnpm web:typecheck`、`pnpm web:test` 和 `pnpm web:build`，修复本变更引入的问题

## 3. 视觉验收

- [x] 3.1 在桌面与窄屏会话页手动验证弹层方向、文本截断、焦点样式及发送区布局，并按需更新 Playwright 截图基线
