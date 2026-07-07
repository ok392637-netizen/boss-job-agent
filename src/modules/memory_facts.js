import Database from "better-sqlite3";

export const DEFAULT_MEMO_DB_PATH = "D:/claude-memo/memo.sqlite";
export const DEFAULT_PROJECT_FACT_QUERY =
  "求职 项目 经历 profile job-hunting resume boss-agent";

export function readProjectFacts({
  dbPath = DEFAULT_MEMO_DB_PATH,
  query = DEFAULT_PROJECT_FACT_QUERY,
  limit = 8,
} = {}) {
  const safeLimit = normalizeLimit(limit);
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = queryMemoRows(db, { query, limit: safeLimit });
    return rows.flatMap(extractProjectFactsFromRow).slice(0, safeLimit);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // best effort close; readProjectFacts must degrade quietly
    }
  }
}

function queryMemoRows(db, { query, limit }) {
  const match = buildFtsQuery(query);
  return db.prepare(`
    SELECT
      m.id,
      m.title,
      m.content,
      m.tags,
      m.updated_at,
      COALESCE(m.pinned, 0) AS pinned
    FROM memory_fts
    JOIN memories m ON m.id = memory_fts.rowid
    WHERE memory_fts MATCH @match
      AND COALESCE(m.archived, 0) = 0
    ORDER BY pinned DESC, bm25(memory_fts), datetime(COALESCE(m.updated_at, m.created_at)) DESC
    LIMIT @limit
  `).all({ match, limit });
}

export function buildFtsQuery(query = DEFAULT_PROJECT_FACT_QUERY) {
  const terms = String(query || DEFAULT_PROJECT_FACT_QUERY)
    .split(/[\s,，、]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
  const unique = [...new Set(terms)];
  return unique
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function extractProjectFactsFromRow(row) {
  const title = stringValue(row?.title);
  const content = stringValue(row?.content);
  const tags = parseTags(row?.tags);
  const projects = extractProjectFacts(content);
  return projects.map((project) => ({
    title,
    content,
    tags,
    ...project,
  }));
}

export function extractProjectFacts(content) {
  const projects = [];
  let sectionKind = "";
  let current = null;

  const flush = () => {
    if (!current) return;
    current.facts = dedupeStrings(current.facts);
    current.metrics = extractMetrics(current.facts);
    current.bullets = current.facts;
    if (current.name && current.facts.length > 0) {
      projects.push(current);
    }
    current = null;
  };

  for (const line of String(content ?? "").split(/\r?\n/u)) {
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.+?)\s*$/u);
    if (heading) {
      flush();
      sectionKind = classifySection(heading[1]);
      continue;
    }
    if (!sectionKind) continue;

    const entry = parseEntryLine(line, { sectionKind, hasCurrent: Boolean(current) });
    if (entry) {
      flush();
      current = entry;
      continue;
    }

    const fact = parseFactLine(line);
    if (current && fact) {
      current.facts.push(fact);
    }
  }
  flush();

  return projects;
}

function classifySection(heading) {
  const text = stripMarkdown(heading);
  if (/项目|工作|经历|实践|素材|数据点/u.test(text)) return "facts";
  return "";
}

function parseEntryLine(line, { sectionKind, hasCurrent }) {
  const match = line.match(/^\s*(?:(\d+)[.)、]|[-*])\s+(.+?)\s*$/u);
  if (!match) return null;

  const numbered = Boolean(match[1]);
  const text = stripMarkdown(match[2]);
  const bold = match[2].match(/^\s*\*\*(.+?)\*\*\s*(.*)$/u);
  if (bold) {
    return buildProjectFact(stripMarkdown(bold[1]), bold[2]);
  }
  if (numbered || sectionKind === "work" || (!hasCurrent && /[:：—-]/u.test(text))) {
    return buildProjectFactFromPlainText(text);
  }
  return null;
}

function buildProjectFactFromPlainText(text) {
  const [left, right = ""] = splitEntryText(text);
  return buildProjectFact(left, right);
}

function buildProjectFact(rawName, rawDetails = "") {
  const parsedName = parseNameAndMeta(rawName);
  const parsedDetails = parseLeadingMeta(rawDetails);
  const facts = splitFacts(parsedDetails.details);
  return {
    name: parsedName.name,
    tag: parsedName.tag || parsedDetails.tag,
    period: parsedName.period || parsedDetails.period,
    facts,
    metrics: [],
    bullets: [],
  };
}

function splitEntryText(text) {
  const match = text.match(/^(.+?)\s*(?:[:：]|—|\s-\s)\s*(.+)$/u);
  if (!match) return [text, ""];
  return [match[1], match[2]];
}

function parseNameAndMeta(rawValue) {
  const value = stripMarkdown(rawValue)
    .replace(/^\s*["“]|["”]\s*$/gu, "")
    .trim();
  const match = value.match(/^(.+?)\s*[（(]([^()（）]+)[）)]\s*$/u);
  if (!match) {
    return { name: value, tag: "", period: "" };
  }
  const meta = parseMeta(match[2]);
  return {
    name: match[1].trim(),
    tag: meta.tag,
    period: meta.period,
  };
}

function parseLeadingMeta(rawValue) {
  const value = stripMarkdown(rawValue);
  const match = value.match(/^\s*[（(]([^()（）]+)[）)]\s*[:：]?\s*(.*)$/u);
  if (!match) {
    return { tag: "", period: "", details: value.replace(/^\s*[:：]\s*/u, "") };
  }
  return {
    ...parseMeta(match[1]),
    details: match[2],
  };
}

function parseMeta(metaText) {
  const parts = metaText
    .split(/[，,、/]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const periodPart = parts.find((part) => PERIOD_PATTERN.test(part)) ?? "";
  const tag = parts.filter((part) => part !== periodPart).join(" / ");
  return { tag, period: periodPart };
}

function parseFactLine(line) {
  const match = line.match(/^\s*(?:[-*]|\d+[.)、])\s+(.+?)\s*$/u);
  if (!match) return "";
  return normalizeFact(match[1]);
}

function splitFacts(value) {
  return stripMarkdown(value)
    .split(/[;；。]\s*/u)
    .map(normalizeFact)
    .filter(Boolean);
}

function normalizeFact(value) {
  return stripMarkdown(value)
    .replace(/^[：:，,\s-]+/u, "")
    .replace(/[。；;]\s*$/u, "")
    .trim();
}

function stripMarkdown(value) {
  return String(value ?? "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/`(.+?)`/gu, "$1")
    .trim();
}

function extractMetrics(facts) {
  return facts.filter((fact) =>
    /(?:^|[^\p{L}])\d+(?:\.\d+)?\s*(?:%|个|分钟|小时|天|月|年|次|条|份|min)/u.test(
      fact,
    ),
  );
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  }
  const text = stringValue(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parseTags(parsed);
    } catch {
      // fall through to comma-separated tags
    }
  }
  return text.split(/[,\s，、]+/u).map((tag) => tag.trim()).filter(Boolean);
}

function dedupeStrings(values) {
  return [...new Set(values.map(normalizeFact).filter(Boolean))];
}

function normalizeLimit(limit) {
  const value = Number.isInteger(limit) ? limit : Number.parseInt(limit, 10);
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, value));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

const PERIOD_PATTERN =
  /20\d{2}(?:[.\-/]\d{1,2})?(?:\s*[-~至到]\s*(?:20\d{2}(?:[.\-/]\d{1,2})?|至今|持续))?|持续/u;
