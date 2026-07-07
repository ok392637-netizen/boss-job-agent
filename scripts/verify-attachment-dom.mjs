import fs from "node:fs";
import path from "node:path";
import { getOrCreatePage, humanDelay, launchBrowser } from "../src/browser.js";
import { PROJECT_ROOT } from "../src/config.js";
import { deleteMeta, openDatabase } from "../src/db.js";
import { assertPageSafe } from "../src/boss/greet.js";
import {
  ensureLoggedIn,
  waitForSecurityCheckRecovery,
} from "../src/boss/login.js";
import { SELECTORS, URLS } from "../src/boss/selectors.js";
import { listAttachments } from "../src/boss/attachment_library.js";
import { notifyText } from "../src/notify.js";

const MAX_HTML_LENGTH = 3_000;
const logPath = path.join(
  PROJECT_ROOT,
  "data",
  "logs",
  `verify-attachment-dom-${timestampForFile()}.log`,
);
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const lines = [];
const db = openDatabase();
let context;

try {
  context = await launchBrowser({ headless: false });
  const page = await getOrCreatePage(context);

  log(`startedAt=${new Date().toISOString()}`);
  log("safety=readonly dump only; no file chooser, no upload confirm, no delete confirm");

  await page.goto(URLS.home, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await assertSafeOrRecover(page, URLS.home);
  await humanDelay(2_000, 4_000);

  await openPersonalCenter(page);
  await assertSafeOrRecover(page, URLS.recommend);
  await humanDelay(2_000, 4_000);

  await waitForAttachmentPanel(page);
  logSection("attachment-page-url", {
    current: page.url(),
    title: await page.title().catch(() => ""),
  });
  logSection("attachment-list", await listAttachments(page).catch(serializeError));
  logSection("attachment-selector-counts", await selectorCounts(page, attachmentSelectors()));
  logSection(
    "attachment-candidate-samples",
    await candidateSamples(page, attachmentSelectors(), 8, MAX_HTML_LENGTH),
  );
  logSection("attachment-body-summary", await bodySummary(page));

  await runOptionalDump("upload-surface", () => dumpUploadSurface(page));
  await runOptionalDump("delete-surface", () => dumpDeleteSurface(page));
} catch (error) {
  logSection("error", serializeError(error));
  process.exitCode = error.code === "BROWSER_BUSY" ? 75 : 1;
} finally {
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  console.log(logPath);
  if (context) {
    await context.close();
  }
  db.close();
}

async function openPersonalCenter(page) {
  const header = await firstVisible(page, SELECTORS.loggedInHeader, 5_000);
  if (header) {
    await header.hover().catch(() => {});
    await humanDelay(800, 1_500);
  }

  const personalSelectors = [
    "a[ka='header-personal']",
    "a[href*='/web/geek/recommend']",
    "text=个人中心",
  ];
  for (const selector of personalSelectors) {
    const locator = await firstVisible(page, selector, 1_500);
    if (!locator) continue;
    await locator.click();
    await page
      .waitForURL(/\/web\/geek\/recommend/, { timeout: 12_000 })
      .catch(() => {});
    return;
  }

  await page.goto(URLS.recommend, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

async function waitForAttachmentPanel(page) {
  await page
    .getByText("附件管理")
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => {});
}

async function dumpUploadSurface(page) {
  const addButton = await firstVisible(page, SELECTORS.attachmentAddButton, 5_000);
  if (!addButton) {
    logSection("upload-surface", { foundAddButton: false });
  } else {
    await addButton.scrollIntoViewIfNeeded().catch(() => {});
    await addButton.hover().catch(() => {});
    await addButton.click({ timeout: 3_000 }).catch((error) => {
      logSection("upload-add-click", {
        clicked: false,
        message: error.message,
        fallback: "menu DOM will still be dumped; no upload confirm is clicked",
      });
    });
    await humanDelay(1_000, 2_000);
  }
  logSection("upload-menu-counts", await selectorCounts(page, uploadSelectors()));
  logSection("upload-menu-samples", await candidateSamples(page, uploadSelectors(), 8, MAX_HTML_LENGTH));

  const uploadResume = await firstVisible(
    page,
    SELECTORS.attachmentUploadResumeMenuItem,
    3_000,
  );
  if (uploadResume) {
    const text = await uploadResume.innerText().catch(() => "");
    if (/上传附件简历/u.test(text)) {
      logSection("upload-modal-skipped", {
        reason: "candidate is upload-confirm button, not menu item",
        text,
      });
    } else {
      await uploadResume.scrollIntoViewIfNeeded().catch(() => {});
      await uploadResume.click({ force: true, timeout: 3_000 });
      await humanDelay(1_000, 2_000);
      logSection("upload-modal-counts", await selectorCounts(page, uploadModalSelectors()));
      logSection(
        "upload-modal-samples",
        await candidateSamples(page, uploadModalSelectors(), 8, MAX_HTML_LENGTH),
      );
    }
  }

  await closeModalOrMenu(page);
}

async function dumpDeleteSurface(page) {
  const row = await firstNonResidentAttachmentRow(page);
  if (!row) {
    logSection("delete-surface", { foundRow: false });
    return;
  }
  logSection("delete-target-row", await rowSample(row));

  const more = await firstVisibleIn(row, SELECTORS.attachmentMoreButton, 5_000);
  if (!more) {
    logSection("delete-surface", { foundMoreButton: false });
  } else {
    await more.scrollIntoViewIfNeeded().catch(() => {});
    await more.hover().catch(() => {});
    await more.click({ timeout: 3_000 }).catch((error) => {
      logSection("row-menu-click", {
        clicked: false,
        message: error.message,
        fallback: "row menu DOM will still be dumped; delete is still cancelled if opened",
      });
    });
    await humanDelay(1_000, 2_000);
  }
  logSection("row-menu-counts", await selectorCounts(page, rowMenuSelectors()));
  logSection("row-menu-samples", await candidateSamples(page, rowMenuSelectors(), 8, MAX_HTML_LENGTH));

  let deleteItem = await firstVisible(page, SELECTORS.attachmentDeleteMenuItem, 3_000);
  if (!deleteItem) {
    const exactDelete = page.locator(".resume-attachment .annex-operate-delete, .delete-entry").first();
    if ((await exactDelete.count().catch(() => 0)) > 0) {
      deleteItem = exactDelete;
      logSection("delete-force-click", {
        reason: "delete menu item exists in attachment row but is not visible to normal click",
        selector: ".resume-attachment .annex-operate-delete, .delete-entry",
      });
    }
  }
  if (!deleteItem) {
    await closeModalOrMenu(page);
    logSection("delete-dialog", { foundDeleteItem: false });
    return;
  }
  await deleteItem.scrollIntoViewIfNeeded().catch(() => {});
  await deleteItem.click({ force: true, timeout: 3_000 });
  await humanDelay(1_000, 2_000);
  logSection("delete-dialog-counts", await selectorCounts(page, deleteDialogSelectors()));
  logSection(
    "delete-dialog-samples",
    await candidateSamples(page, deleteDialogSelectors(), 8, MAX_HTML_LENGTH),
  );

  const cancel = await firstVisible(page, SELECTORS.attachmentDeleteCancelButton, 3_000);
  if (cancel) {
    await cancel.click();
    await humanDelay(800, 1_500);
    logSection("delete-dialog-cancelled", { cancelled: true });
  } else {
    await page.keyboard.press("Escape");
    logSection("delete-dialog-cancelled", { cancelled: false, fallback: "Escape" });
  }
}

async function runOptionalDump(title, fn) {
  try {
    await fn();
  } catch (error) {
    logSection(`${title}-error`, {
      optional: true,
      ...serializeError(error),
    });
  }
}

async function assertSafeOrRecover(page, retryUrl) {
  try {
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
    return;
  } catch (error) {
    if (error.reason === "login_lost") {
      await ensureLoggedIn(page, { notifyFn: notifyText });
      deleteMeta(db, "circuit_open");
    } else if (
      error.reason === "verification_url" ||
      error.reason === "verification_iframe" ||
      error.reason === "verification_text"
    ) {
      await waitForSecurityCheckRecovery(page, { notifyFn: notifyText });
      deleteMeta(db, "circuit_open");
    } else {
      throw error;
    }

    await page.goto(retryUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
  }
}

async function firstNonResidentAttachmentRow(page) {
  const rows = page.locator(SELECTORS.attachmentItem);
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText().catch(() => "");
    if (/\.(?:pdf|docx?|jpe?g|png)/iu.test(text) && index > 0) {
      return row;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText().catch(() => "");
    if (/\.(?:pdf|docx?|jpe?g|png)/iu.test(text)) {
      return row;
    }
  }
  return null;
}

async function closeModalOrMenu(page) {
  const close = await firstVisible(page, SELECTORS.attachmentModalCloseButton, 1_500);
  if (close) {
    await close.click();
    await humanDelay(500, 1_000);
    return;
  }
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(500, 1_000);
}

function attachmentSelectors() {
  return [
    SELECTORS.attachmentPanel,
    SELECTORS.attachmentCount,
    SELECTORS.attachmentItem,
    SELECTORS.attachmentName,
    SELECTORS.attachmentUpdatedAt,
    SELECTORS.attachmentAddButton,
    SELECTORS.attachmentMoreButton,
  ];
}

function uploadSelectors() {
  return [
    SELECTORS.attachmentUploadMenu,
    SELECTORS.attachmentUploadResumeMenuItem,
    "text=上传简历",
    "text=上传作品集",
    "text=上传视频",
    "text=制作附件简历",
  ];
}

function uploadModalSelectors() {
  return [
    SELECTORS.attachmentUploadModal,
    SELECTORS.attachmentUploadFileInput,
    SELECTORS.attachmentUploadConfirmButton,
    SELECTORS.attachmentModalCloseButton,
    "text=PDF",
    "text=20M",
  ];
}

function rowMenuSelectors() {
  return [
    SELECTORS.attachmentRowMenu,
    SELECTORS.attachmentDeleteMenuItem,
    "text=预览",
    "text=下载",
    "text=重命名",
    "text=编辑",
    "text=删除",
  ];
}

function deleteDialogSelectors() {
  return [
    SELECTORS.attachmentDeleteDialog,
    SELECTORS.attachmentDeleteCancelButton,
    SELECTORS.attachmentDeleteConfirmButton,
    "text=已发送给Boss的附件简历不受删除影响",
    "text=确认删除",
  ];
}

async function selectorCounts(page, selectors) {
  const counts = {};
  for (const selector of selectors) {
    counts[selector] = await page.locator(selector).count().catch(() => -1);
  }
  return counts;
}

async function candidateSamples(page, selectors, maxItems, maxHtmlLength) {
  const samples = {};
  for (const selector of selectors) {
    samples[selector] = await page
      .locator(selector)
      .evaluateAll(
        (elements, { maxItems, maxHtmlLength }) =>
          elements.slice(0, maxItems).map((element, index) => ({
            index,
            tagName: element.tagName.toLowerCase(),
            className:
              typeof element.className === "string" ? element.className : "",
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 240),
            href: element.href || element.getAttribute("href") || "",
            outerHTML: element.outerHTML.slice(0, maxHtmlLength),
          })),
        { maxItems, maxHtmlLength },
      )
      .catch((error) => [{ error: error.message }]);
  }
  return samples;
}

async function bodySummary(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    return {
      title: document.title,
      url: location.href,
      textLength: text.length,
      text: text.slice(0, 4_000),
    };
  });
}

async function rowSample(row) {
  return row.evaluate((element) => ({
    tagName: element.tagName.toLowerCase(),
    className: typeof element.className === "string" ? element.className : "",
    text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 300),
    outerHTML: element.outerHTML.slice(0, 2_000),
  }));
}

async function firstVisible(page, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const group = page.locator(selector);
    const count = await group.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = group.nth(index);
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function firstVisibleIn(locator, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const group = locator.locator(selector);
    const count = await group.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const child = group.nth(index);
      if (await child.isVisible().catch(() => false)) {
        return child;
      }
    }
    await locator.page().waitForTimeout(100);
  }
  return null;
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    reason: error?.reason,
    code: error?.code,
    stack: error?.stack,
  };
}

function log(line) {
  lines.push(line);
}

function logSection(title, value) {
  lines.push(`\n## ${title}`);
  lines.push(JSON.stringify(value, null, 2));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
