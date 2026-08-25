# AgentDesk `Created` 容器残留问题：调查结论与修复对接文档

> 日期：2026-07-31  
> 状态：根因已确认，修复方案待 AgentDesk 核心维护方评审  
> 受众：AgentDesk 容器运行时、Host Sweep、可靠性与运维负责人  
> 范围：只讨论 AgentDesk Host 对 Docker Agent 容器的生命周期管理；语音、图片、JSON、Bitable 等业务 Agent 仅作为触发场景

## 1. 对接摘要

当前安装中发现 14 个长期停留在 Docker `Created` 状态的 Agent 容器。详细排查确认：

1. **直接根因在 AgentDesk 核心容器生命周期管理。**
2. 语音、图片、JSON、Bitable Worker 因并发唤醒和会话创建频率较高，更容易触发问题，但不是根因。
3. 没有发现业务 Agent 主动停止 Docker 容器。
4. 镜像损坏、Docker daemon 故障、公共启动参数错误和网络错误基本可以排除。
5. 已确认两条产生残留的路径：
   - 新容器在 Docker `create` 阶段被旧 `processing_ack` 触发的 SLA 清理误杀；
   - Host 在 Docker `create` 与 `start` 之间异常退出。
6. 当前启动清理只查询 `docker ps`，看不到 `Created` 容器，因此这些残留不会被自动回收。
7. 已检查的业务消息后来均通过下一轮 sweep 成功完成，暂未发现数据丢失；已知影响是首次处理延迟、重复启动尝试、容器残留和运行状态失真。

建议由 AgentDesk 核心维护方优先完成三个 P0 修复：

- 引入真实的 `starting → running → stopping` Host 内部状态机；
- 新容器完成启动握手前，不执行旧 claim 的运行中 SLA 清理；
- Host 启动时用安装标签查询 `docker ps -a`，回收本安装遗留的 `Created` 容器。

## 2. 现象与影响

### 2.1 Docker 侧现象

残留容器的共同特征：

- Docker 状态为 `Created`；
- `StartedAt` 和 `FinishedAt` 都是零值；
- `ExitCode=0`，但这不代表成功运行，只表示容器进程从未启动；
- 没有 runner 业务日志；
- Docker 容器状态中没有镜像、挂载、网络或启动参数错误；
- 容器创建后长期不被 Host 清理。

`Created` 的含义不是“启动后正常退出”，而是：

```text
docker create 已完成
docker start 未发生
容器内 Agent runner 从未执行
```

### 2.2 当前数量与分布

共发现 14 个残留：

| 分类 | 数量 | 说明 |
|---|---:|---|
| 当前 AgentDesk 安装的业务容器 | 12 | 可由 Docker 事件、会话 DB 和启动时间关联 |
| E2E 临时环境容器 | 2 | 名称为 `worker-e2e`，不属于当前业务拓扑 |

12 个业务残留中，8 个属于语音、图片、JSON 或 Bitable 相关 Worker；其余涉及：

- Frontdesk；
- Windows GUI Worker；
- 普通 Bitable Worker。

Frontdesk 和 Windows GUI Worker 同样出现残留，说明问题不属于某个特定业务 Agent。

### 2.3 业务影响

目前确认的影响：

- 首次恢复处理可能失败并延迟到下一轮 sweep；
- 同一条消息可能多经历一次容器启动尝试；
- Docker 中持续积累无用 `Created` 容器；
- Host/DB 可能短暂显示 `running`，实际 Docker 容器尚未运行；
- 并发场景下会增加 Docker create 请求、Host 调度和排障噪声；
- Host 没有持久化日志时，异常退出原因无法事后精确追溯。

暂未发现：

- 已持久化消息丢失；
- 业务 Agent 主动执行 `docker stop`；
- 容器镜像无法创建；
- Docker daemon 无法服务；
- 同一公共运行参数下所有 Worker 均启动失败。

## 3. 责任边界

