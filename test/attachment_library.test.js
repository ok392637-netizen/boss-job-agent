import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  deleteAttachment,
  listAttachments,
  uploadAttachment,
} from "../src/boss/attachment_library.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

function fixtureUrl(...parts) {
  return pathToFileURL(path.join(FIXTURE_DIRECTORY, ...parts)).href;
}

test("listAttachments reads file count and attachment rows", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));
    await page.evaluate(() => {
      const items = [...document.querySelectorAll(".attachment-item")];
      items[0].dataset.slot = "1";
      items[1].dataset.slot = "3";
      items[2].dataset.slot = "5";

      const hidden = items[1].cloneNode(true);
      hidden.hidden = true;
      hidden.dataset.slot = "2";
      hidden.querySelector(".attachment-name").textContent = "hidden-placeholder.docx";
      document.querySelector(".attachment-list").append(hidden);
    });

    const result = await listAttachments(page, {
      residentAttachmentName: "罗其立-简历-2.docx",
    });

    assert.equal(result.count, 3);
    assert.equal(result.limit, 3);
    assert.deepEqual(result.attachments, [
      {
        name: "罗其立-通用简历.pdf",
        slot: 1,
        updatedAt: "2026-07-01 09:00",
        resident: false,
      },
      {
        name: "罗其立-简历.docx",
        slot: 2,
        updatedAt: "2026-07-02 10:00",
        resident: false,
      },
      {
        name: "罗其立-简历-2.docx",
        slot: 3,
        updatedAt: "2026-07-03 11:00",
        resident: true,
      },
    ]);
  } finally {
    await context.close();
  }
});

test("uploadAttachment dry-run plans 3-slot rotation without clicking upload", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".attachment-item")];
      rows[0].querySelector(".attachment-name").textContent = "luoqili-resume.pdf";
      rows[0].dataset.slot = "1";
      rows[0].dataset.updatedAt = "更新于 2026.07.05 10:00";
      rows[0].querySelector(".attachment-time").textContent = "更新于 2026.07.05 10:00";
      rows[1].querySelector(".attachment-name").textContent = "罗其立简历.pdf";
      rows[1].dataset.slot = "3";
      rows[1].dataset.updatedAt = "更新于 2026.06.04 22:38";
      rows[1].querySelector(".attachment-time").textContent = "更新于 2026.06.04 22:38";
      rows[2].querySelector(".attachment-name").textContent = "简历.pdf";
      rows[2].dataset.slot = "5";
      rows[2].dataset.updatedAt = "更新于 2026.01.01 08:00";
      rows[2].querySelector(".attachment-time").textContent = "更新于 2026.01.01 08:00";
    });

    const result = await uploadAttachment(page, "C:/tmp/罗其立-简历.docx");

    assert.equal(result.dryRun, true);
    assert.equal(result.wouldUpload, "C:/tmp/罗其立-简历.docx");
    assert.equal(result.rotation.deleteFirst.slot, 2);
    assert.equal(result.rotation.deleteFirst.name, "罗其立简历.pdf");
    assert.equal(result.before.attachments[2].name, "简历.pdf");
    assert.equal(result.before.attachments[2].resident, true);
    assert.deepEqual(result.plannedSteps, [
      "open attachment management panel",
      "delete non-resident attachment in slot 2: 罗其立简历.pdf",
      "open + upload menu",
      "choose 上传简历",
      "set exact file on input/filechooser: C:/tmp/罗其立-简历.docx",
      "wait for attachment list count to increase",
    ]);
  } finally {
    await context.close();
  }
});

test("uploadAttachment real execution requires approval", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));

    await assert.rejects(
      () =>
        uploadAttachment(page, "C:/tmp/罗其立-简历.docx", {
          dryRun: false,
        }),
      /approved=true/,
    );
  } finally {
    await context.close();
  }
});

test("uploadAttachment real execution uses filechooser and confirms list growth", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));
    await prepareTwoSlotUploadFixture(page);

    const resumePath = "C:/tmp/custom-job-resume.docx";
    const events = [];
    const uploadPage = createFileChooserPage(page, {
      events,
      onSetFiles: async (selectedPath) => {
        await page.evaluate((name) => {
          window.__selectedUploadName = name;
          window.__showCommitDialog();
        }, path.win32.basename(selectedPath));
      },
    });

    const result = await uploadAttachment(uploadPage, resumePath, {
      dryRun: false,
      approved: true,
      delayFn: async () => {},
      confirmTimeoutMilliseconds: 1_000,
    });

    assert.equal(result.uploaded, true);
    assert.equal(result.fileSelectionMethod, "filechooser");
    assert.equal(result.before.count, 2);
    assert.equal(result.after.count, 3);
    assert.equal(
      result.after.attachments.some((item) => item.name === "custom-job-resume.docx"),
      true,
    );
    assert.deepEqual(events, [
      ["waitForEvent", "filechooser", 5_000],
      ["setFiles", resumePath],
    ]);
    assert.deepEqual(await page.evaluate(() => window.__events), [
      "open-menu",
      "open-modal",
      "choose-file",
      "show-commit",
      "commit-upload",
    ]);
  } finally {
    await context.close();
  }
});

