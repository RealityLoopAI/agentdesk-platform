# AgentDesk 本地全链路人工验收与演示手册

本文用于人工确认或现场演示以下本地评测拓扑：

- AgentDesk Host、Web、飞书长连接和 Host 签名代理；
- 小环整句语音 Bridge 与火山方舟识别；
- 飞书多维表格（Bitable）Field List、确认、Create、Get；
- NAS 图片监控、飞书图片发送；
- 图片分析 JSON 校验与 Bitable 自动写入；
- Vision Archive 只读查询；
- Grafana、Phoenix、Prometheus 和 Alertmanager 监控链路；
- macOS `launchd` 与 Docker 的进程存活和异常拉起能力。

这是一份现场操作手册，不代替单元测试。建议每次发布前执行“完整验收”，每次演示前执行
“五分钟冒烟”，出现故障时按文末定位表排查。

## 1. 验收等级

| 等级 | 用时 | 是否访问外部服务 | 是否写 Bitable | 适用场景 |
| --- | ---: | --- | --- | --- |
| S0 静态检查 | 5–15 分钟 | 否 | 否 | 代码或配置变更后 |
| S1 五分钟冒烟 | 5 分钟 | 只做健康检查 | 否 | 每次演示前 |
| S2 核心交互 | 10–15 分钟 | 飞书、Agent Provider、Gateway | 否 | 验证 Web/飞书会话同步 |
| S3 业务全链路 | 20–40 分钟 | 方舟、飞书、Bitable、NAS | 是 | 发布验收或正式演示 |
| S4 恢复能力 | 10 分钟 | 与当时运行配置相同 | 可能 | 验证进程持续存活；可选 |

合格的“完整验收”至少包含 S1、S2 和 S3。S4 会短暂中断服务，只在现场允许时执行。

## 2. 安全边界与停止条件

开始 S3 前，操作人必须确认本轮允许把测试音频、图片和结构化 JSON 发送到当前配置的
火山方舟、飞书及 Bitable 目标。测试内容只能使用非敏感数据。

- 仅使用专用测试表、测试飞书私聊和只读 NAS 挂载。
- 不在命令、截图或验收记录中保存 API Key、HMAC Key、飞书令牌、物理
  `app_token`/`table_id`、完整音频或完整模型响应。
- 不覆盖、不移动、不删除 NAS 上已有文件；测试数据必须由设备新产生，或在另行获准后以
  新文件名加入专用目录。
- 不通过直接调用飞书或 Bitable API 绕过 Host/Gateway。所有业务操作必须走当前系统链路。
- Web 的 `ask_question` 卡片是只读镜像；选择和批准操作在飞书原用户卡片中完成。
- JSON 合格结果是机器自动写入，不出现飞书确认卡；语音 Create 必须由原飞书用户确认。
- Archive 仅允许按用户请求查询元数据和受限 JSON，不允许修改、复制或后台扫描归档。

遇到下列任一情况立即停止继续写入，保留日志和 ID 后转入故障定位：

- 同一输入产生两条及以上 Bitable 记录；
- 未确认的语音草稿已经写入；
- 不合格 JSON 已写入；
- 不同飞书用户看到了彼此的会话或确认卡；
- 日志出现凭证、音频 Base64、完整敏感内容或物理表标识；
- NAS 被系统写入或修改。

## 3. 测试准备

### 3.1 人员与设备

- 一台运行本仓库的 macOS 主机，Docker Desktop 可用；
- 已登录的目标飞书用户和对应 P2P 会话；
- 可登录 Web 的同一个规范用户；
- 小环硬件与 Mac 位于可信局域网，硬件上传地址为
  `http://192.168.66.113:50020/api/audio`；
- 图片/JSON 测试时，NAS 共享已只读挂载，拍照设备和分析生产端可用；
- Bitable 测试表可在界面中核对记录数和字段值。

### 3.2 本轮编号

为每次测试建立唯一编号，格式建议为：

```text
E2E-YYYYMMDD-HHMM-操作人缩写
```