| 环节 | 判断 | 理由 |
|---|---|---|
| Docker 创建后未启动、残留 `Created` | AgentDesk 核心缺陷 | Host 过早标记 `running`，并在启动未完成时执行清理 |
| 语音/图片/JSON/写表产生大量并发会话与唤醒 | 触发者、放大器 | 提高竞态命中概率，但不负责 Docker 生命周期 |
| Voice/Photo launcher 与 Host 同进程 | 次级触发条件 | 组合进程重启会同时终止 Host，扩大 create/start 中断窗口 |
| 业务 Agent 主动停止容器 | 未发现 | 未找到对应业务逻辑或 Docker 事件证据 |
| 镜像损坏或公共参数错误 | 基本排除 | 同镜像、同公共参数的并行容器可以正常 `create → attach → start` |
| 启动后残留自动清理 | AgentDesk 核心缺口 | 当前只使用 `docker ps`，不会返回 `Created` 容器 |

一句话责任界定：

> 业务 Agent 提高了并发和重启频率，但 AgentDesk 核心必须保证在任何合法并发和 Host 重启条件下，容器状态不会被误判，也不会永久留下 `Created` 残留。

## 4. 根因一：旧 claim 触发“刚创建就清理”竞态

这是主要的生命周期竞态。

### 4.1 正常设计意图

Agent runner 认领消息后，会在 session 的 `outbound.db` 中写入：

```text
processing_ack.status = 'processing'
```

如果旧 runner 异常退出，这条记录可能遗留。新的 runner 启动后会清理旧 claim，再继续处理消息。

`host-sweep.ts` 也会检查运行中容器的 claim 是否超时，用来终止真正卡死的 runner。

两个机制单独看都合理，问题发生在“Host 何时认为新容器已经运行”。

### 4.2 实际错误时序

当前代码在 `src/container-runner.ts:316-319`：

1. 调用 Node `spawn()` 启动 `docker run --rm ...` CLI；
2. `spawn()` 返回后立即写入 `activeContainers`；
3. 立即调用 `markContainerRunning(session.id)`。

但 Node `spawn()` 成功只说明本地 Docker CLI 进程创建成功，并不表示 Docker daemon 已经完成容器 `start`。此时容器可能仍处于：

```text
not found → creating → created
```

同一轮 sweep 在 `src/host-sweep.ts:398-410` 中继续执行：

1. 发现到期消息，调用 `wakeContainer()`；
2. `wakeContainer()` 返回后，通过 `activeContainers.has()` 判断 `alive=true`；
3. 立即执行 `enforceRunningContainerSla()`；
4. SLA 读到旧 runner 遗留的 `processing_ack(status='processing')`；
5. 新 runner 尚未真正启动，因此还没机会清理旧 claim；
6. Host 将新容器误判为 claim-stuck，并调用 `killContainer()`。

`killContainer()` 在 `src/container-runner.ts:365-376` 中：

1. 先执行 `docker stop <containerName>`；
2. 此时 Docker create 可能尚未完成，`docker stop` 找不到目标或不能停止；
3. catch 分支对本地 `docker run` CLI 发送 `SIGKILL`；
4. Docker daemon 已经收到 create 请求，仍可能独立完成 create；
5. CLI 已死亡，不会继续推动 attach/start；
6. 最终留下永久 `Created` 容器。

完整时序：

```text
Host                         docker CLI                   Docker daemon
 |                              |                              |
 | spawn("docker run")          |                              |
 |----------------------------->|                              |
 |                              | create request               |
 |                              |----------------------------->|
 | 标记 session=running         |                              | creating
 | 读取旧 processing_ack        |                              |
 | 判定 claim-stuck             |                              |
 | docker stop <name>           |                              |
 |------------------------------------------------------------>| 尚未可停止
 | stop 失败                    |                              |
 | SIGKILL docker CLI           |                              |
 |----------------------------->X                              |
 |                                                             | create 完成
 |                                                             | 没有 start
 |                                                             | 状态=Created
```

### 4.3 证据

Docker 事件显示，在同一批并发启动中：

