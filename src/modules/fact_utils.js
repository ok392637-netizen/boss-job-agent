export function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function stringValue(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export function numberValue(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function booleanValue(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function objectArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

export function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeEvidence(value) {
  return objectArray(value).map((item) => ({
    source: stringValue(item.source),
    title: stringValue(item.title),
    quote: stringValue(item.quote),
    url: stringValue(item.url),
  }));
}

export function collectNumbers(value, target = new Set()) {
  if (typeof value === "number") {
    target.add(String(value));
  } else if (typeof value === "string") {
    for (const match of value.matchAll(/\d+(?:\.\d+)?%?/g)) {
      target.add(match[0]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, target);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, target);
  }
  return target;
}

export function normalizeProjectFacts(projects = []) {
  return objectArray(projects).map((project) => ({
    name: stringValue(project.name),
    tag: stringValue(project.tag),
    period: stringValue(project.period),
    bullets: stringArray(project.bullets),
  })).filter((project) => project.name);
}

export function buildCandidateFactIndex(resumeBase, memoryProjects = []) {
  assertPlainObject(resumeBase, "resumeBase");
  const projectFacts = [
    ...normalizeProjectFacts(resumeBase.projects),
    ...normalizeProjectFacts(memoryProjects),
  ];
  const projectByName = new Map();
  for (const project of projectFacts) {
    projectByName.set(project.name, project);
    projectByName.set(normalizeProjectName(project.name), project);
  }
  return {
    numbers: collectNumbers({ resumeBase, memoryProjects }),
    projectByName,
  };
}

export function normalizeProjectName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·・\-_/|:：()（）【】\[\]《》"“”'‘’]/g, "");
}

export function assertNoUnsupportedNumbers(value, allowedNumbers) {
  const unsupported = [...collectNumbers(value)].find(
    (number) => !allowedNumbers.has(number),
  );
  if (unsupported) {
    throw new Error(`Generated resume introduced unsupported number: ${unsupported}`);
  }
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