test("uploadAttachment real execution rejects when upload is not confirmed", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));
    await prepareTwoSlotUploadFixture(page, { commitAddsAttachment: false });

    const resumePath = "C:/tmp/not-uploaded.docx";
    const uploadPage = createFileChooserPage(page, {
      events: [],
      onSetFiles: async (selectedPath) => {
        await page.evaluate((name) => {
          window.__selectedUploadName = name;
          window.__showCommitDialog();
        }, path.win32.basename(selectedPath));
      },
    });

    await assert.rejects(
      () =>
        uploadAttachment(uploadPage, resumePath, {
          dryRun: false,
          approved: true,
          delayFn: async () => {},
          confirmTimeoutMilliseconds: 300,
        }),
      /upload not confirmed: count unchanged/,
    );
  } finally {
    await context.close();
  }
});

test("deleteAttachment dry-run targets by slot or name and never confirms", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));

    const bySlot = await deleteAttachment(
      page,
      { slot: 2 },
      { residentAttachmentName: "罗其立-简历-2.docx" },
    );
    assert.deepEqual(bySlot.plannedSteps, [
      "open attachment management panel",
      "open row menu for slot 2: 罗其立-简历.docx",
      "click 删除",
      "read delete confirmation dialog",
      "click 取消",
    ]);

    const byName = await deleteAttachment(
      page,
      { name: "罗其立-通用简历.pdf" },
      { residentAttachmentName: "罗其立-简历-2.docx" },
    );
    assert.equal(byName.target.slot, 1);
    assert.equal(byName.target.name, "罗其立-通用简历.pdf");

    await assert.rejects(
      () =>
        deleteAttachment(
          page,
          { slot: 3 },
          { residentAttachmentName: "罗其立-简历-2.docx" },
        ),
      /resident attachment/,
    );
  } finally {
    await context.close();
  }
});

test("deleteAttachment real execution requires approval", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("attachment-library.html"));

    await assert.rejects(
      () => deleteAttachment(page, { slot: 2 }, { dryRun: false }),
      /approved=true/,
    );
  } finally {
    await context.close();
  }
});

async function prepareTwoSlotUploadFixture(
  page,
  { commitAddsAttachment = true } = {},
) {
  await page.evaluate(({ commitAddsAttachment }) => {
    window.__events = [];
    document.querySelector("[data-slot='3']")?.remove();
    const count = document.querySelector(".file-count");
    count.textContent = count.textContent.replace(/\d+\/3/u, "2/3");

    const uploadMenu = document.querySelector(".upload-menu");
    const uploadModal = document.querySelector(".upload-modal");
    const addButton = document.querySelector(".upload-add");
    const menuButton = uploadMenu.querySelector("button");
    const chooseButton = document.querySelector(".upload-confirm");
    const commitModal = document.createElement("div");
    commitModal.className = "attachment-confirm-modal";
    commitModal.setAttribute("role", "dialog");
    commitModal.setAttribute("aria-label", "上传附件");
    commitModal.hidden = true;

    const title = document.createElement("h3");
    title.textContent = "上传附件";
    commitModal.append(title);

    const commitButton = document.createElement("button");
    commitButton.className = "btn-primary upload-commit";
    commitButton.type = "button";
    commitButton.textContent = "确定添加";
    commitModal.append(commitButton);
    document.body.append(commitModal);

    uploadMenu.hidden = true;
    uploadModal.hidden = true;
    window.__selectedUploadName = "";
    window.__showCommitDialog = () => {
      window.__events.push("show-commit");
      commitModal.hidden = false;
    };
    addButton.addEventListener("click", () => {
      window.__events.push("open-menu");
      uploadMenu.hidden = false;
    });
    menuButton.addEventListener("click", () => {
      window.__events.push("open-modal");
      uploadMenu.hidden = true;
      uploadModal.hidden = false;
    });
    chooseButton.addEventListener("click", () => {
      window.__events.push("choose-file");
    });
    commitButton.addEventListener("click", () => {
      window.__events.push("commit-upload");
      commitModal.hidden = true;
      if (!commitAddsAttachment) return;

      const list = document.querySelector(".attachment-list");
      const item = document.createElement("li");
      item.className = "attachment-item";
      item.dataset.slot = "3";
      item.dataset.updatedAt = "2026-07-05 12:00";

      const nameElement = document.createElement("span");
      nameElement.className = "attachment-name";
      nameElement.textContent = window.__selectedUploadName;
      item.append(nameElement);

      const timeElement = document.createElement("span");
      timeElement.className = "attachment-time";
      timeElement.textContent = "2026-07-05 12:00";
      item.append(timeElement);

      list.append(item);
      count.textContent = count.textContent.replace(/\d+\/3/u, "3/3");
    });
  }, { commitAddsAttachment });
}

function createFileChooserPage(page, { events, onSetFiles }) {
  return new Proxy(page, {
    get(target, property, receiver) {
      if (property === "waitForEvent") {
        return async (eventName, options = {}) => {
          events.push(["waitForEvent", eventName, options.timeout]);
          return {
            setFiles: async (selectedPath) => {
              events.push(["setFiles", selectedPath]);
              await onSetFiles(selectedPath);
            },
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