- 多个 Voice JSON 容器几乎同时收到 create 和 stop；
- stop 发生在 create 完成之前；
- 之后没有 attach/start；
- 与它们并行的 Bitable 容器正常完成 `create → attach → start`。

会话数据库与该时序吻合：

- Frontdesk 残留消息为 `tries=1`，`process_after` 比容器创建时间晚约 5 秒；
- Windows GUI Worker 同样为一次重试并延后约 5 秒；
- 多个 Voice Worker 也只出现一次恢复重试；
- 相关消息随后均成功完成。

这说明首次唤醒被误杀，消息依靠 SQLite 持久化和下一轮 sweep 恢复，没有直接丢失。

## 5. 根因二：Host 在 create 与 start 之间异常退出

另一类残留的 Docker 事件只有：

```text
containers/create
```

没有：

```text
attach
start
stop
die
```

约 53～57 秒后出现新的 Host 启动查询：

```text
GET /info
GET /containers/json?...agentdesk-install...
```

`data/circuit-breaker.json` 也留下了未正常关闭的启动记录。

可以确认：

1. Docker daemon 成功接收并完成 create；
2. 负责继续执行 start 的 Host/docker CLI 非正常消失；
3. Host 随后被重新启动；
4. 新 Host 的 `cleanupOrphans()` 没有看到 `Created` 容器，因此没有回收。

由于 Host 没有持久化日志，目前不能继续区分具体退出来源：

- 开发终端或自动任务超时；
- 外部 `SIGKILL`；
- 关闭期限触发强制 `process.exit()`；
- 人工重启开发进程；
- Voice/Photo launcher 组合进程整体重启。

无论退出来源是什么，Host 重启后都应能识别并回收未启动残留，因此异常退出是触发条件，不是残留永久存在的充分理由。

## 6. 为什么当前启动清理无效

`src/container-runtime.ts:95-118` 的 `cleanupOrphans()` 当前执行：

```text
docker ps --filter label=<install-label>
```

`docker ps` 默认只返回正在运行的容器，不返回：

- `Created`；
- `Exited`；
- 其他停止状态。

因此：

```text
Host 重启
  → cleanupOrphans()
  → docker ps 看不到 Created
  → Created 永远残留
```

安装标签的隔离设计本身是正确的。修复时应保留 `<namespace>-install=<slug>` 范围约束，只把查询扩展到 `docker ps -a`，并按状态采取不同操作。

## 7. 建议修复方案

### 7.1 P0：建立真实的 Host 内部生命周期状态机

不要再用 `activeContainers.has(sessionId)` 同时表达“正在启动”和“已经运行”。

建议内部结构：

```ts
type ContainerPhase = 'starting' | 'running' | 'stopping';

type ActiveContainer = {
  process: ChildProcess;
  containerName: string;
  agentGroupId: string;
  phase: ContainerPhase;
  generation: number;
  spawnStartedAt: number;
  dockerStartedAt?: number;
};
```

需要区分两个判断：

```text
isContainerActive(sessionId)
  用于防止重复 wake、计算并发上限和执行关闭
  starting/running/stopping 都返回 true

isContainerReady(sessionId)
  仅用于运行中 SLA
  只有确认 Docker State.Running=true 后返回 true
```

最小改法可以继续使用 `docker run`：

1. Node `spawn()` 后登记 `phase='starting'`；
2. 不调用 `markContainerRunning()`；
3. 在有界启动超时内轮询 `docker inspect`；
4. 确认目标容器存在且 `.State.Running=true`；
5. 校验 map 中仍是同一 generation，防止旧异步结果覆盖新启动；
6. 切换为 `phase='running'`；
7. 此时才调用 `markContainerRunning()`；
8. 超时、CLI close 或 inspect 异常时进入统一清理。

更彻底的方案是将 `docker run` 拆成显式 create/start，但改动面更大，需要重新审视 `--rm`、attach、日志、关闭和退出码语义。建议先采用“保留 docker run + inspect/ready 确认”的低风险修复。

中央 DB 的 `container_status` 可以暂时维持现有公共语义：

