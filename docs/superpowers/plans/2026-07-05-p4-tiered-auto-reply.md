# P4 实施计划: 分级代回复 + 面试意图

> **执行方: Codex (gpt-5.5)**, 按 Task 分批派活。
> Spec: `docs/superpowers/specs/2026-07-03-boss-job-agent-v2-design.md` P4 节。P3 已完成(HEAD)。

**Goal:** HR 后续消息按意图分级 — 常规问答 AI 自动回 (影子模式默认只出草稿), 敏感节点(薪资/约面/要微信/线下) 飞书推草稿待用户确认, 面试意图飞书推卡片由用户决策。

**Architecture:** 复用死代码 hr_reply_agent (意图分类+草稿+防护) 和 P1 的 pending_actions 表。runChat 每轮对新 HR 消息分类分发: routine→自动回(非影子且开关开)/sensitive→pending+飞书草稿/interview→pending+飞书卡片/noise→跳过。确认通道: 用户飞书回复, chat 每轮经 lark-cli 拉取用户最新消息核销 pending。**影子模式默认**: 全部只生成草稿飞书推, 绝不自动发, 跑够信任再放开 routine。

**Tech Stack:** Node 24 ESM, DeepSeek(hr_reply_agent), lark-cli(飞书推+拉), claude-memo只读(素材, 复用 P3 memory_facts), better-sqlite3。

