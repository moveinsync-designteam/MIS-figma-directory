// Figma Directory - automated indexer.
// Runs inside GitHub Actions. Same extraction rules as figma-indexer.html,
// so the JSON it writes is exactly what index.html already reads.
//
// Reads:  figma-directory-config.json   (files, labels, excludes - edit this to add files)
// Writes: figma-directory-data.json     (what the live site loads)
//         .figdir-state.json            (bookkeeping: lets unchanged files be skipped)

import fs from "node:fs";
import crypto from "node:crypto";

const CONFIG_PATH = process.env.CONFIG_PATH || "figma-directory-config.json";
const DATA_PATH   = process.env.DATA_PATH   || "figma-directory-data.json";
const STATE_PATH  = process.env.STATE_PATH  || ".figdir-state.json";
const TOKEN       = (process.env.FIGMA_TOKEN || "").trim();
const FULL        = String(process.env.FULL_REINDEX || "").toLowerCase() === "true";
const ONLY        = (process.env.ONLY || "").trim().toLowerCase();
const ONLY_MODULE = (process.env.ONLY_MODULE || "").trim().toLowerCase();
const COUNT_ONLY  = String(process.env.COUNT_ONLY || "").toLowerCase() === "true";
const API         = (process.env.FIGMA_API_BASE || "https://api.figma.com").replace(/\/+$/, "");

const DEFAULT_LABELS   = ["for internal use", "section-titles", "section-titles-lg", "sub section header", "page-titles"];
const DEFAULT_EXCLUDES = ["graveyard", "experiments", "earlier versions", "inspiration", "sandbox", "archive", "deprecated"];

/* ---------- inputs ---------- */

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
}

const config = readJson(CONFIG_PATH, null);
if (!config || (!Array.isArray(config.files) && !Array.isArray(config.folders))) {
  console.error("Could not read " + CONFIG_PATH + " - it needs a \"folders\" list, a \"files\" list, or both.");
  process.exit(1);
}
if (!TOKEN) {
  console.error("FIGMA_TOKEN secret is missing. Add it under repo Settings > Secrets and variables > Actions.");
  process.exit(1);
}

const skips = (Array.isArray(config.skip) ? config.skip : [])
  .map(x => String(x || "").toLowerCase().trim()).filter(Boolean);

const settings = {
  labels:     (config.labels && config.labels.length ? config.labels : DEFAULT_LABELS).map(norm),
  excludes:   (Array.isArray(config.excludes) ? config.excludes : DEFAULT_EXCLUDES).map(norm),
  indexWords: config.indexWords !== false
};
const settingsHash = crypto.createHash("sha1").update(JSON.stringify(settings)).digest("hex").slice(0, 12);

const prevData  = readJson(DATA_PATH, []);
const prevById  = new Map((Array.isArray(prevData) ? prevData : []).map(f => [f.id, f]));
const prevState = readJson(STATE_PATH, {});
const settingsChanged = prevState.settingsHash && prevState.settingsHash !== settingsHash;

/* ---------- extraction (identical rules to the browser indexer) ---------- */

function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function isSeparator(name) { return !/[a-z0-9]/i.test(name || ""); }
function isExcludedName(name) {
  const nm = norm(name);
  if (!nm || isSeparator(nm)) return true;
  return settings.excludes.some(x => x && nm.includes(x));
}
function isLabelNode(node) {
  const nm = norm(node.name);
  if (!nm) return false;
  return settings.labels.some(l => nm === l || nm.includes(l));
}
function labelText(node, out) {
  if (!node) return out;
  if (node.type === "TEXT" && node.characters) {
    const t = node.characters.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  if (node.children) for (const c of node.children) labelText(c, out);
  return out;
}

const WORD_STOP = new Set(["the","and","for","are","was","you","your","with","this","that","from",
  "not","but","all","can","has","have","will","get","out","use","any","new","see","its","our"]);

function collectWords(text, acc) {
  if (!acc.words) return;
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || w.length > 24) continue;
    if (/^\d+$/.test(w)) continue;
    if (WORD_STOP.has(w)) continue;
    if (acc.words.size < 25000) acc.words.add(w);
  }
}