- starting 阶段仍保持 `stopped`；
- 真正运行后才写 `running`；
- close/error 后写 `stopped`。

如果要把 `starting` 持久化为新的公共状态值，这是 runtime contract 变更，需要同步 ADR、相关文档和所有消费方。

### 7.2 P0：新启动期间禁止旧 claim SLA 清理

仅增加 `starting` 状态还不完全够。容器即使刚切到 Docker running，runner 也可能尚未完成数据库初始化和旧 claim 清理。

建议至少实现以下两层保护：

### 第一层：同一轮 sweep 不做 SLA

`sweepSession()` 记录本轮是否成功触发了 wake：

```text
wokeThisSweep=true
```

本轮后续跳过 `enforceRunningContainerSla()`，避免：

```text
wake → 立即 SLA → runner 尚未初始化
```

### 第二层：等待 runner ready 信号

推荐把 SLA 生效条件从“Docker 已 running”进一步收紧为：

```text
Docker running
并且
runner 已写入首个 heartbeat/ready 标记
```

在 ready 前：

- 防止重复 wake；
- 计入并发上限；
- 允许优雅关闭；
- 不检查旧 claim stuck；
- 只应用一个独立、有界的“启动超时”。

启动超时与消息处理 SLA 应是两个不同概念：

| 超时 | 起点 | 目的 |
|---|---|---|
| container startup timeout | Node spawn/create 开始 | 防 Docker create/start 或 runner boot 永久卡住 |
| processing claim SLA | runner ready 后 | 防真正的业务消息处理卡死 |

### 7.3 P0：启动时清理本安装的 `Created` 残留

将启动扫描扩展为：

```text
docker ps -a \
  --filter label=<CONTAINER_INSTALL_LABEL> \
  --format ...
```

按状态处理：

| Docker 状态 | 建议动作 |
|---|---|
| running/restarting | 保持现有 stop 流程 |
| created | 执行 `docker rm`，必要时回退 `docker rm -f` |
| exited/dead | 执行 `docker rm` |
| removing | 记录并跳过，下一轮复查 |

安全要求：

- 必须保留安装 label 过滤；
- 不允许按宽泛名称前缀清理；
- 日志记录 container name、status、install label 和清理结果；
- 单个容器清理失败不能阻止 Host 启动；
- 所有命令必须有超时；
- 对清理数量增加指标和告警，避免静默积累。

还应在 `killContainer()` 的 starting 分支中处理同类窗口：

1. 将 phase 切为 stopping；
2. 终止/取消对应 CLI；
3. 在有界时间内查询同名容器；
4. 如果状态为 created，执行 remove，而不是只执行 stop；
5. generation 校验防止误清理同 session 的后续新容器。

### 7.4 P1：补充启动与异常退出的可观测性

建议增加：

### 结构化日志

- `container_spawn_requested`
- `container_created_observed`
- `container_running_observed`
- `runner_ready_observed`
- `container_start_timeout`
- `container_created_orphan_removed`
- `host_shutdown_started/completed/forced`

共同字段：

```text
session_id
agent_group_id
container_name
generation
phase
elapsed_ms
install_label
reason
```

### 指标

- `container_starting` gauge；
- `container_start_duration_seconds` histogram；
- `container_start_failures_total{phase,reason}`；
- `container_created_orphans_total{source=startup|kill}`；
- `container_created_orphan_cleanup_failures_total`；
- `host_forced_shutdown_total{reason}`。

### 持久化日志

当前仅凭 Docker 事件无法区分终端超时、SIGKILL、关闭期限和人工重启。生产/联调环境应通过 launchd/systemd 或日志采集器保留 Host stdout/stderr。

### 7.5 P1：拆分 Voice/Photo monitor 与 AgentDesk Host

当前 `examples/voice-photos-feishu-monitor/launcher.ts` 通过同一进程同时 import：

```ts
import './index.js';
import '../../src/index.js';
```

这意味着：

- 监控服务重启会带着 AgentDesk Host 一起退出；
- Host 重启也会中断语音、图片、JSON monitor；
- 任一模块的 uncaught exception 可能终止整个组合进程；
- 更容易在 Docker create/start 窗口中断 Host。