验收记录只保存该编号、时间、脱敏后的 capture ID 后缀、逻辑资源、record ID、audit ID、
结果和必要截图。语音测试可使用现有合法单选值，示例批次为“测试三号”；正式执行前必须
用实时 Field List 确认它仍然是合法选项。

### 3.3 打开三个观察面

1. 终端 A：启动和状态。
2. 终端 B：持续日志。
3. 浏览器与飞书：打开同一会话；另开 Bitable 测试表。

终端 A：

```bash
cd /Users/realityloop/agentdesk/agentdesk-platform
pnpm services:start
pnpm services:status
```

终端 B：

```bash
cd /Users/realityloop/agentdesk/agentdesk-platform
pnpm services:logs
```

如果只看某一组件：

```bash
bash examples/local-evaluation-stack/manage-services.sh logs host
bash examples/local-evaluation-stack/manage-services.sh logs bitable
bash examples/local-evaluation-stack/manage-services.sh logs archive
bash examples/local-evaluation-stack/manage-services.sh logs observability
```

主要界面：

- Web：<http://127.0.0.1:3100/login>
- Grafana：<http://127.0.0.1:3001>
- Phoenix：<http://127.0.0.1:6006>
- Prometheus：<http://127.0.0.1:9091>
- Alertmanager：<http://127.0.0.1:9093>

## 4. S0：代码与配置静态检查

代码或配置发生变化后执行；单纯重复现场演示可跳过。

```bash
pnpm typecheck
pnpm test
bash examples/local-evaluation-stack/manage-services.sh render
```

通过标准：

- typecheck 和测试全部通过；
- 三个 LaunchAgent plist 均通过系统格式校验；
- `.env`、WAV、运行数据库和现场日志没有进入 Git 待提交文件；
- Docker Agent Runner 镜像已按当前代码构建。

如果 Runner 或容器内技能发生变化，再执行：

```bash
pnpm container:build
```

## 5. S1：五分钟只读冒烟

### T01 — 统一启动与进程状态

执行：

```bash
pnpm services:start
pnpm services:status
```

通过标准：

- `com.agentdesk.full-host`、`com.agentdesk.bitable-gateway`、
  `com.agentdesk.archive-gateway` 均处于运行状态；
- Host `3200/readyz`、语音 Bridge `50020/healthz`、Web `3100/login` 返回成功；
- Bitable `8088`、Archive `8090` 和签名代理 `8799` 均已监听；
- Grafana、Prometheus、Alertmanager、Phoenix 健康；
- Docker daemon 可用，无本轮新产生的 `Created` 残余 Agent 容器。

注意：Gateway 的 `/describe` 需要签名。手工无签名请求返回 `401`/`403` 可以证明监听和
鉴权都在工作，不能把它误报为 Gateway 失败。`pnpm services:status` 已按此规则探测。

### T02 — 端口归属

```bash
lsof -nP -iTCP:3100 -iTCP:3200 -iTCP:50020 -iTCP:8088 -iTCP:8090 -iTCP:8799 -sTCP:LISTEN
lsof -nP -iUDP:50020
```

通过标准：

- `3100`、`3200`、`50020`、`8799` 归属于同一个组合 Host Node 进程；
- `8088` 和 `8090` 分别由 Bitable、Archive Gateway 进程监听；
- UDP `50020` 没有旧版 VAD/RTP 服务；
- 没有 Python 参考接收器与语音 Bridge 同时争用 TCP `50020`。

### T03 — 运行日志清洁度

```bash
tail -n 200 data/runtime-logs/host.err.log
tail -n 100 data/runtime-logs/bitable.err.log
tail -n 100 data/runtime-logs/archive.err.log
```

通过标准：本轮启动后没有新的 `uncaught`、`fatal`、端口占用、数据库损坏、签名密钥不匹配
或持续重启日志。历史 warning 需要记录，但不能与本轮新错误混淆。

### T04 — Web 页面和飞书连接

1. 打开 Web 登录页并进入当前会话。
2. 确认页面能加载历史消息，浏览器没有持续断线提示。
3. 打开同一规范用户的飞书机器人私聊。

通过标准：Web 可登录、当前 Lane 可打开，飞书机器人可接收消息；此步骤不发送业务指令。

## 6. S2：Web/飞书统一会话验收

