# 小环整句语音 → 方舟 JSON → 飞书多维表格 Bridge（macOS）

这个 operator-specific 示例在 macOS 接收小环硬件上传的完整 WAV，交给方舟单阶段
多模态接口生成 transcript 和 `experiment-audio.v1`，再以固定规范用户和固定飞书
P2P 路由送入 AgentDesk Host。Agent 只按 Bridge 已映射的字段草稿，通过 Backend
Gateway 发现、校验、授权、向原用户确认、创建并按 Record ID 读回验证。

硬件负责“你好小环”唤醒、说话起止检测、拍照指令分流和本地提示音。本机不再接收
RTP/Opus、不运行 FFmpeg/VAD，也不调用设备 TTS 播报“收到”。

Bridge 默认关闭。它不持有飞书/Bitable 凭证，不接受 `app_token`、`table_id` 或
tenant token，不直接调用飞书 API 或 Gateway `/execute`。

## 接收协议

当前硬件约定：

```text
Mac 地址: 192.168.66.113
协议: HTTP/1.1
端口: 50020/TCP
方法: POST
路径: /api/audio
Content-Type: audio/wav
Body: 完整 WAV 原始字节
```

WAV 必须是 PCM signed 16-bit little-endian、16000 Hz、单声道、非空；请求体最大
4 MiB，时长上限由 Bridge 和方舟共同配置，现场建议 61000 ms。

Bridge 只有在完整 body 通过校验并以临时文件、fsync、原子 rename 落盘后才返回
HTTP 202。方舟在后台有界串行处理，不阻塞硬件恢复下一次唤醒。完整 WAV 的
SHA-256 用于派生稳定 capture ID；硬件因响应丢失重试完全相同的字节时返回
`duplicate: true`，不会创建第二个方舟、Agent 或写表意图。队列满时返回 503 和
`Retry-After: 1`，由硬件执行自己的有界重试。

健康检查：

```bash
curl -sS http://127.0.0.1:50020/healthz
curl -sS http://192.168.66.113:50020/healthz
```

## 前置条件

- macOS 与小环在可信、可互通的实验室局域网。
- Node.js、pnpm 和本仓依赖已安装；生产 Bridge 不再需要 FFmpeg/ffprobe。
- AgentDesk Feishu P2P 路由已经存在；规范用户就是该 P2P 用户。
- Frontdesk/Worker 已采用本 change 中的 Bridge envelope 和证据约束归一化规则。
- Gateway 已发布 `feishu.bitable.field.list`、`feishu.bitable.record.create` 和
  `feishu.bitable.record.get`，逻辑资源映射到专用测试表。
- 小环硬件发送目标已设为 `http://192.168.66.113:50020/api/audio`。

当前 HTTP 协议没有令牌认证，只能用于可信局域网，不得映射到公网。网络来源不能替代
Host 中 operator 配置的规范用户身份。

## TCP 50020 互斥

Bridge 与硬件同事提供的 `xiaohuan_audio_receiver.py` 都会绑定 TCP 50020，不能同时
运行。切换前先停止 Python 参考接收器，并检查：

```bash
lsof -nP -iTCP:50020 -sTCP:LISTEN
```

旧 `realtime-cli.ts`、`vad-service-cli.ts` 使用 UDP 50020，已不是当前硬件生产链路。
为避免误判，联调期间也应停止它们：

```bash
lsof -nP -iUDP:50020
```

若端口被占用，先确认明确 PID 和命令，再发送 `TERM`；不要用模糊名称批量杀进程：

```bash
ps -p <PID> -o pid,ppid,command
kill -TERM <PID>
```

## 配置

复制模板到被 Git 忽略的 `.env`：

```bash
cp examples/xiaohuan-bitable-bridge/.env.example \
  examples/xiaohuan-bitable-bridge/.env
chmod 600 examples/xiaohuan-bitable-bridge/.env
```

三道开关必须精确为 `true`：

```dotenv
XIAOHUAN_BITABLE_BRIDGE_ENABLED=true
XIAOHUAN_BITABLE_ALLOW_EXTERNAL_UPLOAD=true
XIAOHUAN_BITABLE_ALLOW_AGENT_DELIVERY=true
```

它们分别表示启用 Bridge、同意把硬件触发的完整语句上传方舟、同意把结构化草稿送入
Agent/确认链。Bridge 不再持续采集环境音。