建议最终拆成两个独立受控进程：

```text
agentdesk-host
voice-photos-monitor
```

分别由 launchd/systemd/supervisor 管理，设置独立的：

- restart policy；
- 健康检查；
- 日志；
- shutdown deadline；
- 资源限制。

这不是 P0 核心修复的替代品。即使拆分，核心生命周期也必须能够抵御 Host crash。

## 8. 建议测试矩阵

修复必须包含可稳定复现竞态的自动化测试，不能依赖真实机器上的偶发现象。

### 8.1 单元测试

1. `spawn()` 返回后 phase 为 starting，DB 不得写 running。
2. starting 计入并发上限并阻止同 session 重复 wake。
3. starting 不进入 processing claim SLA。
4. Docker inspect 确认 running 后才切换 phase 和 DB 状态。
5. close/error 发生在 inspect 回调之前时，旧回调不得把 session 重新标记为 running。
6. kill starting 容器时，stop 找不到目标后仍会查询并删除后续出现的 created 容器。
7. 启动清理只处理匹配当前 install label 的容器。

### 8.2 可控 fake runtime 集成测试

构造一个 fake Docker CLI/daemon，允许人为控制：

```text
create 延迟
start 延迟
stop 在 create 前返回 not found
CLI 被 SIGKILL 后 daemon 继续完成 create
```

核心复现用例：

1. outbound.db 预置旧 `processing_ack='processing'`；
2. 有一条 due message；
3. fake runtime 延迟 create/start；
4. 执行一次完整 sweep；
5. 断言新容器不会在同一轮被 claim SLA 清理；
6. runner ready 后旧 claim 被清理；
7. 消息最终只完成一次。

### 8.3 Host crash 恢复测试

1. 启动 Host；
2. 让 fake/real Docker 完成 create，但阻塞 start；
3. 强制终止 Host；
4. 确认存在 matching-label Created 容器；
5. 重启 Host；
6. 断言启动扫描删除该容器；
7. 断言消息仍在 SQLite 中并可重新处理；
8. 断言不会清理另一个 install label 的容器。

### 8.4 并发回归测试

至少覆盖：

- Frontdesk + 多个 Bitable Worker 并发唤醒；
- Voice/Photo/JSON 批量并发；
- 同一 session 的重复 wake；
- 达到 `MAX_CONCURRENT_CONTAINERS` 上限；
- graceful shutdown 时同时存在 starting 和 running；
- OneCLI 暂时不可达；
- runner 在 ready 前退出；
- runner ready 后 claim 真正超时。

## 9. 验收标准

修复完成需同时满足：

1. Node `spawn()` 成功后，session 不会立即被标记为 running。
2. `isContainerRunning` 不再仅等价于 `activeContainers.has()`。
3. 新容器在 ready 前不会接受 processing claim SLA。
4. 同 session 在 starting 期间不会启动第二个容器。
5. Host 在 create/start 任意位置退出，重启后都能清理 matching-label Created 残留。
6. 启动清理不能触碰其他 checkout、其他品牌 namespace 或其他 install label 的容器。
7. kill/startup timeout 能回收 created/running/exited 状态，不只会 stop running。
8. 消息 persist-before-route 与重试语义保持不变，不引入丢消息。
9. 宿主优雅关闭能处理 starting 和 running 两类条目。
10. 并发上限仍覆盖 starting + running，不能因状态拆分绕过容量保护。
11. 新增测试可在 CI 中稳定复现旧实现失败、修复后通过。
12. 连续压力运行后，当前 install label 下 `Created` 残留为 0。

## 10. 发布与回滚建议

### 发布前

- 备份中央 `data/v2.db` 和所有 session DB；
- 记录当前 matching-label 容器清单；
- 在 staging 使用 fake runtime 和真实 Docker 各跑一轮；
- 验证旧 Created 容器的 dry-run 列表；
- 确认 E2E 容器与业务 install label 的边界。

### 灰度