### T10 — 飞书到 Web 同步

在飞书私聊发送：

```text
【<本轮编号>】连通性测试。请只回复：链路在线
```

观察最多 3 分钟。

通过标准：

- 飞书出现用户消息和 Agent 回复；
- Web 当前 Lane 出现同一轮用户消息和 Agent 回复；
- 两端内容、顺序和归属一致，没有重复消息；
- Web 刷新后消息仍然存在。

### T11 — Web 到统一会话

在 Web 当前 Lane 发送：

```text
【<本轮编号>】Web 反向同步测试。请只回复：Web 链路在线
```

通过标准：Web 能正常发送并获得回复，且仍使用原 Lane，不新建第二个 Lane，也不覆盖或抢占
已有飞书/Web Binding。Web 用户输入本身不要求再次投递到飞书，以免伪装成飞书用户消息；如果
该 Lane 已启用飞书 delivery subscription，则符合条件的纯文本 Agent 回复应额外镜像到飞书。

### T12 — Web 只读卡片

此测试会进入语音/Bitable 澄清链，但最后取消，不应写表。先用 T40 的只读请求确认一个实时
合法批次选项，然后对小环说：

```text
批次<实时合法批次>，使用电子天平，无水氯化铜二点五克。
```

预期 `设备仪器=电子天平` 不在实时单选 options 中，Worker 应先获取实时 Field List，再向
原飞书用户发出字段澄清卡。依次检查：

1. 飞书显示可交互 `ask_question` 卡片和实时合法选项；
2. Web 同一 Lane 显示相同标题、问题和选项，但没有确认交互；
3. 在飞书选择一个合法设备选项；
4. 如果随后出现 Create 确认卡，选择取消；
5. Web 中原卡片应同步为已处理状态，不能继续显示为可操作卡。

通过标准：卡片不是原始 JSON 文本，两端不生成两份独立问题，取消后 Bitable 零新增。

## 7. S3：语音 → 方舟 → 飞书确认 → Bitable

### T20 — 前置条件

1. 确认 T01 全部通过。
2. 确认硬件可以访问 Mac 的 `192.168.66.113:50020`。
3. 在 Bitable Worker 中执行一次只读字段查询，或通过正常用户请求让 Worker读取实时
   `feishu.bitable.field.list`。
4. 核对 `批次`、`设备仪器`、`无水氯化铜（克）` 字段仍存在；确认本轮要使用的批次和
   `链路测试` 是实时合法单选值。
5. 在 Bitable UI 记录测试前总行数。

建议只读请求：

```text
【<本轮编号>】请读取测试多维表格的实时字段列表和单选选项，只返回字段名称和选项，不要创建或修改记录。
```

### T21 — 取消路径（必须先测）

对小环说“你好小环”，设备回应后清晰读出：

```text
批次测试三号，使用链路测试，无水氯化铜二点五克。
```

预期阶段：

1. 硬件向 `/api/audio` POST 完整 WAV，并迅速得到 HTTP `202`；
2. Host 日志出现音频接收和方舟处理阶段；
3. 飞书收到 transcript 镜像；
4. Bridge 生成结构化草稿并投递到同一用户 Lane；
5. Worker 获取实时 Field List，校验草稿；
6. 原飞书用户收到 Create 确认卡；
7. 在飞书选择取消。

通过标准：取消后 Bitable 总行数不变，Gateway audit 中没有该草稿成功
`feishu.bitable.record.create` 的最终记录，Web 只读卡片显示已取消。

### T22 — 批准路径

重新唤醒并读出同一句测试语音。这是新的硬件采集，应产生新的 capture ID。在飞书最终
Create 确认卡中选择批准。

通过标准：

- 只创建一条记录；
- 新记录字段精确为 `批次=测试三号`、`设备仪器=链路测试`、
  `无水氯化铜（克）=2.5`；
- Worker 使用返回的 record ID 调用 `record.get` 并核对结果；
- audit 中能找到该次 Field List、Create 和 Get，HTTP 状态成功；
- 飞书和 Web 显示同一轮处理结果；
- 本机不调用设备 TTS，语音提示仍由硬件负责。

