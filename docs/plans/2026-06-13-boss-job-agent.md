# Boss直聘求职 Agent (boss-job-agent) Implementation Plan

> **执行者**: Codex (gpt-5.5)。本计划由 Claude (决策层) 编写, 含架构、契约、prompt、验收标准。实现代码由 Codex 编写。
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个本地求职 Agent: 在 Boss直聘筛选岗位 → DeepSeek 评估 JD → 为每岗生成定制招呼语/长版自我介绍/定制简历 docx → 限量拟人化批量打招呼 → 轮询招聘者回复并推送飞书 (含该岗位的介绍文+简历文件), 回复由用户人工处理。

**Architecture:** Node.js CLI 单体 (无服务端), Playwright persistent context 操控真实 Chrome 访问 zhipin.com, better-sqlite3 做岗位 pipeline 状态机, DeepSeek API (走 OpenClaw 同款配置) 做全部文本智能, docx 库渲染定制简历, 飞书通知 shell-out 到已认证的 lark-cli。安全第一: 默认 dry-run, 每日限量, 随机节奏, 验证码/掉登录即熔断告警。

**Tech Stack:** Node 24 (ESM), playwright, better-sqlite3, docx (npm), commander。无 Python 依赖。

**项目路径:** `C:\Users\bokily\dev\boss-job-agent`

---

## 0. 环境事实 (已验证, 直接使用)

| 事实 | 值 |
|---|---|
| Node | v24.15.0 |
| DeepSeek key | `C:\Users\bokily\.openclaw\openclaw.json` → `env.DEEPSEEK_API_KEY`。**文件带 UTF-8 BOM**, JSON.parse 前必须 strip BOM |
| DeepSeek endpoint | `https://api.deepseek.com` (openai-completions 协议), model `deepseek-v4-pro`; 若 400 invalid model 则 fallback `deepseek-chat`, 以实测为准 |
| lark-cli | v1.0.53 已认证, bot + user 双身份 ready |
| 飞书收件人 (用户本人) | open_id `ou_your_lark_open_id_here` |
| 飞书发文本 | `lark-cli im +messages-send --user-id ou_8daf... --text "..."` (具体 flag 用 `lark-cli im +messages-send --help` 核实; 该命令支持 text/markdown/media) |
| 飞书发文件 (简历 docx) | 同命令 media 形态; 若 docx 直发不支持, 降级为消息内附本地路径 |
| 广州 city code (Boss) | 101280100 |
| 网络 | 本机直连国内站点正常; FlClash TUN 代理在跑, zhipin.com/api.deepseek.com 均为直连规则, 不需要特殊处理 |

## 1. 文件结构

```
boss-job-agent/
  package.json            # ESM, scripts: test / scan / greet / poll / login / status
  config.json             # 用户可调参数 (见 §2)
  profile/
    profile.md            # 个人经历档案 (已存在, 只读, 生成素材唯一事实来源)
    resume-base.json      # 结构化基础简历 (Task 1 从 §9 附录建出)
  src/
    config.js             # 读 config.json + openclaw.json(BOM!) 提取 DeepSeek key; 导出冻结配置
    db.js                 # better-sqlite3 初始化 + jobs/meta 表 + 状态机操作函数
    llm.js                # DeepSeek chat 封装: chat(messages, {json}) → 文本/解析后JSON; 重试2次; 超时60s
    notify.js             # lark-cli 封装: notifyText(md), notifyFile(path, caption)
    browser.js            # Playwright persistent context (data/browser-profile), headed, channel chrome→chromium fallback; humanDelay(min,max); 反检测基础 (去 navigator.webdriver 等)
    boss/
      selectors.js        # zhipin.com 全部选择器/URL 集中此文件, 每条注释用途 (DOM 变更只改这)
      login.js            # ensureLoggedIn(page): 检测登录态; 未登录→打开扫码页+飞书通知用户扫码+等待(10min超时)
      search.js           # searchJobs(filters): 搜索列表页抓 job cards; fetchJD(job): 进详情页抓完整 JD
      greet.js            # greetJob(page, job, text, {dryRun}): 打开岗位→点沟通→发定制招呼语; 内置熔断检测
      inbox.js            # pollReplies(page): 消息列表页找有新回复的会话, 返回 [{jobMatchKey, hrName, lastMsg}]
    pipeline/
      screen.js           # screenJob(job): LLM 评分 (prompt 见 §4.1) → {score, verdict, bait, reasons}
      materials.js        # genMaterials(job): LLM 生成 (prompt 见 §4.2) → {greetShort, introLong} + 事实校验
      resume.js           # genResume(job): LLM 定制 (prompt 见 §4.3) → JSON → docx 渲染 → data/resumes/<id>-<company>.docx
    cli.js                # commander 入口: login/scan/greet/poll/status/test-notify/run
  test/
    fixtures/jds/         # 3 个 fixture JD (见 §5)
    *.test.js             # node:test, 不引第三方测试框架
  data/                   # gitignore: agent.db, browser-profile/, resumes/, logs/
  docs/plans/             # 本文件
  README.md
```

