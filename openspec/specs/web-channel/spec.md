# web-channel Specification

## Purpose
TBD - created by archiving change add-web-feishu-unified-messaging. Update Purpose after archive.
## Requirements
### Requirement: 飞书 SSO 保护的 Web 访问

Web Surface 的所有会话、消息和事件流接口 SHALL 要求已经认证的平台用户。未认证请求不得泄露任何会话元数据。

#### Scenario: 未认证 API 请求

- **WHEN** 没有有效 Web Session 的浏览器请求会话接口
- **THEN** 系统返回认证错误，且不返回会话标识或内容

#### Scenario: 已认证浏览器 Session

- **WHEN** 用户完成飞书 SSO 并获得有效 Web Session
- **THEN** 浏览器只能请求该规范用户有权访问的资源

### Requirement: 用户自有会话列表

Web API SHALL 只列出由当前规范用户拥有，且当前仍能通过 Agent Group 与 Organization 访问门的活动或归档会话 Lane。列表必须包含足以区分助手和来源渠道的非敏感元数据，并在历史协调完成后反映该用户合格的飞书已有会话。

#### Scenario: 用户查看会话列表

- **WHEN** 已认证用户请求自己的会话
- **THEN** 结果只包含该用户拥有且仍有权访问的 Lane，并标识助手名称、来源渠道和最后活动时间

#### Scenario: 登录后权限被撤销

- **WHEN** 用户建立 Web Session 后，其 Agent Group 或 Organization 权限被撤销
- **THEN** 下一次会话列表或消息请求必须拒绝访问被撤销的范围

### Requirement: 飞书已有会话作为 Web 主流程

Web 应用 SHALL 在飞书 SSO 后先协调并展示当前用户合格的飞书已有会话。查看或继续这些会话不得要求用户选择 Agent、Agent Group 或助手；飞书入站 Wiring 已确定的 Agent Group 必须作为服务端权威路由上下文。

#### Scenario: 登录后存在飞书历史

- **WHEN** 用户通过飞书 SSO 登录，且历史协调找到一条仍有权访问的飞书用户级 Lane
- **THEN** 会话列表自动显示该对话，用户可以直接打开历史并继续发送消息

#### Scenario: 飞书产生新消息

- **WHEN** 已登录用户的合格飞书 Lane 收到并持久化一条新消息或 Agent 回复
- **THEN** Web 实时事件或后续列表刷新显示该变化，无需用户新建会话或重新选择助手

#### Scenario: 查看已有会话

- **WHEN** 用户从列表打开一条飞书来源 Lane
- **THEN** Web 直接加载该 Lane 的权威历史，不显示“选择 Agent”前置步骤

### Requirement: Web 新建会话作为辅助流程

Web 应用 SHALL 将主动新建 Web 对话呈现为会话列表中的次要操作，并在终端用户文案中使用“助手”而不是暴露 `Agent Group` 或 `Lane`。创建操作仍必须使用服务端返回且当前有权访问的 Agent Group。

#### Scenario: 只有一个可用助手

- **WHEN** 用户主动新建 Web 对话且当前只有一个可用助手
- **THEN** Web 直接创建该助手的独立 Web Lane，不额外显示选择对话框

#### Scenario: 存在多个可用助手

- **WHEN** 用户主动新建 Web 对话且当前有多个可用助手
- **THEN** Web 显示“选择助手”对话框，并只列出服务端确认有权访问的助手

#### Scenario: 没有可用助手

- **WHEN** 用户没有可用助手且没有可见历史会话
- **THEN** Web 不提供无效的选择框，提示联系管理员分配权限，且不泄露不可访问的助手信息

#### Scenario: 没有历史但可以新建

- **WHEN** 用户没有飞书历史会话但至少有一个可用助手
- **THEN** 空状态同时提供前往飞书开始对话的说明和次要的 Web 新建入口

### Requirement: Web 消息持久化接入

Web API 提交的消息 SHALL 经过与其他 Channel Adapter 相同的“先持久化再路由”、访问门、Session 写入、身份盖章和容器唤醒路径。

#### Scenario: Web 消息被接受

- **WHEN** 已认证用户向可访问的会话 Lane 提交合法消息
- **THEN** 消息在 Agent 路由前被持久化，并携带已认证的规范用户身份

#### Scenario: 客户端重复重试

- **WHEN** 浏览器用相同客户端消息标识重复提交消息
- **THEN** 系统最多接受一条逻辑入站消息，并对后续重复请求返回既有结果

### Requirement: Web 实时更新

Web Surface SHALL 提供可重连的服务端到客户端事件流，用于传递已持久化的会话事件，并支持从最后已见 Cursor 重放。

#### Scenario: Agent 回复到达

- **WHEN** Agent 回复已经为用户正在查看的 Lane 完成持久化
- **THEN** 系统在持久化写入后将该回复发到该用户的实时事件流

#### Scenario: 浏览器重新连接

- **WHEN** 浏览器携带合法的最后已见 Cursor 重新连接
- **THEN** 系统按顺序重放该用户有权访问的遗漏事件，且不暴露其他用户事件