方舟和 Agent 处理不是同步 HTTP 请求。HTTP `202` 只表示 WAV 已安全接收，不表示识别、
用户确认或写表成功；完整链路现场预算建议预留 3–5 分钟。

### T23 — 相同 WAV 去重（可选）

仅在有一份已获授权、非敏感的本地 `test.wav` 时执行：

```bash
curl -sS -X POST http://127.0.0.1:50020/api/audio \
  -H 'Content-Type: audio/wav' \
  --data-binary @test.wav
curl -sS -X POST http://127.0.0.1:50020/api/audio \
  -H 'Content-Type: audio/wav' \
  --data-binary @test.wav
```

通过标准：第二次响应包含 `duplicate: true`，不产生第二次方舟调用、Agent turn 或写表意图。
不要把测试 WAV 提交到仓库。

### T24 — 语音证据核对

只从日志中筛选事件名和脱敏 ID，不导出完整 transcript：

```bash
tail -n 1000 data/runtime-logs/host.out.log | rg \
  'xiaohuan_|voice_photo_|gateway|record|field'
```

预期至少能观察到：

- `xiaohuan_feishu_transcript_mirrored`；
- `xiaohuan_bitable_draft_delivered`；
- Worker 的 Field List、Create、Get 结果；
- 对应 gateway audit 成功记录。

## 8. S3：拍照 → 飞书图片 + JSON → Bitable

图片通知和 JSON 写表是两条独立状态链。一个失败不能被另一个成功掩盖。

### T30 — 前置条件和基线

1. 确认 NAS 是只读挂载，且 Host 用户能读取
   `/Volumes/video_database/voice_photos`。`pnpm services:status` 必须同时将
   `Photo/JSON root` 和 `Archive root` 显示为 `[OK]`；仅端口健康不代表采集卷可用。
2. 启动日志中已经出现 `voice_photo_monitor_ready` 和
   `voice_photo_json_baseline_complete`。
3. 必须在基线完成后产生新文件；启动前已存在的文件只进入 baseline，不应被重新发送。
4. 在 Bitable UI 记录目标表测试前总行数。
5. 若测试场景二，确认实时单选中精确存在 `测试版本` 和 `链路测试`；否则本轮标记为
   “前置配置不满足”，不要为了演示跳过 Field List 校验。

记录测试前状态：

```bash
sqlite3 -header -column \
  examples/voice-photos-feishu-monitor/.state/hardware-test-v2.sqlite \
  "SELECT status, COUNT(*) AS count FROM notification_events GROUP BY status;"
sqlite3 -header -column \
  examples/voice-photos-feishu-monitor/.state/json-monitor.sqlite \
  "SELECT status, COUNT(*) AS count FROM json_ingest_events GROUP BY status;"
```

### T31 — 图片通知

准备一个非敏感测试画面，使用设备当前配置的拍照口令；默认演示口令为：

```text
你好小环，拍照。
```

如果硬件的拍照指令不同，以硬件配置为准。等待文件落入 NAS 并经过多个稳定扫描周期。

通过标准：

- 新图片只发送一次到配置的飞书私聊；
- 日志出现 `voice_photo_delivered`，并包含 provider message ID；
- SQLite 对应事件状态为 `delivered`；
- 重启 Host 后同一图片不再次发送；
- NAS 原文件没有被修改。

### T32 — 合格 JSON 自动写表

推荐用“场景二”演示：画面清晰且仪器读数稳定，让上游分析端产生新的 JSON。合格条件必须
全部满足：

- 顶层 `画面状态=清晰`；
- `有读数=true`；
- 必填字段和置信度有效；
- `采用图片` 指向清晰帧；
- 采用帧的最终数值和单位与顶层结果一致；
- 场景精确存在于封闭路由，单位被该路由允许。

场景二预期映射：

```text
logical resource = voice.photo.scene2
批次 = 测试版本
设备仪器 = 链路测试
无水氯化铜（克） = JSON 最终数值
```

通过标准：

- 日志出现 `voice_photo_json_submitted`；
- 不出现飞书确认卡；
- Worker 执行实时 Field List、Create 和按 record ID 的 Get；
- `json_ingest_events` 最终状态为 `verified` 并保存一个 record ID；
- Bitable 精确新增一条、字段值与 JSON 证据一致；
- 相同 digest 不产生第二条记录。