function walkSubtree(node, page, acc) {
  if (!node) return;
  if ((node.type === "SECTION" || node.type === "FRAME") && isExcludedName(node.name)) { acc.excluded++; return; }
  if (node.type === "TEXT" && node.characters) collectWords(node.characters, acc);
  if (isLabelNode(node)) {
    const text = labelText(node, []).join(" ").slice(0, 200).trim();
    if (text) { acc.labels.push({ t: text, id: node.id, p: page.id }); collectWords(text, acc); }
    return;
  }
  if (node.children) for (const c of node.children) walkSubtree(c, page, acc);
}

/* ---------- network ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
function ApiError(message, kind) { return { message, kind }; }
let apiCalls = 0;

async function figmaGet(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: { "X-Figma-Token": TOKEN } });
  } catch {
    if (attempt < 3) { await sleep(5000); return figmaGet(url, attempt + 1); }
    throw ApiError("network error", "split");
  }
  apiCalls++;

  if (res.status === 403) throw ApiError("403 - token expired, invalid, or has no access to this file", "token");
  if (res.status === 404) throw ApiError("404 - file not found (deleted or link wrong?)", "fatal");
  if (res.status === 429) {
    // Figma says how long to wait. A short wait we sit out; a very long one ends the run
    // cleanly (old data stays live) instead of burning hours of Actions time.
    const wait = Number(res.headers.get("retry-after")) || 60;
    if (wait <= 600 && attempt < 6) {
      console.log("    rate limited - waiting " + wait + "s");
      await sleep(wait * 1000);
      return figmaGet(url, attempt + 1);
    }
    throw ApiError("429 - rate limited (Figma asked to wait " + wait + "s)", "ratelimit");
  }
  if (res.status === 400 || res.status === 413) throw ApiError("request too large", "split");
  if (res.status >= 500 && attempt < 3) { await sleep(10000); return figmaGet(url, attempt + 1); }
  if (!res.ok) throw ApiError("HTTP " + res.status, "split");

  const body = await res.text();
  try { return JSON.parse(body); }
  catch { throw ApiError("truncated response (" + Math.round(body.length / 1048576) + " MB)", "split"); }
}

async function nodesFetch(fileKey, ids, depth) {
  let u = API + "/v1/files/" + fileKey + "/nodes?ids=" + ids.join(",");
  if (depth) u += "&depth=" + depth;
  const j = await figmaGet(u);
  return j.nodes || {};
}

const STRUCTURAL = { FRAME: 1, SECTION: 1, COMPONENT: 1, COMPONENT_SET: 1, GROUP: 1 };
const isStop = e => e && (e.kind === "token" || e.kind === "ratelimit" || e.kind === "fatal");

async function harvest(fileKey, ids, page, acc) {
  if (!ids.length) return;
  try {
    const nodes = await nodesFetch(fileKey, ids, null);
    for (const id of ids) {
      const d = nodes[id] && nodes[id].document;
      if (d) walkSubtree(d, page, acc);
    }
    return;
  } catch (e) {
    if (isStop(e)) throw e;
    if (ids.length > 1) {
      const mid = Math.ceil(ids.length / 2);
      await harvest(fileKey, ids.slice(0, mid), page, acc);
      await harvest(fileKey, ids.slice(mid), page, acc);
      return;
    }
    let shallow;
    try { shallow = await nodesFetch(fileKey, ids, 1); }
    catch (e2) { if (isStop(e2)) throw e2; acc.skipped++; return; }
    const d = shallow[ids[0]] && shallow[ids[0]].document;
    const kids = d && d.children ? d.children.map(c => c.id) : [];
    if (!kids.length) { acc.skipped++; return; }
    for (let i = 0; i < kids.length; i += 5) await harvest(fileKey, kids.slice(i, i + 5), page, acc);
  }
}

async function indexOne(entry) {
  const fileKey = entry.id;

  // Normally one call gets the pages and their top-level children. A very large
  // file blows Figma's response limit even at depth 2, so fall back to the page
  // list alone and fetch each page's children separately.
  let meta, shallow = false;
  try {
    meta = await figmaGet(API + "/v1/files/" + fileKey + "?depth=2");
  } catch (e) {
    if (!e || e.kind !== "split") throw e;
    console.log("    file too large at depth 2 - fetching page by page");
    meta = await figmaGet(API + "/v1/files/" + fileKey + "?depth=1");
    shallow = true;
  }
  const pages = (meta.document && meta.document.children) || [];

  const acc = { labels: [], topNames: [], skipped: 0, excluded: 0, words: settings.indexWords ? new Set() : null };
  const pagesData = [];
  let skippedPages = 0;

  for (const page of pages) {
    if (isExcludedName(page.name)) { skippedPages++; continue; }
    pagesData.push({ name: page.name, id: page.id });
    collectWords(page.name, acc);

    let pageKids = page.children;
    if (shallow && !pageKids) {
      try {
        const pn = await nodesFetch(fileKey, [page.id], 2);
        const pd = pn[page.id] && pn[page.id].document;
        pageKids = (pd && pd.children) || [];
      } catch (e) {
        if (isStop(e)) throw e;
        acc.skipped++;
        pageKids = [];
      }
    }

    const kids = [];
    for (const c of pageKids || []) {
      if (isExcludedName(c.name)) { acc.excluded++; continue; }
      if (STRUCTURAL[c.type] || c.type === "INSTANCE") kids.push(c.id);
      if (STRUCTURAL[c.type]) { const nm = (c.name || "").trim(); if (nm) acc.topNames.push(nm); }
      if (isLabelNode(c)) kids.push(c.id);
    }
    const uniq = [...new Set(kids)];
    for (let j = 0; j < uniq.length; j += 10) {
      await harvest(fileKey, uniq.slice(j, j + 10), page, acc);
      await sleep(150);
    }
  }

  const seen = new Set();
  const labels = [];
  for (const l of acc.labels) {
    const k = l.t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    labels.push(l);
  }

  const searchText = [...new Set([
    meta.name || "", ...pagesData.map(p => p.name), ...acc.topNames, ...labels.map(l => l.t)
  ])].join(" ").toLowerCase();

  return {
    rec: {
      id: fileKey,
      name: meta.name || entry.name || "Untitled",
      projectName: entry.projectName || "Untagged",
      module: entry.module || "Other",
      lastModified: meta.lastModified || "",
      link: entry.link || ("https://www.figma.com/design/" + fileKey),
      pages: pagesData.map(p => p.name),
      pagesData,
      labels,
      words: acc.words ? [...acc.words].sort() : [],
      searchText
    },
    stats: { labels: labels.length, pages: pagesData.length, words: acc.words ? acc.words.size : 0,
             skippedPages, excluded: acc.excluded, unreadable: acc.skipped }
  };
}


/* ---------- folder discovery ---------- */
// Figma renamed projects to folders. The v2 folder endpoints need the folders:read
// scope; older tokens carry projects:read and only speak v1. Try v2, fall back to v1.

