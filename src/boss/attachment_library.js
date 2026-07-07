import fs from "node:fs";
import { humanDelay } from "../browser.js";
import { config } from "../config.js";
import { SELECTORS } from "./selectors.js";

export const ATTACHMENT_LIMIT = 3;
export const DEFAULT_RESIDENT_ATTACHMENT_NAME = "简历.pdf";

export async function listAttachments(
  page,
  {
    selectors = SELECTORS,
    residentAttachmentName = config.resume.residentAttachmentName,
  } = {},
) {
  assertPage(page);
  return page.evaluate(({ selectors, residentAttachmentName }) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const fileNamePattern = /[^\s"'<>/\\]+\.(?:pdf|docx?|jpe?g|png)/iu;
    const residentName = normalize(residentAttachmentName);
    const datePattern =
      /20\d{2}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2})?/u;

    const candidates = [
      document.querySelector(selectors.attachmentPanel),
      ...[...document.querySelectorAll("section, aside, div, main")].filter(
        (element) => normalize(element.textContent).includes("附件管理"),
      ),
    ].filter(Boolean);
    const panel = candidates[0] ?? document.body;
    const panelText = normalize(panel.textContent);
    const countMatch = panelText.match(/文件\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/u);
    const explicitCount = countMatch
      ? { count: Number(countMatch[1]), limit: Number(countMatch[2]) }
      : null;

    const rows = [...panel.querySelectorAll(selectors.attachmentItem)]
      .filter(isVisibleAttachmentElement)
      .filter((element) => {
        const text = normalize(element.textContent);
        const nameText = normalize(
          element.querySelector(selectors.attachmentName)?.textContent ||
            element.querySelector(selectors.attachmentName)?.getAttribute("title"),
        );
        return Boolean(nameText) || fileNamePattern.test(text);
      })
      .map((element) => {
        const text = normalize(element.textContent);
        const nameText = normalize(
          element.querySelector(selectors.attachmentName)?.textContent ||
            element.querySelector(selectors.attachmentName)?.getAttribute("title"),
        );
        const timeText = normalize(
          element.querySelector(selectors.attachmentUpdatedAt)?.textContent,
        );
        const updatedAt =
          element.getAttribute("data-updated-at") ||
          element.dataset.updatedAt ||
          timeText.match(datePattern)?.[0] ||
          text.match(datePattern)?.[0] ||
          "";
        return {
          name: nameText || text.match(fileNamePattern)?.[0] || "",
          updatedAt,
        };
      })
      .filter((item) => item.name);

    const attachments = dedupeRows(rows).map((item, index) => {
      const slot = index + 1;
      return {
        ...item,
        slot,
        resident: residentName !== "" && normalize(item.name) === residentName,
      };
    });
    return {
      count: explicitCount?.count ?? attachments.length,
      limit: explicitCount?.limit ?? 3,
      attachments,
    };

    function dedupeRows(values) {
      const seen = new Set();
      return values.filter((item) => {
        const key = `${item.name}\u0000${item.updatedAt}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function isVisibleAttachmentElement(element) {
      if (!element || element.closest("[hidden], [aria-hidden='true']")) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      return element.getClientRects().length > 0;
    }
  }, {
    selectors,
    residentAttachmentName:
      residentAttachmentName ?? DEFAULT_RESIDENT_ATTACHMENT_NAME,
  });
}

export async function uploadAttachment(
  page,
  filePath,
  {
    dryRun = true,
    approved = false,
    selectors = SELECTORS,
    delayFn = humanDelay,
    checkFile = false,
    fileChooserTimeoutMilliseconds = 5_000,
    confirmTimeoutMilliseconds = 15_000,
    residentAttachmentName = config.resume.residentAttachmentName,
  } = {},
) {
  assertPage(page);
  if (!filePath || typeof filePath !== "string") {
    throw new Error("uploadAttachment requires filePath");
  }
  if (checkFile && !fs.existsSync(filePath)) {
    throw new Error(`Attachment file does not exist: ${filePath}`);
  }

  const library = await listAttachments(page, {
    selectors,
    residentAttachmentName,
  });
  const deleteFirst =
    library.count >= library.limit ? oldestNonResident(library.attachments) : null;
  if (library.count >= library.limit && !deleteFirst) {
    throw new Error("Attachment library is full and no non-resident slot can be rotated");
  }

  const plannedSteps = buildUploadPlan(filePath, deleteFirst);
  if (dryRun) {
    return {
      dryRun: true,
      uploaded: false,
      wouldUpload: filePath,
      before: library,
      rotation: { deleteFirst },
      plannedSteps,
    };
  }
  if (!approved) {
    throw new Error("Real attachment upload requires approved=true");
  }

  if (deleteFirst) {
    await deleteAttachment(
      page,
      { slot: deleteFirst.slot },
      {
        dryRun: false,
        approved: true,
        selectors,
        delayFn,
        residentAttachmentName,
      },
    );
    await delayFn(1_000, 2_000);
  }

  const beforeUpload = await listAttachments(page, {
    selectors,
    residentAttachmentName,
  });

  const addButton = await firstVisible(page, selectors.attachmentAddButton, 5_000);
  if (!addButton) {
    throw new Error("Unable to find attachment + button");
  }
  await addButton.click();
  await delayFn(1_000, 2_000);

  const uploadResume = await firstVisible(
    page,
    selectors.attachmentUploadResumeMenuItem,
    5_000,
  );
  if (!uploadResume) {
    throw new Error("Unable to find 上传简历 menu item");
  }
  await uploadResume.click();
  await delayFn(1_000, 2_000);

  const fileSelectionMethod = await setUploadFile(page, filePath, {
    selectors,
    fileChooserTimeoutMilliseconds,
  });
  await delayFn(1_000, 2_000);

  const afterUpload = await waitForUploadConfirmation(page, {
    selectors,
    before: beforeUpload,
    filePath,
    timeoutMilliseconds: confirmTimeoutMilliseconds,
    residentAttachmentName,
  });

  return {
    dryRun: false,
    uploaded: true,
    filePath,
    fileSelectionMethod,
    before: beforeUpload,
    after: afterUpload,
    rotation: { deleteFirst },
  };
}

export async function deleteAttachment(
  page,
  target,
  {
    dryRun = true,
    approved = false,
    selectors = SELECTORS,
    delayFn = humanDelay,
    residentAttachmentName = config.resume.residentAttachmentName,
  } = {},
) {
  assertPage(page);
  const library = await listAttachments(page, {
    selectors,
    residentAttachmentName,
  });
  const attachment = resolveTarget(library.attachments, target);
  if (!attachment) {
    throw new Error("Attachment target not found");
  }
  if (attachment.resident) {
    throw new Error(`Refusing to delete resident attachment: ${attachment.name}`);
  }

  const plannedSteps = [
    "open attachment management panel",
    `open row menu for slot ${attachment.slot}: ${attachment.name}`,
    "click 删除",
    "read delete confirmation dialog",
    dryRun ? "click 取消" : "click 确定",
  ];
  if (dryRun) {
    return {
      dryRun: true,
      deleted: false,
      target: attachment,
      plannedSteps,
    };
  }
  if (!approved) {
    throw new Error("Real attachment deletion requires approved=true");
  }

  const row = await rowForAttachment(page, attachment, selectors);
  if (!row) {
    throw new Error(`Unable to locate attachment row: ${attachment.name}`);
  }
  const more = await firstVisibleIn(row, selectors.attachmentMoreButton, 5_000);
  if (!more) {
    throw new Error(`Unable to find row menu for attachment: ${attachment.name}`);
  }
  await more.click();
  await delayFn(1_000, 2_000);

  await clickFirstVisible(page, selectors.attachmentDeleteMenuItem, 5_000);
  await delayFn(1_000, 2_000);

  const dialog = await firstVisible(page, selectors.attachmentDeleteDialog, 5_000);
  if (!dialog) {
    throw new Error("Unable to find attachment delete confirmation dialog");
  }
  const confirm = await firstVisibleIn(dialog, selectors.attachmentDeleteConfirmButton, 5_000);
  if (!confirm) {
    throw new Error("Unable to find attachment delete confirm button");
  }
  await confirm.click();
  await delayFn(1_000, 2_000);

  return {
    dryRun: false,
    deleted: true,
    target: attachment,
  };
}

function buildUploadPlan(filePath, deleteFirst) {
  return [
    "open attachment management panel",
    deleteFirst
      ? `delete non-resident attachment in slot ${deleteFirst.slot}: ${deleteFirst.name}`
      : null,
    "open + upload menu",
    "choose 上传简历",
    `set exact file on input/filechooser: ${filePath}`,
    "wait for attachment list count to increase",
  ].filter(Boolean);
}

function oldestNonResident(attachments) {
  const candidates = attachments.filter((item) => !item.resident);
  candidates.sort((left, right) => {
    const leftTime = parseAttachmentTimestamp(left.updatedAt);
    const rightTime = parseAttachmentTimestamp(right.updatedAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime;
    }
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return left.slot - right.slot;
  });
  return candidates[0] ?? null;
}

function parseAttachmentTimestamp(value) {
  const text = String(value ?? "").trim();
  const match = text.match(
    /(20\d{2})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/u,
  );
  if (match) {
    const [, year, month, day, hour = "0", minute = "0"] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    ).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function resolveTarget(attachments, target = {}) {
  if (Number.isInteger(target.slot)) {
    return attachments.find((item) => item.slot === target.slot) ?? null;
  }
  if (target.name) {
    return attachments.find((item) => item.name === target.name) ?? null;
  }
  throw new Error("deleteAttachment requires target slot or name");
}

async function rowForAttachment(page, attachment, selectors) {
  const rows = page.locator(selectors.attachmentItem);
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    const text = await row.innerText().catch(() => "");
    if (text.includes(attachment.name)) {
      return row;
    }
  }
  return null;
}

async function setUploadFile(
  page,
  filePath,
  { selectors, fileChooserTimeoutMilliseconds },
) {
  let fileChooserError = null;
  if (typeof page.waitForEvent === "function") {
    let chooser = null;
    try {
      [chooser] = await Promise.all([
        page.waitForEvent("filechooser", {
          timeout: fileChooserTimeoutMilliseconds,
        }),
        clickUploadFileButton(
          page,
          selectors,
          fileChooserTimeoutMilliseconds,
        ),
      ]);
    } catch (error) {
      fileChooserError = error;
    }

    if (chooser) {
      if (!chooser || typeof chooser.setFiles !== "function") {
        throw new Error("filechooser event did not expose setFiles");
      }
      await chooser.setFiles(filePath);
      await clickUploadCommitButton(page, selectors, 8_000);
      return "filechooser";
    }
  }

  const fileInput = await firstUploadModalFileInput(page, selectors, 2_000);
  if (!fileInput) {
    const reason = fileChooserError?.message ? `: ${fileChooserError.message}` : "";
    throw new Error(`Unable to set upload file via filechooser or modal input${reason}`);
  }

  await fileInput.setInputFiles(filePath);
  await assertFileInputAccepted(fileInput, filePath);
  await clickUploadCommitButton(page, selectors, 8_000);
  return "modal-input";
}

async function clickUploadFileButton(page, selectors, timeoutMilliseconds) {
  const modal = await firstVisible(
    page,
    selectors.attachmentUploadModal,
    Math.min(timeoutMilliseconds, 2_000),
  );
  if (modal) {
    const button = await firstVisibleIn(
      modal,
      selectors.attachmentUploadConfirmButton,
      timeoutMilliseconds,
    );
    if (button) {
      await button.click();
      return button;
    }
  }
  return clickFirstVisible(page, selectors.attachmentUploadConfirmButton, timeoutMilliseconds);
}

async function clickUploadCommitButton(page, selectors, timeoutMilliseconds) {
  const primarySelector =
    "button:has-text('确定添加'), a:has-text('确定添加'), .btn-primary:has-text('确定添加')";
  const button =
    (await firstVisible(page, primarySelector, timeoutMilliseconds)) ||
    (await firstVisible(page, selectors.attachmentUploadCommitButton, 500));
  if (button) {
    await button.click();
    return button;
  }

  const screenshotPath = "data/logs/upload-commit-button-missing.png";
  await screenshotPage(page, screenshotPath);
  throw new Error(
    `Unable to find attachment upload 确定添加 button; screenshot: ${screenshotPath}`,
  );
}

async function screenshotPage(page, screenshotPath) {
  if (typeof page.screenshot !== "function") return;
  fs.mkdirSync("data/logs", { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
}

async function firstUploadModalFileInput(page, selectors, timeoutMilliseconds) {
  const modal = await firstVisible(
    page,
    selectors.attachmentUploadModal,
    timeoutMilliseconds,
  );
  if (!modal) return null;

  const inputs = modal.locator(selectors.attachmentUploadFileInput);
  const count = await inputs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    if (await isFileInput(input)) {
      return input;
    }
  }
  return null;
}

async function isFileInput(locator) {
  if (typeof locator.evaluate !== "function") return false;
  return locator
    .evaluate((element) => {
      return Boolean(
        element?.isConnected &&
          element.tagName?.toLowerCase() === "input" &&
          element.type === "file",
      );
    })
    .catch(() => false);
}

async function assertFileInputAccepted(locator, filePath) {
  if (typeof locator.evaluate !== "function") {
    throw new Error("modal file input cannot be verified");
  }
  const expectedName = normalizeComparableName(basenameOfFilePath(filePath));
  const selectedNames = await locator
    .evaluate((element) => [...(element.files || [])].map((file) => file.name))
    .catch(() => []);
  const accepted = selectedNames
    .map((name) => normalizeComparableName(name))
    .includes(expectedName);
  if (!accepted) {
    throw new Error("modal file input did not accept selected file");
  }
}

async function waitForUploadConfirmation(
  page,
  {
    selectors,
    before,
    filePath,
    timeoutMilliseconds,
    residentAttachmentName,
  },
) {
  const expectedName = normalizeComparableName(basenameOfFilePath(filePath));
  const beforeNames = new Set(
    before.attachments.map((item) =>
      normalizeComparableName(basenameOfFilePath(item.name)),
    ),
  );
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() <= deadline) {
    const current = await listAttachments(page, {
      selectors,
      residentAttachmentName,
    });
    if (current.count > before.count) {
      return current;
    }
    const hasNewFileName =
      !beforeNames.has(expectedName) &&
      current.attachments.some(
        (item) =>
          normalizeComparableName(basenameOfFilePath(item.name)) === expectedName,
      );
    if (hasNewFileName) {
      return current;
    }
    await waitForPage(page, 500);
  }

  throw new Error("upload not confirmed: count unchanged");
}

async function waitForPage(page, milliseconds) {
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(milliseconds);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function basenameOfFilePath(filePath) {
  return String(filePath).split(/[\\/]/u).filter(Boolean).pop() || "";
}

function normalizeComparableName(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
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
    await page.waitForTimeout?.(100);
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
    await locator.page?.().waitForTimeout?.(100);
  }
  return null;
}

async function clickFirstVisible(page, selector, timeoutMilliseconds) {
  const locator = await firstVisible(page, selector, timeoutMilliseconds);
  if (!locator) {
    throw new Error(`Unable to find visible element: ${selector}`);
  }
  await locator.click();
  return locator;
}

function assertPage(page) {
  if (!page || typeof page.locator !== "function") {
    throw new Error("attachment library operation requires a Playwright page");
  }
}