填写固定部署绑定：

```dotenv
XIAOHUAN_BITABLE_AUTHENTICATED_USER_ID=<Host 中已有的规范用户 ID>
XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID=feishu:p2p:ou_<该用户 open_id>
XIAOHUAN_BITABLE_FEISHU_TRANSCRIPT_MIRROR_ENABLED=true
XIAOHUAN_BITABLE_RESOURCE=<Gateway 中批准的测试表逻辑别名>
```

`XIAOHUAN_BITABLE_RESOURCE` 只能是 Gateway 逻辑别名；形似物理 `bas...`/`tbl...`
的值会被拒绝。用户、P2P 路由和资源不能从音频、transcript、设备地址或模型输出覆盖。

HTTP 接收配置：

```dotenv
XIAOHUAN_BITABLE_HTTP_BIND=0.0.0.0
XIAOHUAN_BITABLE_HTTP_PORT=50020
XIAOHUAN_BITABLE_HTTP_MAX_BODY_BYTES=4194304
XIAOHUAN_BITABLE_HTTP_MAX_DURATION_MS=61000
XIAOHUAN_BITABLE_HTTP_MAX_QUEUE=8
XIAOHUAN_BITABLE_HTTP_REQUEST_TIMEOUT_MS=10000
XIAOHUAN_BITABLE_KEEP_UTTERANCES=false
# XIAOHUAN_BITABLE_HTTP_OUTPUT_DIR=/private/tmp/xiaohuan-bitable
```

默认由程序创建临时目录，方舟处理结束后删除 WAV。只有排障且现场明确批准时才设置
`KEEP_UTTERANCES=true` 和受控输出目录。`HTTP_MAX_DURATION_MS` 不能超过
`DOUBAO_WAV_MAX_DURATION_MS`，`HTTP_MAX_BODY_BYTES` 不能超过 4 MiB。

字段映射是 `experiment-audio.v1` 源路径到真实表字段名的 JSON。支持：

- `captureId`
- `transcript`
- `experiment.title`
- `experiment.sampleIds`
- `experiment.actions`
- `experiment.measurements`
- `experiment.observations`
- `experiment.notes`

例如：

```dotenv
XIAOHUAN_BITABLE_FIELD_MAP_JSON={"transcript":{"field":"批次","selector":"text-after-marker","markers":["批次"]},"experiment.actions":{"field":"设备仪器","selector":"action-target","name":"使用"},"experiment.measurements":{"field":"无水氯化铜（克）","selector":"measurement-value","name":"无水氯化铜","unit":"克"}}
XIAOHUAN_BITABLE_JOIN_SEPARATOR=" | "
XIAOHUAN_BITABLE_MAX_FIELD_VALUE_BYTES=8192
```

Bridge mapper 不做模糊匹配、别名翻译、单位换算或“取第一项”。未解析的候选字段会
省略，但完整 transcript、experiment 和锁定的 `fieldMapping` 仍进入 Worker。Worker
必须先读取实时 Field List，只能在映射目标和明确语音证据内纠正常见同音/近音：

- 已合法的初步字段保持不变；
- 单选纠正结果必须逐字来自实时 options，且只能有一个合理候选；
- 数字和单位必须在 transcript 或 measurement 中明确出现；
- 多候选、证据冲突或必要值缺失时，在确认和写入前停止并澄清。

`text-after-marker` 只能配置在 `transcript` 上，`markers` 为 1–8 个唯一精确标记。
它读取 marker 后到下一个中英文句读符或 transcript 末尾的单个非空短语。例如
`批次测试十号，使用链路测试` 只生成 `批次: "测试十号"`。marker 零命中或多命中时
候选字段省略，不选择第一项，也不会从其他位置猜测批次。

最后配置方舟；硬件最长 60 秒时，两侧时长上限都设为 61000 ms：

```dotenv
DOUBAO_ARK_API_KEY=<火山方舟 API Key>
DOUBAO_ARK_MODEL=doubao-seed-2-0-lite-260428
DOUBAO_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_REQUEST_TIMEOUT_MS=120000
DOUBAO_WAV_MAX_BYTES=4194304
DOUBAO_WAV_MAX_DURATION_MS=61000
```

## 启动

