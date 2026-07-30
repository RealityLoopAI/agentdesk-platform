# 小环实验 JSON → 飞书多维表格 Bridge（macOS）

这个 operator-specific 示例把小环的 RTP/Opus 音频交给现有 VAD/方舟
`experiment-audio.v1` pipeline，再以固定规范用户和固定飞书 P2P 路由送入
AgentDesk Host。Agent 只按 Bridge 已映射的字段草稿，通过 Backend Gateway
发现、校验、授权、向原用户确认、创建并按 Record ID 读回验证。

Bridge 是默认关闭的入站 Channel。它不持有飞书/Bitable 凭证，不接受
`app_token`、`table_id` 或 tenant token，不直接调用飞书 API 或 Gateway
`/execute`。物理表标识与凭证只属于 Gateway 部署。

## 前置条件

- macOS 主机与小环在可互通的局域网，已安装 Node.js、pnpm、FFmpeg 和 ffprobe。
- AgentDesk 的 Feishu P2P 路由已经存在；配置的规范用户就是该 P2P 用户。
- Frontdesk 已采用本变更中的 Bridge envelope 约束；使用 Worker 拓扑时，
  `bitable` destination 已指向更新后的 Bitable Worker。
- Gateway 已发布并实现：
  `feishu.bitable.field.list`、`feishu.bitable.record.create` 和
  `feishu.bitable.record.get`，且逻辑资源已映射到专用测试表。
- 小环硬件发送目标与 SDP 的地址、UDP 端口一致。仓库示例 SDP 当前使用
  `192.168.66.113:50020`；部署地址不同就先复制 SDP 到本机忽略目录并修改
  `o=`、`c=` 中的 IP，同时把小环发送目标改为相同地址。不要提交现场地址。

先检查依赖和 macOS 防火墙：

```bash
ffmpeg -version
ffprobe -version
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
lsof -nP -iUDP:50020
```

## UDP 50020 互斥

独立诊断监听器与 Bridge 都会启动 FFmpeg 读取同一个 SDP/UDP 50020，二者不能
同时运行。包括以下独立入口：

- `realtime-cli.ts`
- `vad-service-cli.ts`
- 手工运行的 `ffmpeg -i ...sdp`
- VLC 或其他绑定/读取该 RTP 端口的程序

切换到 Bridge 前，在独立监听器所在终端按 `Ctrl-C`，等待其清理完成，再检查：

```bash
lsof -nP -iUDP:50020
```

若进程不在当前终端，先用 `lsof` 确认 PID 和命令，再对那个明确 PID 发送
`TERM`；不要用模糊进程名批量杀进程，也不要先用 `KILL`：

```bash
ps -p <PID> -o pid,ppid,command
kill -TERM <PID>
lsof -nP -iUDP:50020
```

端口仍被占用就停止，不要启动 Bridge。端口冲突会使 Bridge 失败关闭；不要把
“Host 仍在运行”误认为音频入口已经启动。

## 配置

复制模板到被 Git 忽略的 `.env`：

```bash
cp examples/xiaohuan-bitable-bridge/.env.example \
  examples/xiaohuan-bitable-bridge/.env
chmod 600 examples/xiaohuan-bitable-bridge/.env
```

必须显式设置三道开关；任一不是精确的 `true`，Bridge 都不会完成启动：

```dotenv
XIAOHUAN_BITABLE_BRIDGE_ENABLED=true
XIAOHUAN_BITABLE_ALLOW_EXTERNAL_UPLOAD=true
XIAOHUAN_BITABLE_ALLOW_AGENT_DELIVERY=true
```

它们分别表示启用 Bridge、同意本次服务生命周期内把检测到的语句上传方舟、
同意把结构化草稿送入 Agent/确认链。请在每次真实监听前重新确认现场人员知情。

填写固定部署绑定：