### Requirement: 分页会话历史

Web API SHALL 提供稳定、可分页的历史记录。历史由 Session 的权威 inbound/outbound 数据库组装，并包含用户有权查看的发送者、来源渠道、时间、投递状态和文件元数据。

#### Scenario: 请求历史分页

- **WHEN** 用户请求自己所拥有会话的一页历史
- **THEN** 系统按确定性顺序返回消息和下一页 Cursor

#### Scenario: 请求未授权 Lane

- **WHEN** 用户请求其他用户拥有的 Lane 历史
- **THEN** 系统拒绝访问，且不透露该 Lane 是否包含消息

### Requirement: 浏览器安全控制

Web Surface SHALL 使用 Secure、HttpOnly Session Cookie，对写请求执行 CSRF 防护，对事件流执行同源校验，并实施请求体上限、限流及凭证日志/Trace 脱敏。事件流明确携带 Origin 时必须精确匹配公开 Origin；原生同源 EventSource 未携带 Origin 时，只有 Host 精确匹配公开 Origin 且 `Sec-Fetch-Site` 为 `same-origin` 才能作为兼容证明。

#### Scenario: 跨站消息提交

- **WHEN** 写请求缺少合法 CSRF 证明或来自不允许的 Origin
- **THEN** 系统在路由和持久化之前拒绝该请求

#### Scenario: 同源 EventSource 没有 Origin

- **WHEN** 已认证浏览器从相同 Origin 建立事件流，请求没有 Origin、Host 与公开 Origin 一致且 `Sec-Fetch-Site` 为 `same-origin`
- **THEN** 系统允许事件流并立即发送连接确认帧

#### Scenario: 事件流同源证明不完整

- **WHEN** 事件流没有 Origin，且 Host 不匹配或 `Sec-Fetch-Site` 缺失、为 `same-site`、`cross-site` 或 `none`
- **THEN** 系统返回 `403`，且不建立或重放任何用户事件流

#### Scenario: 事件流携带错误的明确 Origin

- **WHEN** 事件流携带不匹配或为 `null` 的 Origin，即使 Host 和 Fetch Metadata 看似同源
- **THEN** 系统以明确 Origin 为准返回 `403`

#### Scenario: 请求体过大

- **WHEN** 客户端提交超过 Web 配置上限的请求体
- **THEN** 服务器拒绝请求，且不唤醒 Agent 容器

### Requirement: Web Channel 隔离

Web Channel MUST NOT 为普通终端用户使用 `agent-shared` Session，也不得允许浏览器提供的用户 ID、Agent Group ID、Organization ID 或 Session ID 覆盖服务端解析的授权上下文。

#### Scenario: 浏览器冒充其他用户

- **WHEN** 消息 Payload 中包含与当前登录 Session 不同的用户 ID
- **THEN** 系统忽略或拒绝该值，并继续以已认证的规范用户为权威身份

### Requirement: 可导航的会话界面

Web 应用 SHALL 提供登录页、以飞书已有会话为主的会话列表和可通过不透明 Lane ID 定位的会话工作区。用户刷新页面、使用浏览器前进后退或在窄屏设备切换视图时，不得丢失已经由服务端确认的会话状态。

#### Scenario: 打开指定会话地址

- **WHEN** 已认证用户打开自己有权访问的 `/conversations/:laneId`
- **THEN** Web 应用加载对应会话历史并将其标记为当前会话

#### Scenario: 打开无权访问的会话地址

- **WHEN** 已认证用户打开不存在或无权访问的 Lane 地址
- **THEN** Web 应用展示统一的不可访问状态，且不泄露该 Lane 是否存在

### Requirement: 前端消息一致性

Web 应用 SHALL 以服务端持久化历史为消息真相源，使用客户端消息标识、服务端消息标识和事件标识归并 POST 响应、历史查询及 SSE 重放，不得因请求重试、事件重放或到达顺序不同显示重复消息。

#### Scenario: POST 与 SSE 到达顺序相反

- **WHEN** 同一条已提交消息的 SSE 事件早于或晚于 POST 响应到达
- **THEN** Web 应用最终只展示一条服务端确认的消息，并保留正确的发送状态

#### Scenario: SSE 重放已经显示的事件

- **WHEN** 浏览器重连后收到已经处理过的 Event ID
- **THEN** Web 应用忽略重复事件并保持消息顺序不变

### Requirement: 实时连接恢复

Web 应用 SHALL 维护单个用户级 SSE 连接，记录最后确认 Cursor，采用有界退避重连，并在恢复后重新校验可能受影响的服务端状态。

#### Scenario: 网络短暂中断

- **WHEN** SSE 连接因临时网络错误断开后恢复
- **THEN** Web 应用从最后确认 Cursor 继续接收事件，并展示可理解的重连状态

#### Scenario: 登录 Session 在连接期间失效

- **WHEN** SSE 或后续 API 表明 Web Session 已过期或被撤销
- **THEN** Web 应用关闭事件流、清除内存中的受保护数据并要求重新登录

