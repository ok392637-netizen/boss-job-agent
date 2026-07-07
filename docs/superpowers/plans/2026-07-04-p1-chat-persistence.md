# P1 实施计划: 消息落库 + chat 命令 + 登录保活 + 历史补录

> **执行方: Codex (gpt-5.5)**。你对本代码库零上下文, 本文档给全所需信息。遵循 TDD, 小步提交。
> Spec: `docs/superpowers/specs/2026-07-03-boss-job-agent-v2-design.md` (先通读)

**Goal:** 让回复链路可信 — HR 回复全量落库、可增量检测、登录失效可量化, 并补录 2026-06-13 以来的全部历史回复, 定论 replied=0 的真伪。

**Architecture:** 现有 poll 只读"有未读红点"的会话 (`src/boss/inbox.js` filter `inboxUnread`) — 用户本人日常刷 Boss 会清掉未读, 导致回复永久漏检; 且消息从不落库。P1 改为: 全量会话枚举 → 变化检测 → 点进会话读消息history → 按 hash 去重落库 → 新 HR 消息才通知飞书。新增 `chat` 命令替代 `poll` (保留 poll 为别名, OpenClaw cron 兼容)。

**Tech Stack:** Node 24 ESM, patchright (勿用原生 playwright, 见下"风控铁律"), better-sqlite3, commander, node:test (现有 test/ 目录风格), lark-cli 通知 (经 `src/notify.js` 已封装)。

**风控铁律 (违反=事故):**
- 浏览器只经 `src/browser.js` 启动 (patchright + 持久化 profile `data/browser-profile`), 不得直接 import playwright
- 页面动作间用 `humanDelay` (browser.js 已有); 打开会话间隔 4-10s 随机 + 随机滚动; 单次 chat run 打开会话数默认上限 10 (backfill 模式无上限但节奏不变)
- 每次导航后调 `assertPageSafe(page, {db, notifyFn, expectLoggedIn:true})` (`src/boss/greet.js` 导出): 它处理 security.html 人工验证等待与登录检测, 直接复用
- 所有新 DOM selector 先跑验证脚本实测再写死 (见 Task 2)

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/db.js` | 改 | 新增 3 表 DDL + conversation/message/login_event 访问函数 |
| `src/boss/chat_reader.js` | 建 | 纯 DOM 读取: 会话列表全量枚举 + 单会话消息历史提取 |
| `src/boss/selectors.js` | 改 | 新增聊天列表/气泡 selector (Task 2 实测后填) |
| `src/workflows.js` | 改 | 新增 `runChat`; `runPoll` 改为薄别名调 runChat |
| `src/cli.js` | 改 | 新增 `chat [--backfill] [--max <n>]`; poll 标记 deprecated 别名 |
| `scripts/verify-chat-dom.mjs` | 建 | headed 会话 dump 聊天页 DOM 候选 selector |
| `test/db.chat.test.js` | 建 | 表迁移 + 去重 + login_events 单测 |
| `test/workflows.chat.test.js` | 建 | runChat 增量/补录/通知聚合 (注入 fake page/notify, 仿现有 test 的 DI 风格) |

---

## Task 1: DB 迁移 + 访问函数 (纯单测, 无浏览器)

**DDL 追加到 `db.js` 的 SCHEMA (CREATE TABLE IF NOT EXISTS, 老库自动升级):**

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boss_conv_key TEXT NOT NULL UNIQUE,
  job_id TEXT,
  hr_name TEXT, company TEXT, job_title TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  last_msg_text TEXT, last_msg_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('hr','me','system')),
  text TEXT NOT NULL,
  msg_hash TEXT NOT NULL,
  sent_label TEXT,
  seen_at TEXT DEFAULT (datetime('now','localtime')),
  action_taken TEXT,
  UNIQUE (conv_id, msg_hash)
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER REFERENCES conversations(id),
  type TEXT NOT NULL CHECK (type IN ('reply_draft','interview','resume_send')),
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN ('ok','expired','recovered')),
  at TEXT DEFAULT (datetime('now','localtime'))
);
```

**新增导出函数 (签名固定, 实现自便):**
- `upsertConversation(db, {bossConvKey, jobId?, hrName?, company?, jobTitle?, lastMsgText?, lastMsgAt?})` → row; ON CONFLICT 更新非空字段 + updated_at
- `insertMessage(db, convId, {role, text, sentLabel?})` → `{inserted: boolean, row}`; msg_hash = sha1(`${convId}|${role}|${text}|${sentLabel??""}`).slice(0,16); UNIQUE 冲突时 inserted=false (INSERT OR IGNORE)
- `listConversations(db, {state?} = {})`, `getConversationByKey(db, key)`, `listMessages(db, convId)`
- `recordLoginEvent(db, event)`, `lastLoginEvent(db)`
- `getStatusCounts` 保持不动; `getStatusSnapshot` (workflows.js) 增加 conversations/messages 总数

**pending_actions 本阶段只建表不写业务** (P4 用, schema 先稳定)。

步骤: 先写 `test/db.chat.test.js` (内存库: 建表存在性 / upsert 幂等 / insertMessage 重复文本+相同 sent_label 去重、不同 sent_label 不去重 / login_events 顺序) → 跑红 → 实现 → 跑绿 → commit `feat(db): conversations/messages/pending_actions/login_events tables`。

## Task 2: 聊天页 DOM 实测 + chat_reader.js

**先实测再编码。** 建 `scripts/verify-chat-dom.mjs`: 复用 `src/browser.js` 开 headed → goto `URLS.messages` (selectors.js 已有) → 等渲染 → dump: 会话列表每项的 outerHTML 前 500 字符 (前 3 项)、点进第一个会话后消息区每条气泡的 class/结构 (区分 我方/HR/系统卡片)。输出写 `data/logs/verify-chat-dom-<ts>.log`。**跑此脚本需登录态; 若 login 过期, assertPageSafe 会飞书通知用户扫码, 等待即可, 不要绕过。**