## 2. config.json (初始值)

```json
{
  "search": {
    "city": "101280100",
    "queries": ["AI Agent", "AI 应用", "AI 训练师", "自动化 工作流", "提示词工程"],
    "salary": "3-8K",
    "experienceFilter": "在校/应届",
    "maxJobsPerScan": 60
  },
  "screening": { "passScore": 60 },
  "greeting": {
    "dryRun": true,
    "dailyLimit": 30,
    "activeHours": [9, 21],
    "minDelaySec": 25,
    "maxDelaySec": 90
  },
  "poll": { "intervalMin": 15 },
  "lark": { "userOpenId": "ou_your_lark_open_id_here" },
  "llm": { "model": "deepseek-v4-pro", "fallbackModel": "deepseek-chat" }
}
```

**硬规则**: `dryRun` 默认 true; 任何代码路径不得默认改成 false。真实发送只能由用户改 config 或 `--no-dry-run` 显式触发。

## 3. 数据库 (data/agent.db)

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,          -- boss 岗位 id (URL 中提取), 提不到则 url 的 sha1 前 12 位
  url TEXT, title TEXT, company TEXT, salary TEXT, city TEXT,
  hr_name TEXT, jd TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  -- discovered → screened_out | queued → greeted → replied → notified ; 任意态可 → error
  score INTEGER, screen_json TEXT,        -- LLM 筛选完整输出
  greet_short TEXT, intro_long TEXT, resume_path TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  greeted_at TEXT, replied_at TEXT, notified_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- meta: greet_count_<YYYY-MM-DD> = 当日已发数, 熔断标志 circuit_open = 时间戳
```

## 4. LLM Prompts (定稿, 原样实现, system prompt 均为中文)

### 4.1 筛选 (screen.js)

system:
```
你是求职岗位筛选器。根据候选人画像评估岗位匹配度, 并识别"挂羊头卖狗肉"岗位 (职位名与 JD 实际内容不符, 如名为 AI 工程师实为电话销售/地推/卖课/培训贷)。只输出 JSON。
```
user (模板):
```
## 候选人画像
{profile.md 全文}

## 岗位
标题: {title} | 公司: {company} | 薪资: {salary} | 城市: {city}
JD 全文:
{jd}

输出 JSON: {"score": 0-100 匹配分, "bait": true/false 是否挂羊头, "bait_reason": "", "match_reasons": ["",""], "concerns": ["",""], "verdict": "pass"|"reject"}
判定规则: score>=60 且 bait=false 才 pass。候选人是28届在校生找实习/兼职/低门槛全职, 要求 3 年以上经验或明确只要全职坐班且与在校冲突的岗位降分。
```

### 4.2 招呼语 + 长版自我介绍 (materials.js)

system:
```
你是求职文案生成器。基于候选人画像为特定岗位生成两段文案。硬约束: 只能引用画像中明确存在的经历/技能/数据, 严禁编造、夸大或虚构任何事实、数字、公司名、项目。语气真诚、具体、不油腻、不堆砌敬语。只输出 JSON。
```
user (模板):
```
## 候选人画像
{profile.md 全文}

## 目标岗位
{title} @ {company}
JD: {jd}