const discoveryNotes = [];

function folderIdFrom(x) {
  const s = String(x == null ? "" : x).trim();
  const m = s.match(/\/(?:folder|project)\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(s) ? s : "";
}

async function tryGet(url) {
  try { return { ok: true, json: await figmaGet(url) }; }
  catch (e) { return { ok: false, err: e }; }
}

// Files sitting directly in one folder.
async function folderFiles(id) {
  let r = await tryGet(API + "/v2/folders/" + id + "/files");
  if (!r.ok) r = await tryGet(API + "/v1/projects/" + id + "/files");   // older projects:read token
  if (!r.ok) throw r.err;
  return (r.json && r.json.files) || [];
}

// Direct subfolders. v1 has no equivalent, so an empty list is a fine answer.
async function subFolders(id) {
  const r = await tryGet(API + "/v2/folders/" + id + "/folders");
  if (!r.ok) return [];
  return (r.json && (r.json.folders || r.json.sub_folders)) || [];
}

async function expandFolder(entry, out, depth, seenFolders) {
  const id = folderIdFrom(entry.id || entry.folder || entry.link);
  if (!id) { console.warn("  folder entry has no usable id: " + JSON.stringify(entry)); return; }
  if (seenFolders.has(id)) return;          // guards against a folder cycle
  seenFolders.add(id);

  let files;
  try { files = await folderFiles(id); }
  catch (e) {
    const why = (e && e.kind === "token")
      ? "403 - the token is missing the folders:read scope, or cannot see this folder"
      : ((e && e.message) || String(e));
    console.warn("  folder " + id + ": could not list files - " + why);
    discoveryNotes.push("folder " + id + ": " + why);
    return;
  }

  for (const f of files) {
    const key = f.key || f.file_key;
    if (!key) continue;
    out.push({
      id: key,
      name: f.name || "",
      link: "https://www.figma.com/design/" + key,
      module: entry.module || "Other",
      projectName: entry.projectName || "Untagged"
    });
  }
  console.log("  folder " + id + (entry.projectName ? " (" + entry.projectName + ")" : "") +
              ": " + files.length + " files");

  if (entry.recursive !== false && depth < 5) {
    // Subfolder names become tags. With subfoldersAre:"module" the first level of
    // subfolders sets the module and anything deeper sets the project, so the shape
    // of the Figma folder drives the directory's filters.
    const asModule = entry.subfoldersAre === "module" && depth === 0;
    for (const sf of await subFolders(id)) {
      await expandFolder({
        id: sf.id,
        module:      asModule ? (sf.name || entry.module) : entry.module,
        projectName: asModule ? entry.projectName : (sf.name || entry.projectName),
        recursive:   entry.recursive,
        subfoldersAre: entry.subfoldersAre
      }, out, depth + 1, seenFolders);
    }
  }
}

/* ---------- run ---------- */

function keyFromLink(link) {
  const m = String(link || "").match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]{15,})/);
  return m ? m[1] : "";
}