### T33 — 不合格 JSON 拒绝（可选）

仅在测试生产端支持生成专用负例、且现场允许新增测试文件时执行。产生一个
`画面状态=模糊` 或 `有读数=false` 的新 JSON，不得覆盖已有文件。

通过标准：日志出现 `voice_photo_json_rejected`，观察状态为 `invalid`，Bitable 零新增，
飞书不出现写表确认卡。未知场景也必须拒绝，不能回退到其他表。

### T34 — 图片/JSON 证据核对

```bash
sqlite3 -header -column \
  examples/voice-photos-feishu-monitor/.state/hardware-test-v2.sqlite \
  "SELECT relative_path, status, attempts, provider_message_id, failure_code, delivered_at FROM notification_events ORDER BY created_at DESC LIMIT 10;"
sqlite3 -header -column \
  examples/voice-photos-feishu-monitor/.state/json-monitor.sqlite \
  "SELECT relative_path, status, record_id, updated_at FROM json_ingest_events ORDER BY updated_at DESC LIMIT 10;"
```

验收记录中可保留相对测试文件名和 ID，但不要保存图片内容或完整 JSON 内容。

## 9. S3：Bitable Worker 独立能力

语音和 JSON 已覆盖写入链。以下用自然语言独立确认 Worker 与 Gateway，不通过任何直连脚本。

### T40 — 实时 Field List

在飞书发送：

```text
【<本轮编号>】请查询测试多维表格的实时字段列表和单选选项，不要创建、修改或删除记录。
```

通过标准：Worker 返回当前真实字段；不能使用旧提示词或历史会话中的字段替代实时结果。

### T41 — 直接 Create 的取消与批准

在飞书提出一条使用实时合法值的测试记录创建请求。第一次在最终确认卡取消，确认零新增；
第二次重新发起并批准，确认精确新增一条且 Worker 完成 Record Get。不得在同一条取消请求上
重复点击或绕过确认。

通过标准与 T21/T22 相同；额外确认 Create audit 的 trusted user 和 Agent Group 与当前
会话一致，`identity_mismatch` 不为真。

## 10. S3：Archive Worker 只读查询

### T50 — 发现和查询

在飞书或 Web 输入一个已知日期的只读请求，例如：

```text
【<本轮编号>】查询 2026-07-31 的实验归档，只返回候选实验名称、日期和可用类别，不读取二进制文件，不做任何修改。
```

通过标准：

- Frontdesk 路由到 Archive Worker；
- Worker 通过 Gateway 执行发现、授权和最小查询；
- 有结果时只返回逻辑元数据或受限 JSON；
- 无结果时明确返回“查询成功但结果为零”，不能说成“归档不存在”；
- 502/`BACKEND_UNAVAILABLE` 必须报告为后端或只读挂载不可达，不能伪装成零结果；
- 不产生启动扫描、后台 watcher、本地索引或 NAS 写入。

### T51 — Archive 失败语义

若真实返回 502，只记录发生时间、请求编号、Gateway HTTP 状态和挂载状态。恢复后重新发送
用户查询即可，不复用失败操作伪造结果，也不需要重新采集语音或图片。

## 11. S3：审计和可观测性

### T60 — Gateway 审计

```bash
sqlite3 -header -column data/v2.db \
  "SELECT id, occurred_at, agent_group_id, path, operation, logical_resource, status, http_status, audit_phase, identity_mismatch FROM gateway_audit ORDER BY id DESC LIMIT 40;"
```

通过标准：

- 本轮 Field List/Create/Get/Archive 操作都有可对应的 audit；
- 成功调用的最终阶段 HTTP 为 2xx；
- `signed_as_group` 与被授权 Worker 一致；
- `identity_mismatch` 不为真；
- 审计中没有物理表 ID、凭证或完整业务内容。

### T61 — Grafana/Phoenix/Prometheus

