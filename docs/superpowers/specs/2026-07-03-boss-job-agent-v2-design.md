# boss-job-agent v2 设计 (2026-07-03)

## 背景

v1 (2026-06-13) 端到端跑通: scan(搜索+LLM一筛+材料) → greet(真实打招呼) → poll(回复→飞书)。
截至 2026-07-03: greeted 46 / replied 0 / error 9。

核心问题:
- **回复链路不可信**: 无 messages/conversations 表, poll 只做即时通知不落库; 登录态 ~2h 过期而 cron 每 1h 跑, 过去三周 poll 大概率多数时间失效 → replied=0 可能是漏检而非真无回复。
- **需求缺口**: 二筛背调、回复后发定制简历、AI 分级代回复、面试意图识别均未实现。`src/modules/` 下 company_research / company_style / deep_resume / hr_reply_agent / resume_sender / boss_page_intel 为 Codex 实验遗留**死代码**, 主流程零引用。

## 目标 (用户原始需求)

1. 一筛+二筛合并: 需求匹配 + 公司背调 + JD 真实性评估 (识别挂羊头卖狗肉)
2. 打招呼后, HR 回复即发送**逐岗定制**简历 (JD 对齐 + 公司风格定制)
3. HR 后续沟通由 AI 代回复, 素材来自 claude-memo 记忆系统 (项目经历/个人经历)
4. 约面试 → 飞书通知, 用户人工决策

## 已确认决策

| 决策点 | 结论 |
|---|---|
| 总体路线 | 方案 A 渐进改造: 保留 patchright 反爬底座与已验证的 scan/greet 链路, 分四阶段补齐 |
| 代回复边界 | **分级自动**: 常规问答全自动; 敏感节点 (薪资/约面/要微信/线下) 飞书推草稿待确认 |
| 背调数据源 | Boss 站内 + web 搜索(经代理, 挂则降级) + 天眼查/企查查(best-effort, 失败静默跳过, 不做硬依赖) |
| 附件发送流程 | **用户录屏演示一遍** → Claude 提取操作序列 → headed patchright 实测 selector → 固化进 resume_sender 复用 |
| LLM | 沿用 DeepSeek (deepseek-v4-pro → deepseek-chat 降级) |
| 记忆接入 | 直读 `D:\claude-memo\memo.sqlite` (better-sqlite3 readonly + memory_fts FTS5 查询), 不经 MCP |
| 实现方式 | 每阶段 writing-plans → Codex (mcp__codex__codex) 实现 → dry-run 验收 → 小流量真实验收 |

## 架构

会话状态机 (per job):

```
greeted → replied → resume_sent → chatting → interview_intent → human_takeover
                                      ↑____________|  (循环: 常规问答自动回)
```

注: 消息意图分类独立于状态 — 约面/敏感消息可在任意状态触发, 直接跳 interview_intent/human_takeover; 状态机描述的是主干顺序而非唯一路径。

新增表:
- `conversations(id, job_id, boss_conv_id, state, last_msg_at, login_gap_flag)`
- `messages(id, conv_id, role[hr|me|system], text, ts, seen, action_taken)`
- `pending_actions(id, conv_id, type[reply_draft|interview|resume_send], payload, status[pending|approved|rejected|expired], created_at)`

`poll` 命令升级为 `chat`: 增量读全部收件箱会话 → 去重落库 → 按状态机分发动作。P3/P4 的动作全部挂在 chat 循环上。

## P1 — 根基: 回复链路可信 (最优先)

- 建三张新表, migration 随 db.js 启动执行
- chat 命令: 全量收件箱增量读取 (不再仅限已知 job), 消息去重 (conv_id+ts+text hash), 落库后再通知
- **登录保活**: OpenClaw cron 1h → 25min; 每轮先访问常规页面刷新会话; 登录失效时段写入 meta 表, 量化漏检窗口; 失效 → 飞书扫码通知 (沿用)
- **历史补录**: 手动触发一次全量 inbox 扫描, 补录 6-13 以来全部历史回复
- 验收: 历史补录结果出炉 (replied=0 真伪定论) + 连续一周 chat 无漏检、无静默失败

## P2 — 二筛/背调 (合并进 scan)