```dotenv
XIAOHUAN_BITABLE_AUTHENTICATED_USER_ID=<Host 中已有的规范用户 ID>
XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID=feishu:p2p:ou_<该用户 open_id>
XIAOHUAN_BITABLE_RESOURCE=<Gateway 中批准的测试表逻辑别名>
XIAOHUAN_BITABLE_SDP_PATH=<本机 SDP 的绝对路径>
```

`XIAOHUAN_BITABLE_RESOURCE` 只能是 Gateway 逻辑别名；形似物理
`bas...`/`tbl...` 的值会被拒绝。用户、P2P 路由和资源都只来自这份
operator-controlled 配置，不能从音频、transcript、设备地址或模型输出覆盖。

字段映射是 `experiment-audio.v1` 源路径到真实表字段名的 JSON。只支持：

- `captureId`
- `transcript`
- `experiment.title`
- `experiment.sampleIds`
- `experiment.actions`
- `experiment.measurements`
- `experiment.observations`
- `experiment.notes`

例如，先在测试表建好对应文本字段，再按该表的精确字段名配置：

```dotenv
XIAOHUAN_BITABLE_FIELD_MAP_JSON={"captureId":"Capture ID","transcript":"Transcript","experiment.sampleIds":"Sample IDs","experiment.actions":"Actions","experiment.measurements":"Measurements","experiment.observations":"Observations","experiment.notes":"Notes"}
XIAOHUAN_BITABLE_JOIN_SEPARATOR=" | "
XIAOHUAN_BITABLE_MAX_FIELD_VALUE_BYTES=8192
```

字符串值是保留兼容的简写。需要把对象数组映射到单选或数字字段时，只能在对应
源路径使用以下精确选择器：

```json
{
  "captureId": "Capture ID",
  "experiment.actions": {
    "field": "设备仪器",
    "selector": "action-target",
    "name": "使用"
  },
  "experiment.measurements": {
    "field": "无水氯化铜（克）",
    "selector": "measurement-value",
    "name": "无水氯化铜",
    "unit": "克"
  }
}
```

`action-target` 按动作 `name` 精确匹配并保留唯一命中的非空 `target`；
`measurement-value` 按测量 `name` 和可选的 `unit` 精确匹配并保留唯一命中的
非 `null` `value`。省略 `unit` 时只按名称筛选。Bridge mapper 本身不做模糊匹配、
别名翻译、单位换算或“取第一项”；零匹配、多匹配、空 target、null value 或空数组
会从初步 `fields` 省略，但完整 transcript、experiment 和 `fieldMapping` 仍会进入
Bitable Worker，不再因一次结构化漏提取而丢弃整句话。

目标字段名必须唯一。`null` 会省略，字符串数组用固定分隔符连接，对象数组使用
规范 JSON。Worker 先读取实时 Field List，再只在 `fieldMapping` 声明的目标字段内
进行有证据的语义归一化：

- 已经合法的初步字段保持不变；
- transcript 中明确出现的字段标记和单一连续值可用于恢复漏提取文本，例如
  “批次测试四号”恢复为“测试四号”；
- ASR 同音/近音值只有在语境和实时 options 共同支持唯一候选时才能纠正，例如
  “列路测试”归一到唯一 live option“链路测试”；
- 数字和单位必须在 transcript 或 measurement 中明确出现，禁止默认、推算和换算；
- 多个候选合理、证据冲突或必要值无法定位时，在确认和写入之前停止并澄清。

归一化后的最终字段会原样显示在确认卡中，仍需原用户批准。运行时 Field List 或
类型校验失败就零写入。`XIAOHUAN_BITABLE_MAX_FIELD_VALUE_BYTES` 可设为 1–65536。

如需在本机完整收到一句语音后让小环尽早播报“收到”，增加：

```dotenv
XIAOHUAN_BITABLE_TTS_ACK_ENABLED=true
XIAOHUAN_BITABLE_TTS_BASE_URL=http://192.168.66.133:18082
XIAOHUAN_BITABLE_TTS_ACK_TEXT=收到
XIAOHUAN_BITABLE_TTS_TIMEOUT_MS=2000
```

