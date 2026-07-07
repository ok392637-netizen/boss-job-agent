import { launchBrowser } from "../src/browser.js";
import { searchReputation } from "../src/research/web_search.js";

const ctx = await launchBrowser({ userDataDir: "data/probe-profile" });
try {
  const page = await ctx.newPage();
  for (const company of ["广州信辉企业咨询", "凡岛"]) {
    const r = await searchReputation(company, { page });
    console.log(`\n=== ${company} ===`);
    console.log("engine:", r.engine, "degraded:", r.degraded, "reason:", r.reason ?? "-", "count:", r.data.length);
    for (const item of r.data.slice(0, 4)) {
      console.log(`  · [${item.query.replace(company, "…")}] ${item.title.slice(0, 40)} | ${item.snippet.slice(0, 50)}`);
    }
  }
} finally {
  await ctx.close();
}
