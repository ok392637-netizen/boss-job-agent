# boss-job-agent

一个本地运行的求职自动化 Agent（个人作品集项目）：基于 headed Chrome（patchright）、DeepSeek、SQLite 和飞书，端到端完成 **岗位搜索 → LLM 匹配度筛选 → 求职材料生成 → 招呼（默认 dry-run）→ 回复监控通知**。

> ⚠️ 说明：本项目为个人学习 / 作品集用途，演示「把招聘流程拆解为可自动化链路」的工程实现。默认 `dry-run`，不会自动对外发送消息；请在遵守目标平台服务条款的前提下、仅用于自己的账号。仓库内不含任何真实凭据或个人数据。

## 准备配置

1. 复制示例并填入你自己的信息：
   - `profile/profile.example.md` → `profile/profile.md`
   - `profile/resume-base.example.json` → `profile/resume-base.json`
   - `.env.example` → `.env`（填入 `DEEPSEEK_API_KEY`）
2. 按需修改 `config.json`（城市代码、搜索关键词、`lark.userOpenId` 等）。

## 首次使用

1. 安装依赖：

   ```powershell
   npm install
   ```

2. 首次使用必须先登录。该命令打开 headed Chrome，浏览器数据保存在 `data/browser-profile`：

   ```powershell
   node src/cli.js login
   ```

   在浏览器中完成 Boss 扫码登录。未登录时真实搜索会被 Boss 跳转到登录页，`scan` 会发送飞书提示“需要扫码登录后才能扫描岗位”并退出。

3. 可选：为当前飞书用户补充文件上传权限，以便优先用用户身份直发简历：

   ```powershell
   lark-cli auth login --scope "im:resource:upload im:resource"
   ```

   未完成该授权时，程序会自动尝试 bot 身份上传 DOCX。若 user 和 bot 均失败，则发送 markdown 降级通知，包含 `📎 简历已生成: <本地绝对路径>` 和失败原因，不会让 `poll` 整体失败。

4. 扫描并生成材料：

   ```powershell
   npm run scan
   ```

5. 检查状态：

   ```powershell
   npm run status
   ```

6. 默认只做 dry-run，不会发送 Boss 消息：

   ```powershell
   npm run greet -- --limit 2
   ```

7. 只有确认页面和材料无误后，才显式解除 dry-run：

   ```powershell
   npm run greet -- --limit 2 --no-dry-run
   ```

## 命令

| 命令 | 说明 |
|---|---|
| `npm run login` | 打开 Chrome 并等待扫码登录 |
| `npm run scan` | 搜索岗位、真实调用 LLM 筛选、生成文案和 DOCX |
| `npm run greet -- --limit N` | 对 queued 岗位执行 dry-run |
| `npm run poll` | 拉取回复并推送介绍文本与 DOCX 到飞书 |
| `npm run status` | 输出状态计数、今日招呼数和熔断状态 |
| `npm run test-notify` | 实测飞书文本和 DOCX 文件链路 |
| `npm run run` | 顺序执行 scan、greet、poll |

所有数据库命令均可通过 `--database <path>` 指定独立数据库，例如：

```powershell
node src/cli.js --database data/acceptance.db status
```

## 配置

主要配置位于 `config.json`：

- `search`：城市、关键词和单次扫描上限。
- `search.maxJobsPerScan`：每个关键词最多读取的岗位数，默认 `8`。
- `scan.jobDelaySec`：相邻详情页访问之间随机等待，默认 `18-50` 秒。
- `scan.queryDelaySec`：不同搜索关键词之间随机等待，默认 `30-90` 秒。
- `screening.passScore`：LLM 筛选通过分数。
- `greeting.dryRun`：必须保持默认 `true`。真实发送只能修改配置或显式传入 `--no-dry-run`。
- `greeting.dailyLimit`：每日真实或 dry-run 招呼上限。
- `greeting.activeHours`：允许执行招呼的本地小时区间。
- `greeting.minDelaySec/maxDelaySec`：岗位间随机等待。
- `lark.userOpenId`：飞书通知接收人。
- `llm.model`：已实测可用的 `deepseek-v4-pro`。

DeepSeek key 优先从项目根目录 `.env` 的 `DEEPSEEK_API_KEY` 读取；未配置时回退到用户主目录下的 `~/.openclaw/openclaw.json`（`%USERPROFILE%\.openclaw\openclaw.json`）的 `env.DEEPSEEK_API_KEY`。代码会处理 UTF-8 BOM。

## 扫描节奏与风控

- 单次 scan 不要贪多。默认每个关键词最多读取 8 个岗位，并在岗位详情和关键词之间随机等待；详情页还会停留阅读并轻微滚动。运行较慢是护号策略。
- 岗位较多时应拆成多次 scan，减少关键词数量，并在不同批次之间留出冷却时间。
- 搜索或详情页触发安全验证时，程序保持 headed Chrome 打开，并发送飞书通知：

  ```text
  ⚠️ Boss 触发安全验证, 请在打开的浏览器窗口完成验证 (滑块/短信), 我会等最多 10 分钟
  ```

- 在打开的 Chrome 中人工完成滑块或短信验证。页面恢复登录态后，程序发送“Boss 安全验证已通过, 继续”并继续当前 scan。
- 10 分钟内未完成验证会写入熔断状态、发送告警，并以退出码 `2` 停止。
- 登录态丢失、无法访问、验证码文本或滑块 iframe 仍会触发保护性停止。
- 熔断状态写入数据库 `meta.circuit_open`，不会自动恢复。
- 人工确认登录和页面状态恢复后，执行 `node src/cli.js circuit-reset` 清除熔断。
- `greet` 默认 dry-run，并在发送按钮点击前停止。
- 不要并行启动多个浏览器实例。程序使用 `data/browser-profile.lock` 串行访问 persistent profile。
- Inbox 当前未出现的未读标记、岗位标题和会话链接仍保留 TODO，需在对应 UI 状态首次出现后核实。

## 计划任务

Windows 计划任务名为 `BossJobAgent-Poll`，每 15 分钟运行：

```powershell
node src/cli.js poll
```

任务创建后默认禁用。首次登录并确认 `poll` 可用后再手工启用：

```powershell
schtasks /change /tn "BossJobAgent-Poll" /enable
```