生成 JSON:
{
 "greet_short": "首条招呼语, 100-150字: 一句身份 + 引用JD中的1个具体要求并对应画像中最强的1个匹配点 + 提1个具体项目名。不要'您好我对贵司岗位很感兴趣'这类空话开头。",
 "intro_long": "长版自我介绍, 500-700字, 5段: ①身份一句话(28届本科在读, 方向 AI Agent/Vibe Coding/自动化) ②为什么对这个岗位感兴趣(必须引用JD原文细节) ③从画像挑与本岗最相关的2-3个项目展开 ④三点匹配(JD要求↔自身经历逐条对应) ⑤意愿表态+期待沟通"
}
```

**事实校验 (代码层, 非 LLM)**: 生成后检查 — intro_long 必须包含 profile.md 中至少 1 个项目关键词 (`n8n`/`记忆系统`/`Hacker News`/`OpenClaw`); 不得包含 profile 中不存在的百分比数字 (允许集: 40%); 不得出现 "硕士|博士|3年经验|5年" 字样。校验失败重新生成 1 次, 再失败标 error。

### 4.3 定制简历 (resume.js)

system:
```
你是简历定制器。输入候选人基础简历 JSON 和目标岗位 JD, 输出同 schema 的定制简历 JSON。允许: 重写个人优势使其呼应 JD 关键词、调整项目排序(最相关在前)、改写项目描述措辞突出与 JD 相关的方面、技能条目重排。禁止: 新增任何经历/技能/数字, 删除教育经历, 修改任何日期/公司名/学校/联系方式。只输出 JSON。
```
user: `基础简历: {resume-base.json}\n目标岗位: {title} @ {company}\nJD: {jd}\n输出定制后的完整简历 JSON (schema 不变)。`

**渲染**: docx 库, 单页简洁排版: 顶部姓名+联系方式行 → 个人优势 → 工作经历 → 项目经历 → 教育经历 → 专业技能。中文字体 `Microsoft YaHei`, 标题加粗 14pt, 正文 10.5pt。文件名 `data/resumes/{jobId}-{company净化}.docx`。
**渲染后校验**: 文件可被 unzip, `word/document.xml` 含 "罗其立" 和 "广州中医药大学"。

## 5. 测试 Fixtures (test/fixtures/jds/, Task 2 创建)

1. `good-match.json` — "AI 应用实习生" 真实风格 JD: 要求会用 LLM API、prompt 调优、n8n/dify 自动化优先、在校可实习。期望: pass, score>=70, bait=false
2. `mismatch.json` — "高级算法工程师": 硕士+3年、精通 CUDA/分布式训练。期望: reject (score<60)
3. `bait.json` — 标题"AI训练师助理", JD 实际内容: 无需经验、带薪培训、考核后上岗、涉及缴纳培训费用、电话邀约客户。期望: bait=true, reject

## 6. 安全与熔断 (greet.js / inbox.js 公用)

- 每次页面动作间 `humanDelay(min,max)` 随机等待; 打招呼间隔 25-90s 随机
- 发送前检查: 当日计数 < dailyLimit; 当前小时在 activeHours 内; circuit_open 未设置
- 每次导航后检测熔断条件: URL 含 `safe/verify`、页面含 "安全验证"/"验证码"/滑块 iframe、或登录态丢失 → 设 meta.circuit_open, 飞书告警 "⚠️ Boss直聘触发风控/掉线, 已停止, 需人工处理", 进程退出码 2
- dry-run 模式: 走完整流程直到"点击发送"前一步, 记日志 `[DRY-RUN] would greet {company} {title}: {greet_short}`, 状态仍推进到 greeted (便于测全链路), 但 meta 计数标 dry 前缀

## 7. CLI 行为契约

| 命令 | 行为 |
|---|---|
| `login` | 打开 headed 浏览器到 zhipin.com 登录页, 飞书通知"请扫码", 轮询登录态 (10min 超时), 成功后飞书确认 |
| `scan` | ensureLoggedIn(未登录则只抓登出可见部分并警告) → 按 queries 逐个搜索抓列表+JD → 去重入库 → screen → pass 的依次 genMaterials + genResume → status=queued。结束输出汇总并飞书推送: 新增X, 通过Y, 拒Z (含通过岗位列表) |
| `greet [--limit N] [--no-dry-run]` | 取 queued, 按 §6 约束逐个发送, 每发一个状态→greeted |
| `poll` | 拉消息列表, 新回复匹配到 greeted 岗位 → 飞书推送卡片文本: `💬 {company}|{title}|HR {hr_name}: {回复内容}` + intro_long 全文 + 简历 docx 文件 → status=notified。未匹配到的会话也通知 (标"未知岗位") |
| `status` | 各状态计数 + 今日已 greet 数 + 熔断状态 |
| `test-notify` | 发一条测试飞书消息+随便一个 docx |
| `run` | scan → greet → poll 顺序执行 (给计划任务用) |

## 8. Tasks

### Task 1: 脚手架 + config + db + llm + notify
- Create: package.json, .gitignore, config.json, src/config.js, src/db.js, src/llm.js, src/notify.js, profile/resume-base.json (从 §9 附录), test/config.test.js, test/db.test.js
- [ ] git init + npm init + 装依赖 (playwright, better-sqlite3, docx, commander)
- [ ] config.js: 处理 openclaw.json 的 BOM; key 缺失时报错信息要写明文件路径
- [ ] llm.js 真连一次 DeepSeek 验证 model id (写一个 `node src/llm.js --selftest` 入口)
- [ ] notify.js 真发一条测试消息到飞书验证
- [ ] 测试: `node --test` 全绿; commit `feat: scaffold + config/db/llm/notify`

### Task 2: pipeline 三件套 (screen / materials / resume)
- Create: src/pipeline/screen.js, materials.js, resume.js, test/fixtures/jds/*.json, test/pipeline.test.js
- [ ] 实现 §4 三个 prompt + §4.2 事实校验 + §4.3 docx 渲染与校验
- [ ] 测试 (真连 LLM): 3 个 fixture 按 §5 期望断言; resume 渲染出的 docx 通过 unzip 校验
- [ ] commit `feat: screening + materials + resume pipeline`

### Task 3: 浏览器层 (browser / selectors / login / search)
- Create: src/browser.js, src/boss/selectors.js, src/boss/login.js, src/boss/search.js
- [ ] persistent context + 反检测 (navigator.webdriver=undefined, 真实 UA, headed)
- [ ] selectors.js 先按已知 DOM 写 (列表页 `li.job-card-wrapper` 等), **然后实际打开 zhipin.com 搜索页 (登出态可见) 逐个验证并修正**
- [ ] search.js 登出态 e2e: 真实抓到 >=1 个岗位卡片字段齐全 (title/company/salary/url)
- [ ] login.js 实现扫码等待逻辑 (本任务只测"检测到未登录"分支)
- [ ] commit `feat: browser layer + boss search`

### Task 4: greet + inbox + 熔断
- Create: src/boss/greet.js, src/boss/inbox.js, test/greet.test.js
- [ ] §6 全部安全逻辑; 熔断检测函数单测 (用本地 HTML fixture 模拟验证码页)
- [ ] greet dry-run e2e: 手工插一条 queued 假岗位 (url 指向真实搜索到的某岗位), dry-run 走到发送前一步不点发送
- [ ] inbox.js: 消息列表 DOM 同样写进 selectors.js (登录态才能真验, 留 TODO 标注待首次登录后核实)
- [ ] commit `feat: greet + inbox + circuit breaker`

### Task 5: cli.js 集成 + 计划任务 + README
- Create: src/cli.js, README.md
- [ ] §7 全部命令; `run` 串联
- [ ] 注册 Windows Scheduled Task `BossJobAgent-Poll` (每 15min 执行 `node src/cli.js poll`), **创建即禁用** (`schtasks /create ... /f` 后 `/change /disable`), 用户首次登录后再启用
- [ ] README: 快速开始 (login → scan → greet 解除 dry-run 的步骤)、config 说明、风控注意事项
- [ ] 全量 `node --test` 绿 + `node src/cli.js status` / `test-notify` 实测
- [ ] commit `feat: cli + scheduled task + docs`

### Task 6: 全链路 dry-run 验收
- [ ] 真实流程: `scan` (登出态, 限 1 个 query, maxJobs 5) → 入库+筛选+生成材料+生成简历 docx → `greet --limit 2` (dry-run) → `status` 显示正确 → 飞书收到 scan 汇总
- [ ] 把运行日志和产物路径写进 `docs/ACCEPTANCE.md`
- [ ] commit `test: e2e dry-run acceptance`

## 9. 附录: 基础简历全文 (resume-base.json 数据源)

```
罗其立 | 男 | 19岁 | 韶关 | 13800138000 | resume@example.com
期望: 3-8K | 广州
教育: 广州中医药大学 本科 中药资源与开发 2024-2028 | 证书: CET-4
个人优势: 广州中医药大学在读, 跨专业背景, 快速上手能力强。熟练使用 Cursor、Claude Code 等 AI 编程工具, 擅长 Vibe Coding 工作方式, 能通过自然语言驱动 AI 快速产出可运行脚本与自动化工作流; 深度使用 ChatGPT、Claude 等主流大模型, 对 AI Agent 逻辑与能力边界有直观理解。有完整的 n8n 自动化工作流设计与落地经验, 善于拆解流程痛点并用自动化手段消灭机械重复劳动。自驱力强。
工作经历: 深圳市诸葛瓜科技有限公司 Java 2026.01-2026.04 — AI 记忆系统模块设计/开发/优化; 后端接口、数据存储与调用逻辑; 功能迭代、问题排查、系统维护。
项目1: 基于n8n的抖音热点自动化监控系统 (个人, 2025.09-2026.01) — 每日抓取抖音热榜辅助选题; n8n 编排全链路, 集成 AI 生成分析报告并推送; 选题效率提升40%, 数据响应缩短至10分钟内。
项目2: AI记忆系统后端开发 (Java, 2026.01-2026.06) — 面向AI应用场景的记忆系统后端; 模块设计、接口开发、数据存储与调用逻辑, 支持多轮交互信息记录/读取/调用; 功能迭代与问题排查。
项目3: Hacker News 智能新闻摘要工作流 (2025.09-2026.01) — 每日自动获取技术新闻, AI 生成中文摘要发邮箱; 每日节省30分钟。
专业技能: AI产品理解 / 需求分析 / 后端基础(Java) / AI工具(ChatGPT、Claude、Cursor、Claude Code、Vibe Coding) / n8n 自动化工作流 / 学习与执行力。
```

resume-base.json schema: `{name, gender, age, hometown, phone, email, expect:{salary,city}, education:[{school,degree,major,period}], certificates:[], strengths:[string], work:[{company,role,period,bullets:[]}], projects:[{name,tag,period,bullets:[]}], skills:[{name,desc}]}`