1. 在 Grafana 查看本轮时间窗口内 Host、Gateway、容器和错误指标。
2. 在 Phoenix 查看本轮 Agent 调用的 trace，使用时间和脱敏 ID 关联。
3. 在 Prometheus 确认 targets 正常，Alertmanager 没有本轮新触发的严重告警。

通过标准：业务结果能与 trace/audit 时间对应；可观测性只读，不改变消息、身份或确认状态。

## 12. S4：存活和恢复能力（可选，会短暂中断）

### T70 — 关闭终端后持续运行

关闭启动服务时使用的所有终端，等待 30 秒，再开新终端执行：

```bash
cd /Users/realityloop/agentdesk/agentdesk-platform
pnpm services:status
```

通过标准：所有服务仍可用。长进程由 `launchd` 管理，不依赖某个终端或 Codex 任务存活。

### T71 — Host 异常退出自动拉起

先记录 PID：

```bash
launchctl print "gui/$(id -u)/com.agentdesk.full-host" | rg 'pid =|runs =|state ='
```

仅在允许短暂中断时执行：

```bash
launchctl kill SIGTERM "gui/$(id -u)/com.agentdesk.full-host"
```

等待 10–30 秒，再执行：

```bash
launchctl print "gui/$(id -u)/com.agentdesk.full-host" | rg 'pid =|runs =|state ='
pnpm services:status
```

通过标准：PID 改变、`runs` 增加、状态重新为 running，所有健康检查恢复；已 delivered 图片和
verified JSON 不重放。不要使用模糊 `pkill` 或批量杀进程。

### T72 — 全栈正常重启

```bash
pnpm services:restart
pnpm services:status
```

通过标准：90 秒健康预算内全部恢复，Web 历史会话和飞书 Binding 保留，Bitable/Archive
Gateway 可继续处理新请求，旧文件不重放。

## 13. 20 分钟现场演示脚本

如果时间有限，按以下顺序演示：

1. **0–2 分钟：系统概览。** 执行 `pnpm services:status`，说明组合 Host 中包含 Web、
   飞书、语音 Bridge、图片和 JSON Adapter；两个业务 Gateway 独立运行。
2. **2–5 分钟：统一会话。** 在飞书发送 T10 文本，展示 Web 同一 Lane 同步出现。
3. **5–11 分钟：语音写表。** 读 T22 语音，展示 transcript、Web 只读卡片、飞书确认，
   批准后展示 Bitable 新行和 audit。
4. **11–15 分钟：拍照双链路。** 触发一次拍照，展示飞书图片；若分析 JSON 已完成，再展示
   自动写表且没有确认卡。若上游分析较慢，使用上一轮已记录的 verified 证据说明异步阶段。
5. **15–18 分钟：归档查询。** 执行 T50，强调只读、按需、零结果与后端不可达的区别。
6. **18–20 分钟：可观测与存活。** 展示 Grafana/Phoenix 和 LaunchAgent 状态，说明关闭
   终端不影响服务。

演示前不要预先创建会被监控器当成“新文件”的图片/JSON；必须等 baseline ready 后再触发。

## 14. 总体验收判定

满足以下全部条件才判为“当前系统完整可用”：

- S1 所有健康检查通过，组合 Host 没有退出或重启循环；
- 飞书与 Web 使用同一 Lane，消息不丢失、不重复、不新建冲突 Binding；
- Web 把 `ask_question` 渲染为只读卡片，飞书回答后状态同步；
- 语音取消零写入，批准精确写一条，Field List/Create/Get 和 audit 完整；
- 图片精确发送一次，重启后不重放；
- 合格 JSON 自动精确写一条、不出确认卡，不合格 JSON 零写入；
- Archive 查询成功语义正确，全程只读；
- 审计、日志和 trace 可关联，身份链未出现 mismatch；
- 未暴露凭证、完整敏感内容或物理资源标识；
- 可选 S4 执行时，进程自动拉起且业务状态保留。

允许标记为“部分可用”的情况必须明确写出边界，例如“Web/飞书/语音入口正常，但 JSON 上游
未产出文件，故 T32 未执行”。不能用单个 `/readyz` 成功代替全链路通过。

## 15. 故障定位速查

