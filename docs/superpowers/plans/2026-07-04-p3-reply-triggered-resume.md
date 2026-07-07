# P3 实施计划: HR 回复触发定制简历

> **执行方: Codex (gpt-5.5, 额度已恢复)**, 按 Task 分批派活。
> Spec: `docs/superpowers/specs/2026-07-03-boss-job-agent-v2-design.md` P3 节。
> **必读 skill**: `.claude/skills/boss-resume-attachment/SKILL.md` (附件库 3 槽机制, 决定 Task B/C 架构)。

**Goal:** HR 回复 (尤其索要简历) 触发 → 按 JD + 公司背调风格生成定制简历 docx → 传入 Boss 附件库 → 聊天从库选发; 全程 dry-run 默认, 真实外发经 approved 门控。

**Architecture:** 复用已跑通的死代码模块 (deep_resume/company_style/fact_utils/resume_sender), 接入主流程。简历定制事实边界靠 fact_utils + claude-memo 项目事实 (只读)。发送分两步: 附件库管理 (个人中心→附件管理, 3 槽, 删旧传新) + 聊天选发 (录屏未覆盖, headed 实测补)。触发挂在 P1 的 runChat 状态机上。

**Tech Stack:** Node 24 ESM, patchright, better-sqlite3 (claude-memo 只读), docx-js (gen_resume_docx.mjs 链路), DeepSeek。

**风控铁律 (同 P1/P2):** 只经 src/browser.js; humanDelay 全程; assertPageSafe 每次导航后; 新 selector 先 verify 脚本 headed 实测再写死; 浏览器全局锁 (data/agent.lock) — 附件库/聊天发送与 chat/scan/greet 互斥。

