// Jira cross-reference for the Figma Directory.
//
// For each Figma file already in the directory's index, asks Jira which work
// items mention that file's key — in a summary, a description or a comment —
// and writes the answer next to the index as jira-index.bin.
//
// Reads:  <dir>/figma-directory-data.bin   (the index, sealed or not)
// Writes: <dir>/jira-index.bin             (sealed with the same SITE_KEY)
//
// Needs: JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN. Set SITE_KEY to seal the output.

import fs from "node:fs";
import { seal, unseal, readKey } from "./seal.mjs";

const DATA_PATH = process.env.DATA_PATH || "ets/figma-directory-data.bin";
const OUT_PATH  = process.env.JIRA_PATH || "ets/jira-index.bin";
const SITE      = (process.env.JIRA_SITE || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
const EMAIL     = (process.env.JIRA_EMAIL || "").trim();
const TOKEN     = (process.env.JIRA_TOKEN || "").trim();
const SITE_KEY  = readKey(process.env.SITE_KEY);
// A run that collapses is almost always Jira saying no, not 1,200 tickets
// vanishing. Below this share of last week's total the result is not published.
const FLOOR     = Number(process.env.MIN_RETAIN || 0.5);

if (!SITE || !EMAIL || !TOKEN) {
  console.error("Set JIRA_SITE (e.g. moveinsync.atlassian.net), JIRA_EMAIL and JIRA_TOKEN.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(EMAIL + ":" + TOKEN).toString("base64");
const BASE = "https://" + SITE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Jira ---------- */

// The old /rest/api/3/search was removed from Jira Cloud. This is its
// replacement, and it pages on nextPageToken rather than startAt.
async function jql(query, token) {
  const u = new URL(BASE + "/rest/api/3/search/jql");
  u.searchParams.set("jql", query);
  u.searchParams.set("fields", "summary,status");
  u.searchParams.set("maxResults", "100");
  if (token) u.searchParams.set("nextPageToken", token);

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(u, { headers: { Authorization: AUTH, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 2000 * (attempt + 1);
      console.log("    " + res.status + " - waiting " + Math.round(wait / 1000) + "s");
      await sleep(wait);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("Jira rejected the credentials (" + res.status + ")"), { fatal: true });
    }
    if (!res.ok) throw new Error("Jira HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
    return res.json();
  }
  throw new Error("Jira kept refusing after 5 attempts");
}

async function ticketsFor(fileKey) {
  const out = [];
  let token = null;
  do {
    const d = await jql('text ~ "' + fileKey + '" ORDER BY created DESC', token);
    for (const it of (d.issues || [])) {
      out.push({
        k: it.key,
        s: ((it.fields || {}).status || {}).name || "",
        t: ((it.fields || {}).summary || "").slice(0, 300)
      });
    }
    token = d.nextPageToken || null;
  } while (token);
  return out;
}

/* ---------- run ---------- */

const files = unseal(fs.readFileSync(DATA_PATH), SITE_KEY);
if (!Array.isArray(files) || !files.length) {
  console.error("No files in " + DATA_PATH + " - nothing to cross-reference.");
  process.exit(1);
}

let prevTotal = 0;
try {
  const old = unseal(fs.readFileSync(OUT_PATH), SITE_KEY);
  for (const v of Object.values(old.files || {})) prevTotal += (v.tickets || []).length;
} catch {}

console.log("Jira cross-reference - " + files.length + " files against " + SITE +
            (prevTotal ? " (last run: " + prevTotal + " pairs)" : ""));

const out = { generated: new Date().toISOString().slice(0, 10), source: SITE,
              base: BASE + "/browse/", files: {} };
let pairs = 0, withTickets = 0, errors = 0;

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const tag = "[" + (i + 1) + "/" + files.length + "] " + (f.name || f.id);
  try {
    const tk = await ticketsFor(f.id);
    out.files[f.id] = { tickets: tk };
    pairs += tk.length;
    if (tk.length) withTickets++;
    console.log(tag.padEnd(46) + tk.length + " ticket" + (tk.length === 1 ? "" : "s"));
  } catch (e) {
    if (e && e.fatal) { console.error("\n" + e.message); process.exit(1); }
    errors++;
    out.files[f.id] = { tickets: [] };
    console.log(tag.padEnd(46) + "failed - " + (e && e.message ? e.message.slice(0, 80) : e));
  }
  await sleep(120);               // polite pacing, not a rate limit we have hit
}

const unique = new Set();
for (const v of Object.values(out.files)) for (const t of v.tickets) unique.add(t.k);

if (prevTotal && pairs < prevTotal * FLOOR) {
  console.error("\nOnly " + pairs + " pairs against last run's " + prevTotal +
                ". That looks like Jira refusing, not tickets disappearing - " +
                OUT_PATH + " left untouched.");
  process.exit(1);
}

const { buf, sealed } = seal(out, SITE_KEY);
fs.writeFileSync(OUT_PATH + ".tmp", buf);
fs.renameSync(OUT_PATH + ".tmp", OUT_PATH);

const sum = [
  "### Jira cross-reference",
  "",
  "| | |",
  "|---|---|",
  "| Figma files checked | " + files.length + " |",
  "| Files with tickets | " + withTickets + " |",
  "| Unique tickets | " + unique.size + " |",
  "| Ticket-file pairs | " + pairs + (prevTotal ? " (was " + prevTotal + ")" : "") + " |",
  "| Lookups that failed | " + errors + " |",
  "| Published | " + Math.round(buf.length / 1024) + " KB" + (sealed ? ", sealed" : ", unsealed") + " |"
].join("\n");
console.log("\n" + sum.replace(/\|/g, " "));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, sum + "\n");