TTS 地址只接受带显式端口、无账号密码的私有 IPv4 HTTP origin。VAD 完成切句、
WAV 写入并通过本地校验后，Bridge 在方舟处理完成前异步调用 `/api/tts/speak`，使用
`xiaohuan-received-<receiptKey>` 作为设备 `request_id`；receipt key 绑定本次运行和
capture ID，同一句重放可由设备去重。“收到”只表示本机已拿到完整音频，不表示转写、
确认或写表成功。HTTP 429、超时或无效响应只记录安全错误，不阻止后续链路。硬件播放
期间会暂停麦克风和 RTP，短句结束并等待约 200 ms 后自动恢复。

Bridge 对 Agent 入站实行单飞：第一条草稿处于 Agent processing 或 awaiting-confirmation
时，后续方舟结果先进入容量与 VAD `maxQueue` 相同的 FIFO 队列。Agent 正常结束但未产
确认卡时，短 settle 窗口后释放并处理下一句；已产卡时仍只有批准、拒绝、过期或失败
才能释放。可重试的 5xx、超时和限流会保留同一 fingerprint，使用不同 attempt message
ID 在 5 秒、30 秒后最多追加两次尝试。无关 turn/确认事件不会释放队列；15 分钟仅作为
processing/confirmation 的最终安全上限，任何超时都不被视为批准。关闭服务时取消退避
定时器且不再投递排队草稿。

OpenAI-compatible Agent provider 默认按 240000 字符的完整请求预算计算 transcript、
system instructions 和 tools。可用 `OPENAI_MAX_REQUEST_CONTEXT_CHARS` 调整；超限时先
摘要压缩再按剩余预算裁剪，固定 instructions/tools 本身超限时本地失败关闭。

最后填写现有方舟配置：

```dotenv
DOUBAO_ARK_API_KEY=<火山方舟 API Key>
DOUBAO_ARK_MODEL=doubao-seed-2-0-lite-260428
DOUBAO_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

其余 `XIAOHUAN_BITABLE_VAD_*`、队列、超时、归一化和 `DOUBAO_*` 限制见
`.env.example`。默认不保留 program-created WAV；只有排障且现场批准时才设置
`XIAOHUAN_BITABLE_KEEP_UTTERANCES=true` 和受控的
`XIAOHUAN_BITABLE_OUTPUT_DIR`。

## 启动

先完成 Bitable pilot 拓扑/Gateway 配置，并在单独终端启动真实或测试 Gateway。
例如本仓 pilot：

```bash
pnpm exec tsx examples/bitable-pilot/configure-topology.ts
node examples/bitable-pilot/start-gateway.mjs
```

再次确认 UDP 50020 无其他监听器，然后从仓库根目录启动。下面的源码开发命令先
自注册 Bridge，再启动 Host；`--env-file` 让 Bridge 配置在任何模块导入前进入
`process.env`：

```bash
lsof -nP -iUDP:50020
node \
  --env-file=examples/xiaohuan-bitable-bridge/.env \
  --import tsx \
  --input-type=module \
  --eval 'await import("./examples/xiaohuan-bitable-bridge/index.ts"); await import("./src/index.ts")'
