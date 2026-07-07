// 反爬实测: 哪个搜索引擎能在 patchright 下返回真实结果 (不空想, 跑数据)
// 测试公司: 广州信辉企业咨询 (已知劳务中介)
import { launchBrowser } from "../src/browser.js";
import { humanDelay } from "../src/browser.js";

const COMPANY = "广州信辉企业咨询";
const targets = [
  { name: "bing-cn", url: `https://cn.bing.com/search?q=${encodeURIComponent(COMPANY + " 骗局")}`, resultSel: "#b_results li.b_algo, .b_algo" },
  { name: "sogou", url: `https://www.sogou.com/web?query=${encodeURIComponent(COMPANY + " 骗局")}`, resultSel: ".results .vrwrap, .rb" },
  { name: "baidu-direct", url: `https://www.baidu.com/s?wd=${encodeURIComponent(COMPANY + " 骗局")}`, resultSel: "#content_left .result, .c-container" },
  { name: "360so", url: `https://www.so.com/s?q=${encodeURIComponent(COMPANY + " 骗局")}`, resultSel: "#main .result li, .res-list" },
];

const context = await launchBrowser({ userDataDir: "data/probe-profile" });
try {
  const page = await context.newPage();
  for (const t of targets) {
    const out = { name: t.name };
    try {
      const resp = await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 3000);
      out.status = resp?.status();
      out.finalUrl = page.url();
      out.title = (await page.title()).slice(0, 40);
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "");
      out.captcha = /验证|captcha|wappass|安全验证|滑块|人机|异常/.test(bodyText + out.finalUrl + out.title);
      out.resultCount = await page.locator(t.resultSel).count().catch(() => -1);
      out.firstResult = (await page.locator(t.resultSel).first().innerText({ timeout: 3000 }).catch(() => "")).slice(0, 80).replace(/\s+/g, " ");
    } catch (e) {
      out.error = e.message.slice(0, 60);
    }
    console.log(JSON.stringify(out));
    await humanDelay(4000, 8000);
  }
} finally {
  await context.close();
}
