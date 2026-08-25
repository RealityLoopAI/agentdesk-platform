# AgentDesk 飞书长连接断连诊断与持续监测方案

> 更新时间：2026-08-06（Asia/Shanghai）  
> 适用目录：`/Users/realityloop/agentdesk/agentdesk-platform`

## 1. 当前结论

目前最可能的原因是 **macOS 主网络路径发生切换，或本机 VPN/代理的 TUN 路由被重建**，导致飞书 WebSocket 长连接断开并重新建连。

现有证据不支持以下两项是主要原因：

- AgentDesk Host 进程崩溃或重启；
- SMB 图片扫描阻塞 Node.js 事件循环。

这一结论的置信度较高，但仍需等待下一次断连时捕获代理、路由和 WebSocket 错误的完整同期快照，才能最终锁定是代理客户端、VPN/TUN 路由、Wi-Fi 主接口切换，还是飞书上游短暂异常。

## 2. 已确认的事件时间线

### 2.1 2026-08-05 晚间长断连

| 时间 | 事件 |
| --- | --- |
| 22:47:47.828 | AgentDesk 记录 `Feishu long-connection reconnecting` |
| 约 22:48:07 | 飞书 SDK 输出 `Client network socket disconnected before secure TLS connection was established` |
| 22:49:40.805 | AgentDesk 记录 `Feishu long-connection reconnected` |
| 22:49:56.260 | macOS 记录主网络接口切换到 `en1` |

本次断连持续约 **112.98 秒**。断连窗口内可见 TLS 建连前 socket 被断开，同时系统网络路径涉及 `utun1` 隧道和本机代理，因此更像网络/代理路径不稳定，而不是业务代码主动关闭连接。

### 2.2 2026-08-06 凌晨短断连

| 时间 | 事件 |
| --- | --- |
| 01:02:28.323 | AgentDesk 记录 `Feishu long-connection reconnecting` |
| 01:02:36.099 | AgentDesk 记录 `Feishu long-connection reconnected` |
| 01:02:36.381 | macOS 记录主网络接口切换到 `en1` |

本次断连持续约 **7.78 秒**。飞书重连完成后仅约 **0.28 秒**，系统就记录了主网络接口变化，两者时间高度相关。

## 3. 排除项与辅助证据

### 3.1 Host 没有在断连时重启

断连窗口内没有出现以下生命周期事件：

- `AgentDesk Agent Platform starting`
- `Shutdown signal received`
- 未捕获异常或致命退出

当前三个 launchd 服务均保持运行：

- `com.agentdesk.full-host`
- `com.agentdesk.bitable-gateway`
- `com.agentdesk.archive-gateway`

因此，断连不是由 Host 进程退出直接造成的。

### 3.2 Node.js 事件循环没有明显卡死

断连期间，语音照片监测器仍然大约每 5 秒输出一次日志，定时器没有出现与断连时长相当的空档。这说明 Node.js 主事件循环仍在持续调度。

### 3.3 SMB 异常暂时视为并行问题

日志持续出现：

- `voice_photo_scan_unavailable` / `SMB_UNAVAILABLE`
- `voice_photo_json_cycle_failed` / `ENOENT`

但这些日志在断连前、断连中和断连后都以稳定的 5 秒周期出现，没有和飞书断连形成明确的开始/结束对应关系。因此它们需要单独修复，但目前不像飞书掉线的直接原因。

### 3.4 容器超时回收与本次断连无直接关系

此前出现的 `absolute-ceiling` 容器回收发生在其他时间点，是运行时对超时会话的预期清理，不与本次飞书长连接断连重合。

## 4. 原因优先级

| 优先级 | 候选原因 | 当前判断 |
| --- | --- | --- |
| 高 | VPN/代理 TUN 路由重建或主接口切换 | 与两次重连时间高度相关，且长断连出现 TLS 建连前断开 |
| 中 | 飞书 WebSocket 上游短暂异常 | 仍有可能，需要更多原始 SDK 错误或飞书侧状态佐证 |
| 低 | AgentDesk Host 崩溃/重启 | 生命周期日志和 launchd 状态均不支持 |
| 低 | SMB 扫描阻塞事件循环 | 5 秒定时日志在断连期间持续正常运行 |

## 5. 已启用的持续监测

已创建每 5 分钟运行一次的心跳监测，自动化标识为 `agentdesk`。

每轮监测只读检查：

1. `data/runtime-logs/host.out.log` 的新增尾部；
2. `data/runtime-logs/host.err.log` 的新增尾部；
3. 三个 launchd 服务的运行状态；
4. 飞书重连开始、完成和错误；
5. Host 启停、未捕获异常和致命错误；
6. Docker 容器退出、同步 stop 和异常回收；
7. SMB 扫描成功/失败与定时日志间隔漂移；
8. 新事件与 TLS、socket、代理及网络路径变化的时间关联。

