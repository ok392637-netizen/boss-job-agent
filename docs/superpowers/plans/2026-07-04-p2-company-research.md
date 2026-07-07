# P2 实施计划: 二筛背调 + 挂羊头证据链 + 转化优化

> **执行方: Codex (gpt-5.5)**, 按 Task 分批派活 (每批独立可提交, 参照 P1 纪律)。
> Spec: `docs/superpowers/specs/2026-07-03-boss-job-agent-v2-design.md`; P1 结论见 claude-memo #71。

**Goal:** 给筛选装上证据链 — 公司背调三层信号 + LLM 综合判定挂羊头/风险分, 同时用 HR 活跃度过滤和文案增强攻 0/46 转化问题。

**Architecture:** scan 改两段: ①现有 JD 筛 (便宜, 先杀明显不合格) → ②通过者进背调 (贵, 浏览器采集+LLM评估) → 终判。背调结果缓存于新表 `company_intel` (公司维度, 30 天 TTL), 同一公司多岗位复用, P3 简历风格直接取用。

**风控铁律 (同 P1):** 只经 src/browser.js (patchright); humanDelay 全程; assertPageSafe 每次导航后 (Boss 页面); 新 selector 必须先 verify 脚本实测 dump; Baidu/天眼查是新站点 — 遇验证码/风控页直接降级跳过并标记, **绝不重试硬闯**。

---

## 新表 (db.js SCHEMA 追加)

```sql
CREATE TABLE IF NOT EXISTS company_intel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL UNIQUE,
  boss_json TEXT,      -- 公司主页: 在招岗位列表/规模/融资/行业
  search_json TEXT,    -- 搜索口碑: 命中条目 [{query, title, snippet}]
  tyc_json TEXT,       -- 天眼查: 成立年限/注册资本/风险数 (best-effort)
  degraded TEXT,       -- 逗号分隔的降级来源: "search,tyc"
  eval_json TEXT,      -- LLM 综合: {company_score, red_flags[], bait_and_switch, style_hint, summary}
  fetched_at TEXT DEFAULT (datetime('now','localtime'))
);
```

jobs 表加列 (ALTER TABLE ... ADD COLUMN, 需 try/catch 兼容已有列): `company_score INTEGER`, `research_json TEXT` (该岗位维度的终判快照)。

## Task A: Boss 站内公司情报采集

**文件:** 建 `src/boss/company_page.js`, `scripts/verify-company-dom.mjs`; 改 `src/boss/selectors.js`, `src/db.js`
1. verify 脚本: 从 jobs 表取 3 个真实 job url → 打开详情页 → dump "公司主页"入口链接 DOM → 进公司主页 dump: 在招岗位列表项 (标题/薪资)、公司规模/融资/行业字段、"在招职位数"。写 data/logs/
2. 实测后定 selector, 实现 `fetchCompanyIntel(page, {companyUrl|jobUrl})` → `{jobsPosted:[{title,salary}], jobCount, scale, funding, industry, hrActiveHint}`; 全程 humanDelay + assertPageSafe
3. db.js: company_intel 表 + `getCompanyIntel(db, company)` / `saveCompanyIntel(db, company, patch)` (patch 合并非空字段, 刷新 fetched_at)
4. 单测: 表迁移幂等 + patch 合并语义 (内存库); fetch 用 fixture HTML (存 test/fixtures/pages/company-*.html, 从 verify dump 取材)
5. commit `feat(research): boss company page intel + company_intel table`

**在招岗位画像是挂羊头第一信号**: 招"AI工程师"但在招 30 岗 28 个是销售/电销/地推 → 强红旗。列表必须全量抓 (翻页最多 2 页即可)。

## Task B: 搜索口碑 + 天眼查 (降级层)

