import fs from "node:fs";
import path from "node:path";
import { chromium } from "patchright";
import { config } from "../config.js";
import { buildResumeHtml } from "./resume_html.js";

export async function renderResumePdf(
  resume,
  outputPath,
  { photoPath = config.paths.photo, tagline } = {},
) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const photoDataUri = readPhotoDataUri(photoPath);
  const html = buildResumeHtml(resume, { photoDataUri, tagline });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  } finally {
    await browser?.close();
  }

  return outputPath;
}

export function validateRenderedPdf(pdfPath) {
  const bytes = fs.readFileSync(pdfPath);
  if (bytes.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new Error(`Invalid PDF: missing %PDF header in ${pdfPath}`);
  }
  if (bytes.length <= 5 * 1024) {
    throw new Error(`Invalid PDF: expected size > 5KB, got ${bytes.length}`);
  }
  return pdfPath;
}

function readPhotoDataUri(photoPath) {
  if (!photoPath || !fs.existsSync(photoPath)) {
    return "";
  }
  const bytes = fs.readFileSync(photoPath);
  return `data:${mimeType(photoPath)};base64,${bytes.toString("base64")}`;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}