**不可逆红线:** 自动回复 HR = 对外不可逆。config `reply.shadowMode=true` 默认(只草稿不发) + `reply.autoRoutine=false`(routine 也默认不自动发, 影子期人工确认)。真实自动回复需两开关都放开 + 用户验证影子数据后。单会话单轮最多 1 条自动回复; 全天上限 config 可调。

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/modules/hr_reply_agent.js` | 改接入 | 死代码, 接主流程; 加 conversation history + memory facts 上下文 |
| `src/pipeline/reply_pipeline.js` | 建 | 编排: 取会话历史+记忆→draftHrReply→分级决策 |
| `src/boss/pending_actions.js` | 建 | pending_actions CRUD + 飞书推草稿/卡片 |
| `src/boss/lark_inbox.js` | 建 | lark-cli 拉取用户飞书回复, 匹配核销 pending |
| `src/modules/resume_sender.js` | 复用 | sendOptionalMessage 发聊天文本(已有) |
| `src/workflows.js` | 改 | runChat 加分级分发 + pending 核销轮 |
| `src/db.js` | 改 | pending_actions 访问函数; messages.action_taken 标记 |
| `src/config.js`,`config.json` | 改 | reply 段开关 |

---

## Task A: HR 回复分级编排 (纯单测, 无浏览器)

**接入 hr_reply_agent (已有 draftHrReply/validateHrReplyDraft/HR_INTENTS)**, 建 `src/pipeline/reply_pipeline.js`:
- `classifyAndDraft(job, { reply, conversationHistory, profileText, memoryFacts, chatFn })`:
  1. 组装上下文: 会话历史(messages表该conv最近N条) + P3 memory_facts(项目素材) + profileText + jobs.research_json里的简历策略
  2. draftHrReply(...) → {intent, confidence, sendResume, notifyUser, proposedReply, ...}
  3. 分级: `tier` = interview_invite→"interview" | (salary_or_availability|要微信/线下/ask contact) →"sensitive" | screening_question/other→"routine" | spam_or_sales/rejection→"noise"
  4. 返回 {tier, draft, requiresConfirm: tier!=="routine"||shadowMode}
- db.js: `getConversationMessages(db, convId, {limit})`, pending_actions CRUD (`createPendingAction/listPendingActions/resolvePendingAction`)

单测(fake chatFn + 内存库): 各 intent→正确 tier; interview 必 requiresConfirm; routine 影子模式也 requiresConfirm; 联系方式防护(复用 hr_reply_agent 校验)。commit `feat(reply): tiered classify+draft pipeline`。

## Task B: pending_actions + 飞书确认通道 (纯单测, 无浏览器)

**建 `src/boss/pending_actions.js` + `src/boss/lark_inbox.js`**:
- `pushPendingToLark(pending, {notifyFn})`: 飞书推草稿/卡片, 文案含短确认码(pending id 后6位) + 会话/HR/草稿全文 + "飞书回复 `确认 <码>` 发送 / `改 <码> <新内容>` / 忽略"
- `reconcilePendingFromLark({db, larkFetchFn})`: lark-cli 拉用户最近发给bot的消息 → 解析 `确认/改/忽略 <码>` → resolvePendingAction(approved/rejected + 可选改写内容); 匹配不到的忽略; 超时24h标expired并再提醒一次
- lark_inbox.js: 封装 lark-cli im 拉取用户→bot 的最新消息(近1h), 返回 [{text, ts}]; lark-cli 不可用→返回[]降级

单测(fake larkFetchFn + 内存库): 推送文案含码; 确认码匹配→approved; 改写→approved+新内容; 忽略→rejected; 无匹配不动; 过期→expired。commit `feat(reply): pending actions + lark confirm channel`。

## Task C: runChat 分级分发集成 + 影子模式

**改 `src/workflows.js` runChat**, `config`:
- 每条新 HR 消息(role=hr, action_taken null, 非简历请求[P3已处理]):
  - classifyAndDraft → tier
  - **影子模式(默认)或非routine**: createPendingAction(draft) + pushPendingToLark; action_taken='reply_pending'
  - **非影子 且 routine 且 autoRoutine开**: 直接发(Task D的sendReply, dryRun默认) ; action_taken='auto_replied'
  - noise: 跳过, action_taken='reply_noise'
- runChat 每轮先 reconcilePendingFromLark 核销上轮 pending → approved 的执行发送(Task D)
- config reply:{shadowMode:true, autoRoutine:false, maxAutoPerRun:3, replyDelaySec:[30,120]}
- 单会话单轮最多1条; 全天上限

单测(fake 各fn+内存库): 影子模式全进pending不自动发; routine非影子autoRoutine开才自动发; 核销approved→触发发送; 单轮上限。commit `feat(chat): tiered reply dispatch + shadow mode`。

## Task D: 发送聊天回复 + 验收

- `sendReply(page,{conversation,text,dryRun=true,approved=false})`: 复用 resume_sender 的 openConversation + sendOptionalMessage(已实测chat editor selector); dryRun默认输出计划; approved真发; 真人节奏 replyDelaySec
- cli `reply --conv <key> [--send]` 手动触发单会话回复(缺省dry-run)
- **验收(影子优先)**:
  - 影子模式跑: 对有HR后续消息的真实会话(如李嘉欣@裴趣商贸已谈条件) classifyAndDraft, 核对 intent 分类准确 + 草稿质量(引项目/不粘简历/不越权承诺) + 飞书收到草稿
  - 确认通道: 飞书回复 `确认 <码>` → 下一轮 chat 核销 → dry-run 计划(不真发)
  - **真实自动回复: 用户验证影子数据后**, 放开 shadowMode/autoRoutine, 低风险会话试
- 验收日志 data/logs/p4-acceptance; memory_remember 里程碑(src:codex)

commit `feat: send chat reply + reply CLI (dry-run default)`。

## 自检清单

- [ ] 影子模式默认: 无任何自动外发, 全飞书草稿
- [ ] 面试邀约必飞书通知用户(不自动回)
- [ ] 草稿防护: 不粘完整简历/电话/邮箱, 不越权承诺面试时间
- [ ] 敏感(薪资/微信/线下)进pending不自动回
- [ ] 单会话单轮≤1条自动回复 + 全天上限
- [ ] `node --test --test-concurrency=1 $(git ls-files 'test/*.test.js')` 全绿
- [ ] 老库自动迁移无损