/* ---------- count-only mode ---------- */
// Answers "how many files are in these folders?" without indexing anything.
// A few calls per folder, seconds to run, and it writes nothing.

async function countFolder(id, seen) {
  if (seen.has(id)) return { files: 0, subs: 0, approx: false };
  seen.add(id);

  let files = 0, subs = 0, approx = false;
  try {
    files = (await folderFiles(id)).length;          // files sitting directly in this folder
  } catch (e) {
    // Listing needs folders:read. Folder metadata needs only folder_metadata:read,
    // so fall back to it - but its count may not include subfolders.
    const meta = await tryGet(API + "/v2/folders/" + id + "/meta");
    if (meta.ok && meta.json && typeof meta.json.file_count === "number") {
      return { files: meta.json.file_count, subs: 0, approx: true };
    }
    throw e;
  }

  for (const sf of await subFolders(id)) {
    subs++;
    const r = await countFolder(String(sf.id), seen);
    files += r.files; subs += r.subs; approx = approx || r.approx;
  }
  return { files, subs, approx };
}

if (COUNT_ONLY) {
  const folders = Array.isArray(config.folders) ? config.folders : [];
  if (!folders.length) { console.error("No \"folders\" in " + CONFIG_PATH + " to count."); process.exit(1); }

  const rows = [];
  let total = 0, totalSubs = 0, failed = 0, anyApprox = false;

  for (const fe of folders) {
    const id = folderIdFrom(fe.id || fe.folder || fe.link);
    const label = fe.module || fe.projectName || id || "(unnamed)";
    if (!id) { rows.push([label, "-", "no usable folder id or link"]); failed++; continue; }
    try {
      const r = await countFolder(id, new Set());
      total += r.files; totalSubs += r.subs; anyApprox = anyApprox || r.approx;
      rows.push([label, id, r.files + " files" + (r.subs ? ", " + r.subs + " subfolders" : "") +
                              (r.approx ? " (from folder metadata - may miss subfolders)" : "")]);
      console.log(label + ": " + r.files + " files");
    } catch (e) {
      failed++;
      const why = (e && e.kind === "token")
        ? "403 - token missing folders:read, or cannot see this folder"
        : ((e && e.message) || String(e));
      rows.push([label, id, "FAILED: " + why]);
      console.warn(label + ": FAILED - " + why);
    }
  }

  const sum = [
    "## Figma folder file count",
    "",
    "**" + total + " files** across " + folders.length + " folders" +
      (totalSubs ? " (" + totalSubs + " subfolders walked)" : "") +
      (failed ? ", **" + failed + " folder(s) could not be read**" : ""),
    anyApprox ? "\nSome counts came from folder metadata and may not include subfolders.\n" : "",
    "",
    "| Module | Folder | Files |",
    "|---|---|---|",
    ...rows.map(r => "| " + r[0] + " | " + r[1] + " | " + r[2] + " |"),
    "",
    "_Nothing was indexed and nothing was written. Run without \"Count files only\" to index._"
  ].join("\n");

  console.log("\n" + sum);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, sum + "\n");
  process.exit(failed ? 1 : 0);
}

