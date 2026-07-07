# 全链路验收

验收时间：2026-06-13 01:45-01:46（Asia/Shanghai）

## 环境

- Node.js：`v24.15.0`
- LLM：DeepSeek `deepseek-v4-pro`
- 浏览器：Playwright headed Chromium，profile 位于 `data/browser-profile`
- 验收数据库：`data/acceptance.db`
- 验收命令：`npm run acceptance`

## Fixture 全链路

因 Boss 登出态真实搜索被跳转到登录/安全检查页，本次按约定使用 3 个 JD fixture 驱动完整生产 pipeline：

1. 将 `good-match`、`mismatch`、`bait` 三个岗位作为 discovered 数据交给 `runScan`。
2. 真实调用 DeepSeek 筛选岗位、生成沟通材料和定制简历。
3. 对通过岗位执行 `greet --limit 2` 等价流程，使用本地 `greet-editor.html`，保持 dry-run 并在发送按钮点击前停止。
4. 将通过岗位手工置为 replied，模拟 HR 回复。
5. 执行 poll，真实推送回复和 `intro_long` 文本，并发送生成的 DOCX。
6. 校验最终状态和熔断状态。

结果：

- `fixture-good-match`：95 分，状态 `notified`
- `fixture-mismatch`：10 分，状态 `screened_out`
- `fixture-bait`：10 分，`bait=true`，状态 `screened_out`
- 材料字数：`greet_short=138`，`intro_long=662`
- greet：尝试 1 个，`dryRun=true`，`sent=false`
- 最终计数：`notified=1`，`screened_out=2`
- dry-run 当日招呼数：1
- 熔断：closed

运行日志：

`data/logs/acceptance-2026-06-12T17-46-24-726Z.json`

生成简历：

`data/resumes/fixture-good-match-广州智流科技有限公司.docx`（10441 bytes）

## 飞书实测

接收用户：`ou_your_lark_open_id_here`

- 回复和 `intro_long` 文本：user 身份发送成功，消息 ID `om_x100b6df011cda0a4c1d46fb57b3007b`
- 简历 DOCX：user 身份缺少文件上传授权后自动尝试 bot，bot 发送成功，消息 ID `om_x100b6df011da28a4c2539c0af1f752b`
- 文件名：`fixture-good-match-广州智流科技有限公司.docx`

文件发送失败不会使 poll 整体失败。若 user 和 bot 均失败，程序会发送 markdown 降级通知，包含本地绝对路径和失败原因。

## Boss 登出态

真实执行：

```powershell
node src/cli.js --database data/acceptance.db scan --query "AI Agent"
```

Boss 将登出态访问拦截为登录/安全检查，程序识别为 `logged_out`，输出：

```text
需要扫码登录后才能扫描岗位 (logged_out)
```

同时真实发送飞书通知“需要扫码登录后才能扫描岗位”，消息 ID：

`om_x100b6df0602c70a0b2b6a731aa592d9`

## 状态输出

```text
discovered: 0
screened_out: 2
queued: 0
greeted: 0
replied: 0
notified: 1
error: 0
greeted today: 0
dry-run greeted today: 1
circuit: closed
```

## Windows 计划任务

任务 `BossJobAgent-Poll` 已创建并立即禁用：

- 状态：`Disabled`
- 命令：`C:\Progra~1\nodejs\node.exe C:\Users\bokily\dev\boss-job-agent\src\cli.js poll`
- 重复间隔：15 分钟
- 运行用户：`bokily`

首次完成 Boss 扫码登录并确认 poll 可用后，再手工启用。