先启动真实或测试 Gateway，再确认 TCP 50020 空闲：

```bash
lsof -nP -iTCP:50020 -sTCP:LISTEN
node \
  --env-file=examples/xiaohuan-doubao-audio/.env \
  --env-file=examples/xiaohuan-bitable-bridge/.env \
  --import tsx \
  --input-type=module \
  --eval 'await import("./examples/xiaohuan-bitable-bridge/index.ts"); await import("./src/index.ts")'
```

启动成功应出现：

- `xiaohuan_http_audio_service_started`
- `xiaohuan_bitable_adapter_started`
- Host 的 `Channel adapter started ... type=xiaohuan-bitable`

另一个终端执行：

```bash
curl -sS http://127.0.0.1:50020/healthz
```

任何配置、绑定或端口错误都表示音频入口未启动。不要另开直连 Gateway/飞书脚本回退。

## 不调用 TTS

Bridge 已删除 `XIAOHUAN_BITABLE_TTS_*` 配置和 `/api/tts/speak` 客户端。硬件自行负责
唤醒后的“我在”、普通语句结束提示和拍照提示。HTTP 202、方舟结果、确认卡或写表结果
都不会触发本机向设备播报。

## 停止

在 Host 终端按一次 `Ctrl-C`。teardown 会：

1. 关闭 TCP listener，不再接受新请求；
2. 排空已经返回 202 的有界方舟工作；
3. 排空已开始的 Host 入站投递；
4. 按配置清理 program-created WAV。

退出后检查：

```bash
lsof -nP -iTCP:50020 -sTCP:LISTEN
```

## 手工 HTTP 冒烟测试

使用符合格式且已获授权的非敏感测试 WAV：

```bash
curl -sS -X POST http://127.0.0.1:50020/api/audio \
  -H 'Content-Type: audio/wav' \
  --data-binary @test.wav
```

预期立即得到 202 JSON，随后日志出现方舟阶段和 Bridge draft。重复发送同一文件应返回
`duplicate: true`，且不产生第二个 Agent turn。

## 真实链路验收

1. 使用专用空表和测试逻辑资源，确认规范用户有 writer 权限。
2. 确认 `FIELD_MAP_JSON` 的目标名与实时 Field List 完全一致。
3. 启动 Bridge 并检查 `/healthz`。
4. 对硬件说“你好小环”，等硬件回应后读一条非敏感实验句。
5. 硬件应自行播放提示并向 Mac POST 一段完整 WAV；本机不应调用设备 TTS。
6. 日志应只有一个稳定 `captureId`，并生成一个 `xiaohuan-bitable-bridge.v1` 草稿。
7. 第一次在原用户确认面取消，核对测试表零新增。
8. 再说一条并批准，核对 Create record ID、Record Get 结果及 Create/Get audit ID。
9. 只保存 capture ID 脱敏后缀、逻辑资源、状态、record ID、audit ID 和时间；不要保存
   音频、完整 transcript、敏感字段、凭证或物理表标识。

## 隐私与安全

- 每个被硬件判定为普通语句的 WAV 会上传方舟；Bridge envelope 包含完整 transcript。
- HTTP 入口无鉴权，只能绑定可信 LAN，不得转发公网。
- Key、Authorization、音频 Base64、完整 prompt/transcript 和原始模型响应不得进入
  普通日志或联调证据；不要提交 `.env`、WAV、Host 数据目录或现场日志。
- Create 始终需要原规范 P2P 用户的 Host-mediated confirmation；硬件提示和 HTTP 202
  都不表示用户批准或写表成功。
- Bridge 的 sender 标签和设备 IP 都不是身份。Gateway 授权只认 Host 可信身份链。

## 验证

```bash
pnpm exec tsc -p examples/xiaohuan-bitable-bridge/tsconfig.json
pnpm exec tsx examples/xiaohuan-bitable-bridge/index.selftest.ts
pnpm exec vitest run \
  scripts/xiaohuan-whole-utterance-http.test.ts \
  scripts/xiaohuan-bitable-bridge-config.test.ts \
  scripts/xiaohuan-bitable-bridge-adapter.test.ts \
  scripts/xiaohuan-bitable-bridge-workflow.test.ts
openspec validate connect-xiaohuan-experiment-json-to-bitable --strict
```