// Config is the source of truth. It can name folders (every file inside is picked up
// automatically), individual files, or both. An entry only needs a "link".
const discovered = [];
if (Array.isArray(config.folders) && config.folders.length) {
  console.log("Discovering files in " + config.folders.length + " folder(s)...");
  const seenFolders = new Set();
  for (const fe of config.folders) await expandFolder(fe, discovered, 0, seenFolders);
  console.log("Discovered " + discovered.length + " file(s) from folders.");
}
const cleanDiscovery = discoveryNotes.length === 0;

const entries = [];
const skipped = [];
const byId = new Map();
// Explicit "files" entries come last so they can re-tag a file a folder brought in.
for (const f of [...discovered, ...(Array.isArray(config.files) ? config.files : [])]) {
  const id = (f.id || keyFromLink(f.link) || "").trim();
  if (!id) { console.warn("Skipping a config entry with no id or usable link: " + JSON.stringify(f)); continue; }
  const have = byId.get(id);
  if (have) {
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") have[k] = v;
    continue;
  }
  const e = { ...f, id };
  const hay = [id, e.name || ""].map(x => String(x).toLowerCase());
  if (skips.some(sk => hay.some(h => h === sk || (sk.length > 3 && h.includes(sk))))) {
    console.log("Skipping (listed in \"skip\"): " + (e.name || id));
    skipped.push(e.name || id);
    continue;
  }
  byId.set(id, e);
  entries.push(e);
}
const seenIds = new Set(byId.keys());

// Never publish an empty directory over a populated one.
if (!entries.length) {
  console.error("No files to index. " + (discoveryNotes.length
    ? "Folder discovery failed: " + discoveryNotes.join("; ")
    : "Add folders or files to " + CONFIG_PATH + "."));
  process.exit(1);
}

function tagsChanged(prev, entry) {
  return (prev.projectName || "Untagged") !== (entry.projectName || "Untagged") ||
         (prev.module || "Other") !== (entry.module || "Other") ||
         (entry.link && prev.link !== entry.link);
}

// When discovery was incomplete we keep everything we already had, so a folder the
// API refused for one run cannot quietly delete files from the live directory.
function assemble(partial) {
  const recs = entries.map(e => results.get(e.id) || (partial ? prevById.get(e.id) : null)).filter(Boolean);
  if (!cleanDiscovery) {
    const have = new Set(recs.map(r => r.id));
    for (const [id, rec] of prevById) if (!have.has(id)) recs.push(rec);
  }
  return recs;
}

function writeOutputs(records) {
  const json = JSON.stringify(records);
  fs.writeFileSync(DATA_PATH + ".tmp", json);
  fs.renameSync(DATA_PATH + ".tmp", DATA_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    settingsHash, lastRun: new Date().toISOString(), files: records.length
  }, null, 2) + "\n");
  return json.length;
}

const results = new Map();     // id -> record, in config order at the end
const report = [];             // rows for the run summary
let failed = 0, stoppedBy = null, tokenErrorsInARow = 0;

console.log("Figma Directory refresh - " + entries.length + " files" +
  (FULL ? " (full re-index)" : "") + (settingsChanged ? " (label/skip settings changed - full re-index)" : "") +
  (ONLY ? " (only: " + ONLY + ")" : "") + (ONLY_MODULE ? " (module: " + ONLY_MODULE + ")" : ""));