据 dump 结果在 `selectors.js` 新增 (命名固定):
- `chatConversationItem` (全量会话项, 不带未读过滤), `chatConvKey` 提取逻辑 (data-id 或 href), `chatConvHrName/JobTitle/LastMsg/LastMsgTime`
- `chatMsgItem`, `chatMsgMine` (我方气泡判别), `chatMsgSystem` (系统/卡片消息判别), `chatMsgText`, `chatMsgTimeLabel`

`chat_reader.js` 导出两个纯读函数 (不写库, 好测):
- `listAllConversations(page)` → `[{bossConvKey, hrName, jobTitle, lastMsgText, lastMsgTimeLabel, hasUnread}]` — **不过滤未读**
- `readConversationMessages(page, bossConvKey, {scrollRounds = 0})` → `[{role:'hr'|'me'|'system', text, sentLabel}]`; scrollRounds>0 时向上滚动加载历史 (backfill 用, 每轮滚动间 humanDelay 1-3s)

现有 `src/boss/inbox.js` 的 `pollReplies` 保留不删 (runPoll 别名过渡期兼容), 但 runChat 不用它。

commit `feat(boss): chat_reader with verified selectors`。

## Task 3: runChat workflow

`workflows.js` 新增, 签名仿现有 runPoll 的 DI 风格 (test 注入 fakes):

```
runChat({ db, page?, notifyTextFn?, notifyFileFn?, backfill = false, maxConversations = config.chat.maxPerRun, listFn?, readFn? })
```

流程 (每步之间 humanDelay):
1. goto 推荐页 (`URLS.recommend`, selectors.js 有则用, 无则加) → assertPageSafe → `recordLoginEvent(db,'ok')`; 若 assertPageSafe 抛登录失效: `recordLoginEvent(db,'expired')` + 现有飞书扫码通知逻辑, 结束本轮 (这就是登录保活: 每轮先访问常规页刷新会话 + 失效落库可量化)
2. goto 消息页 → `listAllConversations` → 逐个 `upsertConversation`
3. 选择要打开的会话: backfill=true → 全部; 否则 → `lastMsgText` 与库中不一致的, 取前 maxConversations 个
4. 逐个打开: `readConversationMessages` (backfill 时 scrollRounds=5, 否则 0) → `insertMessage` 逐条 → 收集 `inserted=true && role='hr'` 的新消息
5. 通知策略: **常规模式** — 每个有新 HR 消息的会话发一条飞书 (复用现有 `processReplyNotifications` 的 job 匹配 (`findReplyJob`) 与状态迁移 greeted→replied→notified 语义, 可重构共用); **backfill 模式 — 只发一条汇总** (会话数/新落库消息数/有 HR 回复的会话清单), 严禁逐条轰炸
6. 返回 `{conversations, opened, newHrMessages, notified, loginOk}`

`test/workflows.chat.test.js` 场景 (fake listFn/readFn/notify, 内存库):
- 增量: 两次 run, 第二次 lastMsg 无变化 → opened=0, 不通知
- 新 HR 消息 → 落库 + 单会话通知 + job 状态 greeted→replied
- backfill: 多会话多消息 → 全落库 + 仅 1 条汇总通知
- 登录失效 (listFn 抛 LoginRequiredError) → login_events 记 expired, 不崩溃
- 去重: 同消息两次 run 只落一条、只通知一次

红→绿→commit `feat: runChat incremental persistence + backfill aggregation`。

## Task 4: CLI + status + 文档

- `cli.js`: 新增 `chat` 命令 (`--backfill`, `--max <n>`); `poll` 保留但 description 标 `(deprecated, alias of chat)`, 内部直调 runChat 默认参数 — **OpenClaw cron 目前调的是 poll, 不许破坏**
- `config.json` + `src/config.js`: 新增 `chat: { maxPerRun: 10, backfillScrollRounds: 5 }`
- `status` 输出追加: conversations 总数 / messages 总数 / 最近一次 login event
- README.md: chat 命令一节 + replied=0 根因说明 (未读过滤 bug)
- 全量测试过一遍 `node --test test/` → commit `feat(cli): chat command, poll deprecated alias`

## Task 5: 验收 (真实环境, headed)

1. `node src/cli.js chat --backfill` (headed, 登录态; 过期则等飞书扫码流程)
2. 核验: `node src/cli.js status` — conversations ≈ Boss 沟通过列表数量级, messages > 0; sqlite 抽查 3 个会话消息与页面一致 (role 判别正确)
3. 飞书收到且仅收到 1 条 backfill 汇总
4. 再跑一次 `node src/cli.js chat` (无 backfill) → opened=0 或仅真实变化的会话, 无重复通知
5. 把验收输出 (status 前后对比 + 汇总通知内容) 写入 `data/logs/p1-acceptance-<date>.log`

**验收后必做 (Codex memory discipline):** `memory_remember` 录入 P1 完成里程碑 + 聊天页实测 selector 清单 (tags 含 `src:codex`, `boss-job-agent`); 若发现新坑 (如消息时间标签格式、滚动加载行为) 单独录 pitfall。

---

## 自检清单 (Codex 完成前过一遍)

- [ ] 未直接 import playwright (只经 browser.js / patchright)
- [ ] 所有新 selector 有 verify-chat-dom 日志佐证
- [ ] backfill 只发 1 条飞书汇总
- [ ] poll 命令仍可运行 (cron 兼容)
- [ ] `node --test test/` 全绿
- [ ] 老库 (data/agent.db 副本) 打开即自动建新表, jobs 数据无损