```

如果 Host 的其他必需变量没有放在仓库根 `.env`，也要通过进程环境提供。启动
成功应出现：

- `xiaohuan_bitable_adapter_started`
- 音频服务 ready 日志
- Host 的 `Channel adapter started ... type=xiaohuan-bitable`

任何配置、SDP、FFmpeg 或端口错误都应视为 Bridge 未启动。修复后重启；不要另开
一个直连 Gateway/飞书的脚本作为回退。

Bridge 的部署包若要通过 `EXTENSIONS_DIR` 加载，必须先把 TypeScript 及其相对
依赖编译/打包，并确保 `manifest.json` 的 `entry: "./index.js"` 确实存在。本节的
repo-local 命令用于源码联调，不声称当前示例目录已经是可复制的独立 JS 发布包。

## 停止

在 Host 终端按一次 `Ctrl-C`。Host teardown 会：

1. 停止接受新的 VAD 输出；
2. 中止 FFmpeg/监听服务；
3. 排空已接受的有界模型工作和 Host 入站投递；
4. 按配置清理 program-created 临时 WAV。

等待 `xiaohuan_bitable_adapter_stopped` 和 Host 退出后检查：

```bash
lsof -nP -iUDP:50020
```

正常停止后，才可重新启动独立 `vad-service-cli.ts` 做 capture-only 诊断。若 Host
没有退出，先保留日志并确认具体 PID；不要同时启动第二个 Bridge。

## 隐私与安全

- 默认测试话术应为批准的非敏感内容；不要说真实患者、配方、商业秘密或个人信息。
- 每句音频会发往方舟；Bridge envelope 还包含完整 transcript 和结构化实验对象，
  并进入该规范用户的 Agent 会话。只有需要的测试人员应可访问该会话和测试表。
- Key、Authorization、音频 Base64、完整 prompt、完整 transcript 和原始模型响应
  不应进入普通日志或联调证据。不要把 `.env`、WAV、Host 数据目录或日志上传仓库。
- Bridge 外层 sender 标签不是身份。Host 的 `authenticatedUserId` 和既有身份链才是
  Gateway 授权、确认和审计依据。
- Create 始终需要原规范 P2P 用户的 Host-mediated confirmation。取消、拒绝、超时、
  不同用户确认或任一步骤失败都必须是零写入。

## 真实测试表联调

先用专用空表和测试逻辑资源，不要直接连接生产表。

1. 在 Gateway 配置逻辑资源到测试表的物理映射；物理 ID 和飞书凭证只留在
   Gateway 环境。
2. 确认 Gateway discovery 发布 Field List、单条 Create、Record Get；确认规范
   用户对该资源有 writer 权限。
3. 让 `XIAOHUAN_BITABLE_FIELD_MAP_JSON` 的目标名与实时 Field List 完全一致。
   select options 无需复制到 Bridge 配置，由 Worker 使用实时 Field List；当前数组
   编码通常应映射到文本字段。
4. 启动 Bridge，说一句批准的非敏感话术。预期一条有效方舟结果只形成一个
   `xiaohuan-bitable-bridge.v1` Create 草稿，资源和 mapping 目标固定；只允许在原始
   证据与实时 Field List 内做受控归一化。
5. 第一次在原用户确认面选择取消/拒绝。核对测试表无新记录，Gateway 无 Create
   执行审计；不要用聊天文字代替确认。
6. 再说一条测试话术，在原用户确认面批准。Create 使用
   `xiaohuan-bitable-create-<64 位小写 SHA-256>`；该指纹来自不可变的 capture、
   resource、transcript、experiment 和 fieldMapping。成功后必须以返回 Record ID
   调 Record Get。
7. 只记录最小安全证据：capture ID 的脱敏后缀、逻辑资源别名、Record ID、Get
   验证结果、Create/Get audit ID、确认结果和时间。不要记录完整 transcript、
   字段敏感值、凭证或物理表标识。
8. 用同一 envelope 做受控重放时，应复用相同 fingerprint/idempotency key，且
   不新增第二条记录；如同一来源重试得到不同归一化字段，Gateway 应报告幂等输入
   冲突，而不是静默覆盖或换键重试。

完成后按“停止”章节退出，删除不再需要的本地 WAV/排障日志，并撤下测试资源的临时
writer 授权。

## 验证

不绑定 UDP 的静态/结构检查：

```bash
pnpm exec tsc -p examples/xiaohuan-bitable-bridge/tsconfig.json
pnpm exec tsx examples/xiaohuan-bitable-bridge/index.selftest.ts
```

专项模拟测试应在真实音频前运行；它们不得要求飞书凭证或真实写表。
