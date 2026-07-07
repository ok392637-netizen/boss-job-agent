import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildResumeHtml } from "../src/pipeline/resume_html.js";
import {
  renderResumePdf,
  validateRenderedPdf,
} from "../src/pipeline/render_resume_pdf.js";

const fixtureResume = Object.freeze({
  name: '<script>alert("x")</script>',
  phone: "13800138000",
  email: "candidate@example.com",
  expect: { salary: "3-8K", city: "Guangzhou" },
  education: [
    {
      school: "Guangzhou University",
      degree: "Bachelor",
      major: "AI Applications",
      period: "2024-2028",
    },
  ],
  certificates: ["CET-4"],
  strengths: ["Can turn **粗** user workflows into reliable automations."],
  work: [
    {
      company: "Automation Studio",
      role: "Agent Intern",
      period: "2026.01-2026.04",
      bullets: ["Built <unsafe> workflow nodes with **tested** fallbacks."],
    },
  ],
  projects: [
    {
      name: "Boss Job Agent",
      tag: "Personal",
      period: "2026.06-2026.07",
      bullets: ["Screened jobs, tailored resumes, and drafted replies."],
    },
  ],
  skills: [
    {
      name: "AI Tools",
      desc: "Claude Code, Cursor, n8n, Dify, Coze",
    },
  ],
});

function tempPdfPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-resume-pdf-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "resume.pdf");
}

test("buildResumeHtml escapes resume text before applying markdown bold", () => {
  const html = buildResumeHtml(fixtureResume, { tagline: "AI Agent" });

  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /<b>粗<\/b>/);
  assert.match(html, /Built &lt;unsafe&gt; workflow nodes/);
  assert.match(html, /<b>tested<\/b>/);
});

test("buildResumeHtml omits the image element when no photo data uri is provided", () => {
  const html = buildResumeHtml(fixtureResume);

  assert.match(html, /<div class="photo-wrap"><\/div>/);
  assert.doesNotMatch(html, /<img class="photo"/);
});

test("renderResumePdf writes a valid PDF and tolerates missing photo", async (t) => {
  const outputPath = tempPdfPath(t);

  await renderResumePdf(fixtureResume, outputPath, {
    photoPath: path.join(os.tmpdir(), "missing-resume-photo.jpg"),
    tagline: "AI Agent",
  });

  const bytes = fs.readFileSync(outputPath);
  assert.equal(bytes.subarray(0, 4).toString("utf8"), "%PDF");
  assert.ok(bytes.length > 5 * 1024, `expected PDF > 5KB, got ${bytes.length}`);
  assert.equal(validateRenderedPdf(outputPath), outputPath);
});