1. 先上线状态机和 sweep 保护；
2. 观察 container start latency、启动失败和 claim retry；
3. 再开启 startup orphan cleanup；
4. 最后拆分 launcher 进程。

### 回滚

- 保留原有消息 DB 与重试逻辑；
- 状态机改动应能单独回滚，不依赖 DB schema migration；
- orphan cleanup 必须是幂等、label-scoped；
- 如果新增持久化 `starting` 状态，需要先定义旧版本如何解释该值。

## 11. 需要核心维护方确认的问题

对接会议建议逐项确认：

1. 是否接受 Host 内部 `starting/running/stopping` 状态机？
2. P0 采用“保留 docker run + inspect ready”，还是重构为显式 create/start？
3. runner ready 以首个 heartbeat、container_state，还是新增专门标记为准？
4. 容器启动超时建议是多少，是否允许 per-agent-group 配置？
5. 同一轮 wake 后完全跳过 SLA，是否会影响 recurrence 或其他 sweep hook？
6. `killContainer()` 遇到 starting 时，统一 `rm -f` 的安全边界如何实现？
7. startup cleanup 是否同时回收 exited/dead，还是第一版只处理 created？
8. `container_status` 是否需要对外暴露 starting？若需要，哪些 UI、脚本和文档依赖旧枚举？
9. Host 强制退出的来源如何持久化记录？
10. Voice/Photo launcher 拆进程由核心仓负责，还是由部署侧负责？
11. 现有 14 个残留何时清理，由谁确认 install label 和业务影响？

## 12. 建议的工作拆分

| 工作项 | 建议负责人 | 优先级 |
|---|---|---|
| Host 内部生命周期状态机 | AgentDesk container runtime 维护者 | P0 |
| sweep 新启动保护与 runner-ready 门槛 | Host sweep 维护者 | P0 |
| `docker ps -a` label-scoped orphan cleanup | container runtime 维护者 | P0 |
| fake runtime 与 crash 恢复测试 | 核心测试/可靠性负责人 | P0 |
| 生命周期指标与结构化日志 | 可观测性负责人 | P1 |
| Host 持久化日志/进程托管 | 部署运维负责人 | P1 |
| Voice/Photo launcher 进程拆分 | 业务 Agent + 部署负责人 | P1 |

## 13. 相关代码位置

行号基于 2026-07-31 当前工作树，后续修改可能漂移：

- `src/container-runner.ts:70`：`activeContainers` 当前没有生命周期 phase；
- `src/container-runner.ts:134-135`：`isContainerRunning()` 仅检查 map 是否存在；
- `src/container-runner.ts:316-319`：spawn 后立即登记 active 并标记 running；
- `src/container-runner.ts:365-376`：stop 失败后 SIGKILL docker CLI；
- `src/container-runner.ts:833`：当前使用 `docker run --rm`；
- `src/host-sweep.ts:398-410`：wake 后同一轮立即执行 running SLA；
- `src/container-runtime.ts:95-118`：启动清理只查询 `docker ps`；
- `examples/voice-photos-feishu-monitor/launcher.ts:1-2`：monitor 与 Host 同进程加载；
- `container/agent-runner/src/db/connection.ts`：runner 启动时清理旧 processing claim。

## 14. 对外沟通用简短表述

> AgentDesk 当前存在一个核心容器启动竞态：Host 在启动 Docker CLI 后、容器真正 running 前就把 session 标记为 running，同一轮巡检可能用旧 runner 遗留的 processing claim 将新容器误判为卡死。若 stop 发生在 Docker create 完成前，Host 会杀掉 docker CLI，而 Docker daemon 仍完成 create，最终留下从未 start 的 `Created` 容器。Host 若在 create/start 之间异常退出也会产生同类残留；现有启动清理只查 `docker ps`，因此无法回收。语音、图片和写表 Worker 因高并发更容易触发，但核心生命周期管理才是根因。建议优先引入 starting/running 状态机、新启动 SLA 保护和 label-scoped `docker ps -a` 清理，并补充 crash 恢复与并发回归测试。
