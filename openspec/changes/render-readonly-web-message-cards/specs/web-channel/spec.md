## ADDED Requirements

### Requirement: Web 只读问题卡片

Web 历史 API SHALL 将符合平台标准 `ask_question` 结构的 Agent 出站消息表示为白名单化的只读问题卡片，同时保留人类可读的文本回退。Web MUST NOT 将任意 Agent JSON 当作 UI 组件协议，也不得通过该卡片提供回答、确认、拒绝或取消能力。

#### Scenario: 飞书问题卡同步到 Web

- **WHEN** 一条发送至飞书且已经持久化的标准 `ask_question` 消息出现在用户有权访问的 Lane 中
- **THEN** Web 显示包含标题、问题和选项的只读卡片，而不是显示原始 JSON，并明确提示用户在飞书端完成选择

#### Scenario: Web 不提供卡片回答

- **WHEN** 用户查看尚未回答的只读问题卡片
- **THEN** 选项以非交互列表展示，Web 不提供按钮、回答接口或其他可以解决该问题的操作

#### Scenario: 另一渠道已经回答

- **WHEN** Host 已在同一根 Session 中持久化与问题标识匹配的 `question_response`
- **THEN** Web 卡片显示已回答、已取消或已关闭状态，并且只在回答值与持久化选项匹配时突出显示对应选项

#### Scenario: 问题在浏览器打开期间被回答

- **WHEN** 飞书或其他已注册 Host 响应路径解决正在 Web 中显示的问题
- **THEN** Host 在响应持久化后发布该 Lane 的可重放消息更新事件，Web 刷新权威历史并更新只读卡片状态

#### Scenario: 旧客户端读取卡片消息

- **WHEN** 不识别只读卡片扩展字段的 Web 客户端读取一条有效 `ask_question` 消息
- **THEN** 客户端仍可通过既有 `text` 字段显示人类可读的问题摘要，而不是必须解析机器 JSON

#### Scenario: 结构化载荷不合法

- **WHEN** Agent 出站内容伪装为卡片但缺少必需字段、超过展示边界或使用未允许的卡片类型
- **THEN** Web 不创建结构化卡片、不执行其中的 HTML 或脚本，并安全降级为受净化的文本展示

#### Scenario: 用户请求无权访问的卡片历史

- **WHEN** 已认证用户请求不属于自己或已无法通过 Agent Group 与 Organization 访问门的 Lane
- **THEN** 系统在解析或返回卡片内容前拒绝访问，且不泄露问题标题、正文、选项或状态
