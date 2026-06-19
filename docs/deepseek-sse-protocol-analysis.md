# DeepSeek SSE 流式协议分析

> 基于 8 个 sse-log + 1 个 raw-log 的深度分析

## 1. 会话生命周期

```
[可选] /api/v0/chat/create_pow_challenge  → PoW 验证
         ↓
       /api/v0/chat/completion           → 主流
         ↓
  event: ready → update_session → F4快照 → F1/F2增量流 → BATCH(FINISHED)
```

## 2. 事件类型与数据格式

### 2.1 控制事件（非内容）

| 事件 | 格式 | 作用 |
|------|------|------|
| `event: ready` | `{"request_message_id":N, "response_message_id":N, "model_type":"default"}` | 会话初始化 |
| `event: update_session` | `{"updated_at": 1781873266.641037}` | 心跳保活 |
| BATCH+FINISHED | `{"o":"BATCH","v":[{"o":"SET","p":"response/status","v":"FINISHED"}, ...]}` | 流结束标记 |
| UI 控制 | `{"click_behavior":"none","auto_resume":false}` | 前端行为，非内容 |

### 2.2 内容格式（5 种）

#### F4 — 响应快照（基线内容）
```json
{"v": {"response": {"fragments": [{"type":"RESPONSE","content":"已有的基线文本"}], ...}}}
```
- **出现时机**: 流开始时，提供已生成的基线内容
- **关键**: 后续 F1 增量是在此基线之上追加的

#### F1 — 增量 Token（最常见）
```json
{"v": "你好"}          // 短 token (1-5字符)
{"v": "更重要的是"}      // 中等 token
{"v": "：\n\n"}         // 含换行/Markdown
```
- **规律**: 每个 chunk 含 3~10 个 F1 token，批量到达
- **特点**: 不含 `p`/`o` 字段，纯 `{"v":"text"}`

#### F2 — 带路径的 Patch 操作
```json
{"p": "response/fragments/-1/content", "o": "APPEND", "v": "得"}  // 内容追加
{"p": "response/status", "o": "SET", "v": "FINISHED"}             // 状态更新(非内容!)
```
- 内容: `o=APPEND` 且 `p` 包含 `content`
- 非内容: `o=SET`（状态字段），必须跳过

#### F3 — 批量操作
```json
{"o": "BATCH", "v": [{"o":"SET","p":"response/status","v":"FINISHED"}, {"updated_at":...}]}
```
- 通常是结束信号，内部 ops 多为 SET 状态

## 3. 典型流序（一次完整对话）

```
① event: ready          → metadata (跳过)
② event: update_session → keepalive (跳过)
③ F4                    → 响应快照，提取 fragments[0].content 作为基线
④ F2(APPEND,content)    → 第一个增量 token (如 v="得")
⑤ F1 × N               → 大量增量 token 流
   ...重复 ④⑤ 多个 chunk...
⑥ F3(BATCH)             → 含 FINISHED 状态
⑦ fetch_done            → HTTP 连接关闭
```

## 4. 发现的 Bug / 问题

### 4.1 F4 基线与 F1 增量未合并 ❌
- **现状**: `result = lastFullContent || accumulated`，二选一
- **实际**: F4 提供基线（如"得"），F1 是后续增量（如"对，我看到了..."）
- **结果**: `lastFullContent` 只有基线的几个字，`accumulated` 从零开始丢失了基线

### 4.2 metadata 被当作内容 ❌
- `request_message_id` 和 `click_behavior` 被标记为 PARSE-UNKNOWN
- 输出 `_______1_______` 占位符到 accumulated，污染内容

### 4.3 O(n²) 重复解析 ❌
- `tryParseContent()` 每收到一个 chunk 就重新解析整个 body
- 对于长对话（100+ chunks），性能浪费严重

### 4.4 日志路径未使用 logs/ 目录 ⚠️
- 日志文件直接写到项目根目录

## 5. 优化方案

1. **F4 作为基线 + F1/F2 增量追加** → `result = baseline + incremental`
2. **过滤 metadata JSON** → 识别 `request_message_id`/`click_behavior` 等跳过
3. **增量解析** → 只处理新增 chunks，不重复解析
4. **日志路径** → 统一写入 `logs/` 目录
