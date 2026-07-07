import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TAGLINE = "AI 应用 / Agent / 自动化";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const TEMPLATE_PATH = path.join(PROJECT_ROOT, "scripts", "resume-template.html");

let cachedStyle = null;

export function buildResumeHtml(
  resume,
  { photoDataUri = "", tagline = DEFAULT_TAGLINE } = {},
) {
  const data = resume && typeof resume === "object" ? resume : {};
  const resolvedTagline = tagline || DEFAULT_TAGLINE;
  const expect = data.expect && typeof data.expect === "object" ? data.expect : {};
  const expected = [expect.city, expect.salary, "实习"].filter(Boolean).join(" · ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${templateStyle()}
</head>
<body>
  <aside class="side">
    ${renderPhoto(photoDataUri)}
    <div class="side-name">${inlineText(data.name)}</div>
    <div class="side-tag">${inlineText(resolvedTagline)}</div>

    <div class="side-sec">
      <div class="side-h">联系方式</div>
      <div class="kv">手机&nbsp;${inlineText(data.phone)}</div>
      <div class="kv">邮箱&nbsp;${inlineText(data.email)}</div>
      <div class="kv">广州·随时到岗</div>
    </div>

    <div class="side-sec side-edu">
      <div class="side-h">教育背景</div>
      ${renderEducation(data.education)}
      ${renderCertificates(data.certificates)}
    </div>

    <div class="side-sec">
      <div class="side-h">技能</div>
      ${renderSkills(data.skills)}
    </div>
  </aside>

  <main class="main">
    <div class="head-tag">${inlineText(resolvedTagline)} · 求职意向</div>
    <div class="head-expect">期望：<b>${inlineText(expected)}</b></div>

    <section class="m">
      <div class="m-title">个人优势</div>
      ${renderBullets(data.strengths)}
    </section>

    <section class="m">
      <div class="m-title">实习经历</div>
      ${renderWork(data.work)}
    </section>

    <section class="m">
      <div class="m-title">项目经历</div>
      ${renderProjects(data.projects)}
    </section>
  </main>
</body>
</html>`;
}

function templateStyle() {
  if (cachedStyle !== null) return cachedStyle;
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const match = template.match(/<style>[\s\S]*?<\/style>/i);
  if (!match) {
    throw new Error(`Resume HTML template is missing <style>: ${TEMPLATE_PATH}`);
  }
  cachedStyle = match[0];
  return cachedStyle;
}

function renderPhoto(photoDataUri) {
  if (!photoDataUri) {
    return '<div class="photo-wrap"></div>';
  }
  return `<div class="photo-wrap"><img class="photo" src="${attributeText(photoDataUri)}" alt=""></div>`;
}

function renderEducation(education) {
  return arrayOf(education)
    .map((item) => {
      const title = [item?.school, item?.degree].filter(Boolean).join(" · ");
      return `<div>
        <div class="school">${inlineText(title)}</div>
        <div class="major">${inlineText(item?.major)}</div>
        <div class="period">${inlineText(item?.period)}</div>
      </div>`;
    })
    .join("\n");
}

function renderCertificates(certificates) {
  const chips = arrayOf(certificates)
    .map((item) => `<span class="chip">${inlineText(item)}</span>`)
    .join("");
  return chips ? `<div class="chips">${chips}</div>` : "";
}

function renderSkills(skills) {
  return arrayOf(skills)
    .map(
      (item) => `<div class="skill-b"><div class="k">${inlineText(
        item?.name,
      )}</div><div class="v">${inlineText(item?.desc)}</div></div>`,
    )
    .join("\n");
}

function renderBullets(items) {
  const bullets = arrayOf(items)
    .map((item) => `<li>${inlineText(item)}</li>`)
    .join("\n");
  return `<ul class="b">${bullets}</ul>`;
}

function renderWork(work) {
  return arrayOf(work)
    .map(
      (item) => `<div class="entry">
        <div class="entry-head">
          <div class="entry-title">${inlineText(item?.company)}<span class="role">${inlineText(
            item?.role,
          )}</span></div>
          <div class="entry-period">${inlineText(item?.period)}</div>
        </div>
        ${renderBullets(item?.bullets)}
      </div>`,
    )
    .join("\n");
}

function renderProjects(projects) {
  return arrayOf(projects)
    .map(
      (item) => `<div class="entry">
        <div class="entry-head">
          <div class="entry-title">${inlineText(item?.name)}<span class="role">${inlineText(
            item?.tag,
          )}</span></div>
          <div class="entry-period">${inlineText(item?.period)}</div>
        </div>
        ${renderBullets(item?.bullets)}
      </div>`,
    )
    .join("\n");
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function inlineText(value) {
  return applyBold(escapeHtml(value));
}

function attributeText(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function applyBold(value) {
  return value.replace(/\*\*([\s\S]+?)\*\*/g, (_, text) => `<b>${text}</b>`);
}