| 现象 | 优先检查 | 典型归属 |
| --- | --- | --- |
| `3200/readyz`、3100、50020、8799 同时失败 | `launchctl print`、`host.err.log`、端口占用 | 组合 Host 进程 |
| 50020 健康，但硬件无 HTTP 202 | LAN、硬件目标地址、WAV 格式/大小、队列 | 硬件 → Bridge 入口 |
| HTTP 202，但无 transcript | `xiaohuan_*` 方舟阶段、Ark Key/模型/超时 | Bridge → 火山方舟 |
| 有 transcript，无草稿或草稿进错会话 | senderIdentity、规范用户、P2P Binding、Lane | Bridge → Host 路由 |
| Web 显示原始 JSON 而不是卡片 | Web 只读卡片解析和 SSE 消息 | Web 渲染 |
| 飞书有消息，Web 没同步 | Lane ID、Web/Feishu Binding、SSE、持久化消息 | 统一会话 |
| Field List/Archive `/describe` 连续 502 | 8088/8090、8799、Docker、Gateway 日志 | Gateway/Host 签名代理 |
| Field List 成功，Create 未开始 | Worker 草稿校验、确认卡、writer 权限 | Bitable Worker/策略 |
| Create 成功，Get 失败 | record ID、Gateway/Bitable 上游、audit | Bitable 读回验证 |
| 图片未发飞书 | NAS 挂载、baseline、稳定扫描、图片状态 DB、飞书上传 | 图片 Adapter |
| 图片成功，JSON 没写 | JSON 是否新产生、资格校验、场景路由、JSON 状态 DB | JSON Adapter/上游分析 |
| JSON submitted 长期未 verified | Worker 容器、Field List、Gateway audit、记录 Get | JSON Worker/Gateway |
| Archive 返回零结果 | 先看 HTTP/audit；2xx 零结果才是真零结果 | Archive 查询语义 |
| Agent 容器停在 `Created` | Host 生命周期日志、容器标签、并发启动/清理 | Container runner 生命周期 |
| 关闭终端后服务退出 | LaunchAgent 是否已 install/loaded，plist 路径 | launchd 安装状态 |

统一采集故障状态：

```bash
pnpm services:status
docker ps -a
tail -n 300 data/runtime-logs/host.out.log
tail -n 200 data/runtime-logs/host.err.log
tail -n 200 data/runtime-logs/bitable.err.log
tail -n 200 data/runtime-logs/archive.err.log
```

不要为了绕过 502 改成 Worker 直连上游；Gateway 是业务授权和长期数据的唯一通路。

## 16. 验收记录模板

```markdown
# AgentDesk 人工验收记录

- 本轮编号：
- 操作人：
- 开始/结束时间：
- Git commit：
- 服务配置版本：
- 外部发送/写表授权：已确认 / 未确认
- 使用的逻辑资源：
- 测试前 Bitable 行数：
- 测试后 Bitable 行数：

| 用例 | 开始时间 | 输入摘要 | 预期 | 实际 | 证据 ID/截图 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | | | | | | PASS/FAIL/SKIP |
| T10 | | | | | | PASS/FAIL/SKIP |
| T12 | | | | | | PASS/FAIL/SKIP |
| T21 | | | | | | PASS/FAIL/SKIP |
| T22 | | | | | | PASS/FAIL/SKIP |
| T31 | | | | | | PASS/FAIL/SKIP |
| T32 | | | | | | PASS/FAIL/SKIP |
| T40 | | | | | | PASS/FAIL/SKIP |
| T50 | | | | | | PASS/FAIL/SKIP |
| T60 | | | | | | PASS/FAIL/SKIP |
| T71 | | | | | | PASS/FAIL/SKIP |

- capture ID 脱敏后缀：
- Bitable record ID：
- Gateway audit ID：
- 图片 provider message ID：
- JSON ingest 状态：
- 新出现的 warning/error：
- 未执行项及原因：
- 总结：完整可用 / 部分可用 / 不可用
- 后续动作：
```

测试记录完成后，不自动删除任何业务数据。若需要清理测试行，应先根据本轮 record ID 精确
确认目标，再通过 Bitable UI 或正常的受确认业务流程处理；不得批量删除或清理 NAS。