- 三层信号, 逐层降级:
  1. Boss 站内 (boss_page_intel 重写接入): 公司主页、在招岗位画像、规模/融资、HR 活跃度
  2. Web 搜索 (经 FlClash 代理): 公司名 + 口碑/骗局/培训贷/裁员; 代理不可用 → 跳过并标记 degraded
  3. 天眼查/企查查: best-effort 抓公开页, 失败静默跳过
- LLM 综合评估输出: `company_score`, `red_flags[]`, `bait_and_switch` (JD/title/公司在招岗位画像矛盾检测); 存 jobs 表新列
- 背调结果双用途: 筛选门槛 + P3 简历风格定制输入
- 验收: 对已 greeted 的 46 家公司回填背调, 人工抽查 10 家红旗判定准确性

## P3 — 回复触发定制简历

- 触发: chat 读到 HR 首条真人回复 (过滤系统消息/已读回执) → 状态 replied
- deep_resume 接入: JD 关键词对齐 + 公司风格 (由 P2 背调推断: 大厂正式/初创技术向/传统企业稳重) → md → docx (复用 gen_resume_docx.mjs 的 docx-js 链路)
- **不编造纪律**: 内容仅来自 profile/ + claude-memo 事实; fact_utils 校验产出中的每个事实声明有来源
- 发送: resume_sender (approved=true 真发), 发后飞书通知 + 附简历副本; 状态 → resume_sent
- **UI 流程固化** (2026-07-04 已完成录屏解析): 真实机制为**附件库模式** — 简历先上传到 个人中心→附件管理 (上限 3 槽, 删除不影响已发送副本), 聊天时从库中选发, 不存在聊天页直传。操作序列已固化为项目 skill `.claude/skills/boss-resume-attachment/SKILL.md`; 替换循环 = 删旧→传新→聊天选发。剩余待验证: 聊天页"从库选发"交互 (headed 实测或用户补录), 实现时回填真实 selector。现有 resume_sender 中的聊天页 attach selector 全部作废
- 验收: dry-run 输出计划步骤核对 → 单岗位真实发送成功 + 飞书收到副本

## P4 — 分级代回复 + 面试意图

- 每条 HR 新消息 LLM 分类: `routine`(项目/技能/到岗/学历等常规问答) | `sensitive`(薪资/约面/要微信/线下/索要材料) | `noise`(寒暄/系统)
- routine → hr_reply_agent 自动回复; 素材检索: claude-memo FTS 查询 (tags: job-hunting/profile/项目相关) + profile/, 只读
- sensitive → 写 pending_actions + 飞书推草稿+上下文摘要; **确认通道**: 用户直接在飞书回复, chat 每轮经 lark-cli 拉取用户最新消息核销 pending (无需 PC 跑命令); 超时 24h 标 expired 并再提醒一次
- 约面 → 飞书推卡片 (岗位+公司背调摘要+建议时间), 用户飞书回复决定; AI 仅代发确认/婉拒话术
- 回复节奏: 随机延迟 30-120s, 单会话单轮最多 1 条自动回复, 全天自动回复上限 (config 可调)
- 验收: 影子模式跑 3 天 (只生成草稿全部飞书确认, 不自动发) → 分类准确率人工核对 → 放开 routine 自动发

## 不变项 (风控三件套)

patchright (破指纹) + 真人节奏 (破行为, 全链路含 chat/附件发送) + 遇 security.html 保持 headed 窗口飞书叫人工过验证。greet dailyLimit 30 / activeHours 9-21 沿用。

## 风险

| 风险 | 缓解 |
|---|---|
| Boss 限制附件发送 / 强制走"在线简历"流程 | P3 第一步用户录屏探路, 流程不通则改为发送在线简历 + 附件降级为文本亮点摘要 |
| 自动回复被 HR/风控识别为机器 | 影子模式先行 + 真人节奏 + 单轮单条限制 |
| 登录保活无效 (Boss 强制短会话) | 保活失败数据落库, 若确认无效则接受 2h 会话 + 提高扫码通知优先级 |
| 天眼查反爬 | 设计即降级, 不阻塞 |
| DeepSeek 分类/生成质量不足 | 影子模式数据评估, 必要时关键节点换更强模型 |