发生新断连时，报告应包含：

- 本地日期和时间；
- 断连持续秒数；
- Host 是否重启；
- Node.js 事件循环是否出现明显停顿；
- 同期 Docker、SMB、TLS 或 socket 异常；
- 当前最可能原因及置信度变化。

监测结果不得包含消息正文、凭据、用户标识或其他敏感值。没有新增异常时，只输出一句简短状态，避免重复旧结论。

## 6. 下一次断连时的采证清单

### 6.1 查看 AgentDesk 关键日志

```bash
tail -F data/runtime-logs/host.out.log data/runtime-logs/host.err.log \
  | rg --line-buffered -i \
    'Feishu long-connection|\[ws\]|TLS|socket|ECONN|EPIPE|Agent Platform starting|Shutdown signal|uncaught|unhandled|fatal|SMB_UNAVAILABLE|Container exited|Killing container'
```

### 6.2 查看 launchd 服务状态

```bash
for label in \
  com.agentdesk.full-host \
  com.agentdesk.bitable-gateway \
  com.agentdesk.archive-gateway
do
  launchctl print "gui/$(id -u)/$label" 2>/dev/null \
    | rg '^\s*(state|pid|runs|last exit code) ='
done
```

### 6.3 查看当前代理与路由拓扑

```bash
scutil --proxy
route -n get default
ifconfig utun1
networksetup -getwebproxy Wi-Fi
networksetup -getsecurewebproxy Wi-Fi
```

采集结果时应隐藏代理认证信息、IP、SSID、BSSID、用户标识和凭据。

### 6.4 对齐 macOS 网络系统日志

在断连时间点前后各取 2～3 分钟，重点检查：

- `primary interface change`
- `NWPathStatusSatisfied` / `NWPathStatusUnsatisfied`
- Wi-Fi disassociate/reassociate
- `utun` 创建、销毁或路由变化
- DNS、代理或 TLS 超时

该步骤只读，但读取 macOS 统一日志通常需要额外系统授权。

## 7. 建议修复顺序

### 7.1 第一优先：稳定代理/VPN 网络路径

1. 检查代理客户端是否启用了 TUN 模式、自动路由切换、自动选择节点或网络变化后重建隧道；
2. 检查断连时间点代理客户端自身是否发生节点切换、配置重载或健康检查切换；
3. 在确认飞书实际 API/WebSocket 主机名后，将这些主机加入稳定直连或固定代理策略；
4. 避免同时存在多套系统代理、环境变量代理和 TUN 规则，减少路径竞争；
5. 修改后至少持续观察 24 小时，并比较断连次数和最长断连时长。

不要凭猜测添加飞书域名白名单；应先从实际 SDK 连接或安全脱敏后的网络日志中确认目标主机。

### 7.2 第二优先：增强 AgentDesk 连接可观测性

建议在 `src/channels/feishu.ts` 的长连接回调中补充：

- 重连开始时间；
- 重连完成后的精确持续时间；
- 连续重连次数；
- `onError` 的错误类型、错误码和 syscall；
- 仅包含接口名称和路径类型的安全网络快照；
- 结构化的原始 SDK WebSocket 错误，避免只有散落的 `[ws]` 文本。

这些字段不得记录 token、URL 查询参数、消息内容或用户信息。

### 7.3 第三优先：增加传输容灾

如果已有可靠、可公网访问并完成签名校验的飞书 webhook，可以评估 `hybrid` 模式，让 webhook 与长连接并行接收事件，并依赖现有入站去重逻辑避免重复处理。

启用前必须验证：

- webhook 可用性和签名配置；
- 相同事件在双通道下能被稳定去重；
- 卡片回调和消息事件的响应时限；
- 网络故障时至少有一条传输路径仍然可用。

### 7.4 单独处理 SMB 告警噪声

SMB 挂载不可用和 JSON 路径缺失虽然不像本次飞书断连的根因，但当前每 5 秒输出日志，会快速放大日志文件并干扰排障。建议：

- 对相同错误进行指数退避或限频；
- 状态从可用变为不可用时记录一次；
- 恢复时记录一次；
- 周期性输出聚合计数，而不是每轮重复输出相同错误。

## 8. 验收标准

完成网络或代码调整后，至少观察 24 小时，并满足：

- 不再出现超过 10 秒的飞书长连接中断；
- 没有因网络切换导致 Host 重启；
- 每次重连都能记录开始时间、完成时间、耗时和错误类别；
- SMB 不可用不会造成事件循环明显漂移；
- launchd 三个服务持续为 `running`；
- 没有消息丢失或重复处理的证据。

若仍发生断连，应以新的时间点为中心重新对齐 AgentDesk、macOS 网络、代理客户端和飞书 SDK 四类日志，再决定是否修改连接策略或升级 SDK。