### Requirement: 前端安全存储与内容渲染

Web 应用 MUST NOT 把 Web Session、飞书 Token、Authorization Code 或 CSRF Token 写入浏览器持久化存储。Agent 输出必须作为纯文本或经过白名单净化的 Markdown 渲染，不得执行未受信任 HTML 或脚本。

#### Scenario: Agent 输出包含脚本内容

- **WHEN** Agent 消息包含 HTML Script、事件处理属性或危险 URL
- **THEN** Web 应用将其转义或净化，且浏览器不执行其中代码

#### Scenario: 用户刷新页面

- **WHEN** 用户刷新已登录页面
- **THEN** Web 应用通过 HttpOnly Cookie 重新请求当前会话，不从浏览器持久化存储恢复敏感凭证

### Requirement: 可访问且响应式的交互

Web 应用 SHALL 支持桌面与窄屏布局、键盘完成核心会话操作、清晰的焦点状态，以及不会因高频消息片段持续打断读屏的状态播报。

#### Scenario: 键盘发送消息

- **WHEN** 键盘用户聚焦消息输入区并执行发送操作
- **THEN** 消息被提交，焦点行为可预测，发送中或失败状态可被辅助技术感知

#### Scenario: 窄屏查看会话

- **WHEN** 用户在窄屏设备从会话列表选择一个 Lane
- **THEN** 界面切换到消息工作区，并提供返回会话列表的明确操作

### Requirement: 可配置的轻量品牌化界面

Web 应用 SHALL 使用语义化 Design Token 提供企业简洁、轻量品牌化的界面。平台显示名、Logo 和允许公开的主题值必须来自统一品牌配置，不得在通用前端组件中写死特定公司名称或品牌资产。

#### Scenario: 使用公司品牌配置

- **WHEN** 运营者配置经过批准的显示名、同源 Logo 和主题 Token
- **THEN** 登录页、导航、Agent 标识和关键交互使用该品牌配置，而会话与安全行为保持不变

#### Scenario: 没有部署专属品牌资源

- **WHEN** 部署没有提供可用的专属 Logo 或主题覆盖
- **THEN** Web 应用使用通用且可访问的默认品牌资源，不出现破损图片或空白主操作

### Requirement: 品牌视觉克制

Web 应用 SHALL 将品牌色和 Logo 图形集中用于主操作、当前选择、焦点、登录、空状态和 Agent 身份，不得以重复 Logo 纹理、大面积低对比度背景或持续快速动画干扰消息阅读。

#### Scenario: 展示长篇 Agent 回复

- **WHEN** Agent 回复包含长文本、表格和代码块
- **THEN** 内容使用高对比度中性阅读区域，品牌元素不会遮挡、压缩或降低正文可读性

#### Scenario: 用户要求减少动画

- **WHEN** 浏览器启用 `prefers-reduced-motion`
- **THEN** Logo 处理动画变为静态图形和文字，且不影响处理状态识别

### Requirement: 混合消息视觉层级

Web 应用 SHALL 将用户消息呈现为右对齐品牌色气泡，将 Agent 回复呈现为带品牌标识的左对齐中性内容区，并将单条消息状态与全局连接状态分级展示。

#### Scenario: 用户消息发送失败

- **WHEN** 一条用户消息提交失败
- **THEN** 失败原因和重试操作显示在该消息附近，而不是只显示无上下文的全局提示

#### Scenario: 实时连接中断

- **WHEN** 用户级 SSE 连接断开并开始重连
- **THEN** 页面显示全局连接状态条，同时保留消息内容和未发送的输入草稿

### Requirement: 品牌主题可访问性

Web 应用 SHALL 使用系统字体、清晰焦点样式和不依赖单一颜色的状态表达；正式主题的正文颜色对比度必须满足 WCAG 2.2 AA。Logo 和状态图形必须提供适当的替代文本或在纯装饰时从辅助技术隐藏。

#### Scenario: 品牌主色不满足对比度

- **WHEN** 运营者配置的前景色与背景色组合未通过规定的对比度校验
- **THEN** 系统拒绝该主题配置或回退到可访问的安全 Token

#### Scenario: 读屏用户识别状态

- **WHEN** 消息从发送中变为成功或失败
- **THEN** 用户可以通过文字和辅助技术语义识别状态，而不需要依赖颜色变化

### Requirement: 安全 Markdown 和代码展示

Web 应用 SHALL 对 Markdown 执行白名单净化，并支持标题、列表、引用、链接、表格和代码块。代码块必须支持横向滚动、语言标识和复制操作，不得执行消息中的 HTML、脚本或危险 URL。

#### Scenario: 展示包含表格和代码的回复

- **WHEN** Agent 返回合法 Markdown 表格和代码块
- **THEN** Web 应用以可读、可复制且不会撑破窄屏布局的形式展示内容

#### Scenario: Markdown 中包含危险内容

- **WHEN** Agent 返回脚本标签、事件属性、危险协议链接或未经允许的 HTML
- **THEN** Web 应用移除或转义危险内容，且浏览器不执行其中代码