**不可逆红线:** 真实发简历给 HR 是对外不可逆操作。resume_sender 已有 dryRun 默认 + approved 门。P3 保持: dryRun=true 默认输出计划步骤; 真实发送需 approved=true + 配置开关 + **首次真实发送必须用户在场**。Task E 的 live send 是独立门控步骤, 不在自动 cron 里。

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/modules/memory_facts.js` | 建 | claude-memo SQLite 只读, 取用户项目/经历事实喂 deep_resume |
| `src/modules/deep_resume.js` | 改接入 | 现有死代码, 接主流程; 事实边界校验 |
| `src/modules/company_style.js` | 改接入 | 由 P2 research 的 style_hint 驱动 |
| `src/pipeline/customize_resume.js` | 建 | 编排: 背调+记忆→deep_resume→docx; 复用 gen_resume_docx 链路 |
| `src/boss/attachment_library.js` | 建 | 附件库 CRUD (个人中心→附件管理, 3 槽轮换) |
| `src/modules/resume_sender.js` | 重写 | 聊天页选发改为"从附件库选发"; 废弃旧 attach selector |
| `src/boss/selectors.js` | 改 | 附件库 + 聊天选发 selector (实测后填) |
| `scripts/verify-attachment-dom.mjs` | 建 | headed dump 附件管理面板 + 聊天选发交互 |
| `src/workflows.js` | 改 | runChat 加简历请求检测 → 触发定制发送 (dry-run) |
| `src/db.js` | 改 | messages.action_taken 用于标记已发; jobs.resume_path 复用 |

---

## Task A: claude-memo 项目事实读取 (纯单测, 无浏览器)

**背景:** deep_resume 的 memoryProjects 参数需要用户真实项目事实。用户所有项目在 claude-memo (`D:\claude-memo\memo.sqlite`, memories 表 + memory_fts FTS5)。memo #21 是"罗其立个人经历档案(求职Agent素材库)"。

**文件:** 建 `src/modules/memory_facts.js`

- `readProjectFacts({ dbPath = "D:/claude-memo/memo.sqlite", query = "求职 项目 经历 profile", limit = 8 })` → `[{title, content, tags}]`; better-sqlite3 **readonly** 打开; 用 FTS5 查 job-hunting/profile/项目 相关 memories; DB 不存在或打不开 → 返回 [] 不抛 (降级)
- 提取结构化项目事实: 从 content 解析项目名/数字/成果 (memo #21 已有结构), 输出 deep_resume 可用的 `{name, facts[], metrics[]}`

单测 (临时 sqlite fixture, 不碰真库): 建表插 3 条 → 查询命中/降级/FTS 匹配。commit `feat(resume): claude-memo project facts reader (readonly)`。

## Task B: 简历定制编排 (纯单测, 无浏览器)

**文件:** 建 `src/pipeline/customize_resume.js`; 接入 deep_resume.js/company_style.js (已存在, 补导出/接线)

- `customizeResume(job, { research, resumeBase, profileText, memoryFacts, chatFn })`:
  1. company_style(job, research) → styleProfile (由 research.style_hint 驱动: 大厂正式/初创技术/传统稳重)
  2. deep_resume(job, resumeBase, profileText, research, styleProfile, memoryProjects=memoryFacts) → 定制简历 JSON + strategy
  3. fact_utils 校验: assertNoUnsupportedNumbers (产出数字必须在 base/profile/memory 出现过) + 不可变字段 (姓名/联系方式/教育/公司/日期) 逐字等于 base
  4. 渲染 docx: 复用 renderResume (src/pipeline/resume.js) / gen_resume_docx.mjs docx-js 链路; 文件名**中性** (罗其立-简历.pdf 类, 不带公司名 — HR 可见, 见 skill)
  5. 返回 `{ resumeJson, strategy, resumePath, factViolations: [] }`; 有 factViolations 则重生成一次, 再失败抛错
- **不编造纪律**: 每个事实声明可追溯到 base/profile/memory; strategy.risk_notes 记录不确定点

单测 (fake chatFn + fixture resumeBase + fake memoryFacts): 正常定制 / 数字越界拦截重生成 / 不可变字段篡改恢复 / style_hint 影响 positioning。commit `feat(resume): customize_resume orchestrator with fact boundary`。

## Task C: 附件库管理 (headed 实测 + 单测)

**依据 skill `boss-resume-attachment`**: 个人中心→附件管理, 3 槽上限, 删除不影响已发副本, 删旧→传新→计数变化。skill 里的文本锚点仅流程参照, **必须 headed 实测回填真实 selector**。

**文件:** 建 `src/boss/attachment_library.js`, `scripts/verify-attachment-dom.mjs`; 改 selectors.js

1. verify 脚本: headed → 头像→个人中心 → dump 附件管理面板 DOM (计数 x/3 文本、每文件行的 ⋮ 菜单、"+"上传菜单、上传 modal、删除确认弹窗)。写 data/logs/
2. `listAttachments(page)` → `[{name, slot, updatedAt}]` + 读计数 x/3
3. `uploadAttachment(page, filePath, {dryRun, approved})`: "+"→上传简历→modal→filechooser/setInputFiles (原生框绕过); 满 3 槽先删最旧非常驻槽; dryRun 输出计划
4. `deleteAttachment(page, {slot|name}, {approved})`: ⋮→删除→确认弹窗"确定"; 等"删除成功"toast
5. 槽策略: 槽 1 常驻通用简历不删, 槽 2/3 轮换定制
6. 单测走 fixture HTML (从 verify dump 取材) + dryRun 计划断言
7. commit `feat(boss): attachment library CRUD (3-slot rotation)`

**锁冲突**: 此 Task 的 verify/实测需浏览器全局锁; 若 backfill 或 cron 正跑会 BrowserBusyError, 等空档。

## Task D: 聊天页从库选发 + 重写 resume_sender (headed 实测)

**录屏未覆盖此段**, 必须 headed 实测。旧 resume_sender 的聊天页 attach selector 全废。

**文件:** 重写 `src/modules/resume_sender.js`; 改 verify 脚本覆盖聊天页

1. verify: headed 进一个聊天会话 → dump "发送附件简历"入口 (聊天工具栏的附件/简历按钮) → 点开后的"从附件库选择"面板 → 选中+发送交互
2. 重写 `sendResumeFromLibrary(page, { conversation, attachmentName, message, dryRun=true, approved=false })`:
   - dryRun → 输出计划步骤 (进会话/选简历/发送)
   - approved → 进会话 (P1 chat_reader 的 conv 定位复用) → 打开简历发送面板 → 选中目标附件 → 确认发送 → 等发送回执消息
   - 保留 dryRun 默认 + approved 门 (不可逆红线)
3. 单测 fixture + dryRun 计划断言; commit `feat(boss): send resume from attachment library (rewrite resume_sender)`

## Task E: runChat 触发集成 + 验收

**触发信号 (见 memo #71):** HR 索简历 = 系统卡片"我想要一份您的附件简历"/"对方请你发送附件简历", 或 HR 文本"发我简历/看看你简历"。

**文件:** 改 `src/workflows.js` (runChat), `src/cli.js`, `config.json`

1. runChat 读到新 HR 消息时, LLM/规则分类是否"简历请求"; 命中且 job 已关联 (P1 的 linkConversationToJob) →:
   - customizeResume(job, research from jobs.research_json) → docx
   - uploadAttachment (dryRun 默认) → sendResumeFromLibrary (dryRun 默认)
   - 状态 replied→resume_sent (updateJobStatus 加转移); messages.action_taken='resume_sent'; 飞书通知用户 + 附简历副本
2. config 开关 `resume: { autoSend: false }` (默认关, 只出 dry-run 计划 + 飞书推给用户看); 真实发送需显式开
3. cli `resume-send --conv <key> [--send]` 手动触发单会话真实发送 (--send=approved, 缺省 dry-run)
4. **验收 (dry-run 优先)**: 
   - dry-run: 对周女士@广州彩集 (真实索简历会话) 跑全链路, 核对生成的定制简历内容 (含 JD 关键词/无编造) + 计划步骤 + 飞书收到副本
   - **真实发送: 用户在场时**, 选一个低风险会话 `resume-send --conv <key> --send`, 人工核对 Boss 附件库出现新简历 + HR 收到
5. 验收日志 data/logs/p3-acceptance; memory_remember 里程碑 (tags src:codex)

commit `feat: reply-triggered resume customization + send (dry-run default)`

## 自检清单

- [ ] 简历定制无编造 (fact_utils 校验每个数字/事实有来源)
- [ ] 简历文件名中性 (不暴露定制/公司名)
- [ ] 附件库满 3 槽正确删旧 (不删常驻槽 1)
- [ ] 所有新 selector 有 verify dump 佐证
- [ ] dryRun 默认; 真实发送需 approved + config 开关 + 用户在场
- [ ] `node --test --test-concurrency=1 test/` 全绿
- [ ] 老库自动迁移无损