**文件:** 建 `src/research/web_search.js`, `src/research/tianyancha.js`, `scripts/verify-search-dom.mjs`
1. 搜索引擎用 **Baidu** (国内直连, 不依赖代理): 每公司 3 个 query — `"{company}" 骗局`, `"{company}" 培训贷 押金`, `"{company}" 工作 怎么样`。verify 脚本实测结果项 selector (标题+摘要); 遇百度验证码页 → 返回 degraded, 不重试
2. 结果清洗: 只留标题/摘要含公司名的条目, 每 query 最多 5 条; query 间 humanDelay 8-20s
3. 天眼查: 搜索页抓第一条匹配 → 成立年限/注册资本/自身风险数; 任何异常 (登录墙/验证码/结构变化) → degraded, 静默跳过。**明确预期: 这层大概率经常降级, 允许**
4. 两模块统一返回 `{data, degraded: boolean, reason?}`; 写入 company_intel 对应列 + degraded 字段
5. 单测用 fixture HTML; commit `feat(research): baidu reputation search + tianyancha best-effort`

## Task C: LLM 综合评估 + 两段筛选集成 + 转化优化

**文件:** 建 `src/research/evaluate.js`; 改 `src/pipeline/screen.js`, `src/pipeline/materials.js`, `src/workflows.js` (runScan), `src/config.js`, `config.json`
1. `evaluateCompany(intel, job)` → LLM (复用 src/llm.js) 输出 `{company_score 0-100, red_flags[], bait_and_switch: bool+reason, style_hint: "大厂正式"|"初创技术"|"传统稳重"|"未知", summary}`; prompt 要求引用证据 (在招岗位画像矛盾/搜索负面命中/工商异常), 无证据不得扣分, degraded 来源明示"信息缺失"而非负面
2. runScan 两段化: JD 筛 pass → `researchCompany(db, page, job)` (查缓存 30 天内直接用, 否则 Task A/B 采集+评估) → 终判: `company_score < config.screening.companyPassScore (默认40)` 或 `bait_and_switch` → screened_out (原因写 screen_json); 通过 → queued, research_json/company_score 落 jobs
3. **HR 活跃度过滤**: search.js 已抓到活跃度文本 ("在线"/"刚刚活跃"/"2周内活跃"/"本月活跃"...) — 目前混在 hr_name 里, 拆成独立字段 hr_active; scan 时 `半年|年` 级别不活跃 → 直接 screened_out ("HR不活跃"), **这是 0/46 转化最便宜的修复**; 顺带修 hr_name 脏数据 (剥离活跃度后缀)
4. **招呼文案增强** (materials.js): 现模板保留骨架, 注入: JD 原句钩子 (引用 JD 中一句具体要求) + style_hint 调语气 + 硬上限 120 字 + 禁模板腔开头 ("您好我是/看到贵司")。生成后自检: 含具体项目名+含 JD 关键词才通过, 否则重生成一次
5. 单测: 两段流转 (fake chatFn/researchFn) + HR 活跃度过滤 + 文案自检; commit `feat(scan): two-stage screening + hr-activity filter + greeting v2`

## Task D: 存量回填 + 验收

1. cli 加 `research --backfill [--limit N]`: 对 status in (greeted, replied) 的岗位公司跑背调 (缓存感知, 真人节奏), 只写 company_intel + jobs.research_json, **不改这些岗位的 status**
2. 真实跑 46 家回填 (预计 40-60min, 分两批)
3. 验收: ①涂嘉琪@广州信辉企业咨询 必须被判高风险/挂羊头 (已知负样本: 劳务中介伪装招聘); ②抽 10 家人工核 red_flags 是否有证据支撑; ③degraded 比例统计 (天眼查预期高, Baidu 应 <30%)
4. 验收日志写 data/logs/p2-acceptance-<date>.log; memory_remember 里程碑 (tags 含 src:codex)

## Ops (Claude 自办, 不入 Codex 范围)

- boss-scan cron 超时修复: 调 openclaw cron 超时参数或拆分 query 批次
- P2 上线后观察一周: 新 scan 的 pass 率 / greet 转化 / degraded 比例

## 自检清单 (每 Task 完成过一遍)

- [ ] 新站点 (Baidu/天眼查) 遇风控只降级不硬闯
- [ ] 所有新 selector 有 verify dump 佐证
- [ ] company_intel 缓存生效 (同公司二次 research 不再开浏览器采集)
- [ ] `node --test test/` 全绿
- [ ] 老库打开自动迁移, jobs 既有数据无损