for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  const prev = prevById.get(entry.id);
  const tag = "[" + (i + 1) + "/" + entries.length + "] " + (prev ? prev.name : entry.name || entry.id);

  const selected =
    (!ONLY || entry.id.toLowerCase() === ONLY ||
      String(prev ? prev.name : entry.name || "").toLowerCase().includes(ONLY)) &&
    (!ONLY_MODULE || String(entry.module || "").toLowerCase().includes(ONLY_MODULE));

  if (stoppedBy || !selected) {
    if (prev) results.set(entry.id, { ...prev, projectName: entry.projectName || prev.projectName,
                                      module: entry.module || prev.module, link: entry.link || prev.link });
    if (stoppedBy && selected) report.push([tag, "not reached - kept previous data"]);
    continue;
  }

  try {
    // Cheap check first: has this file changed since we last indexed it?
    if (prev && !FULL && !settingsChanged && (!settings.indexWords || (prev.words || []).length)) {
      const head = await figmaGet(API + "/v1/files/" + entry.id + "?depth=1");
      if (head.lastModified && head.lastModified === prev.lastModified) {
        results.set(entry.id, { ...prev, name: head.name || prev.name,
          projectName: entry.projectName || "Untagged", module: entry.module || "Other", link: entry.link || prev.link });
        report.push([tag, tagsChanged(prev, entry) ? "unchanged - tags updated" : "unchanged"]);
        console.log(tag + " - unchanged");
        continue;
      }
    }

    apiCalls = 0;
    const t0 = Date.now();
    const { rec, stats } = await indexOne(entry);
    results.set(entry.id, rec);
    const secs = Math.round((Date.now() - t0) / 1000);
    const line = stats.labels + " labels, " + stats.pages + " pages, " + stats.words + " words, " +
      apiCalls + " calls, " + secs + "s" + (stats.unreadable ? ", " + stats.unreadable + " branches unreadable" : "");
    report.push([tag.replace(/\] .*/, "] ") + rec.name, (prev ? "re-indexed: " : "new: ") + line]);
    console.log(tag + " - " + line);

    tokenErrorsInARow = 0;
    // Save as we go, so a timeout or crash still keeps the work done so far.
    writeOutputs(assemble(true));
  } catch (e) {
    failed++;
    const msg = (e && e.message) || String(e);
    console.warn(tag + " - FAILED: " + msg);
    report.push([tag, "FAILED: " + msg + (prev ? " - kept previous data" : "")]);
    if (prev) results.set(entry.id, prev);
    // One 403 can be a single file the token can't open; two in a row means the token itself is bad.
    tokenErrorsInARow = e && e.kind === "token" ? tokenErrorsInARow + 1 : 0;
    if (tokenErrorsInARow >= 2) stoppedBy = msg + " - renew FIGMA_TOKEN in repo secrets";
    if (e && e.kind === "ratelimit") stoppedBy = msg;
    continue;
  }
}

const finalRecords = assemble(false);
const bytes = writeOutputs(finalRecords);
const removed = cleanDiscovery ? [...prevById.keys()].filter(id => !seenIds.has(id)).length : 0;

const summary = [
  "## Figma Directory refresh",
  "",
  finalRecords.length + " files in the directory, " + (bytes / 1048576).toFixed(2) + " MB" +
    (removed ? ", " + removed + " removed (no longer in config)" : "") +
    (failed ? ", **" + failed + " failed**" : ""),
  stoppedBy ? "\n**Run stopped early:** " + stoppedBy + "\n" : "",
  skipped.length ? "\nSkipped by config: " + skipped.join(", ") + "\n" : "",
  discoveryNotes.length
    ? "\n**Folder discovery had problems** (nothing was removed from the directory as a result):\n\n" +
      discoveryNotes.map(n => "- " + n).join("\n") + "\n"
    : "",
  "| File | Result |",
  "|---|---|",
  ...report.map(r => "| " + r[0].replace(/\|/g, "/") + " | " + r[1].replace(/\|/g, "/") + " |")
].join("\n");

console.log("\n" + summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");

// Non-zero exit makes GitHub email the account - but outputs are already written,
// so the commit step still publishes everything that did succeed.
process.exit(failed ? 1 : 0);
