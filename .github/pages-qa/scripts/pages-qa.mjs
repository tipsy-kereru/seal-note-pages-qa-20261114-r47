// Post-deployment reader. All inputs from a webhook are values, never URLs or commands.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { checkBrowser } from "./pages-qa-browser.mjs";

const repository = "tipsy-kereru/seal-note-pages-qa-20261114-r47";
const repositoryId = 1469361731;
export const site = "https://tipsy-kereru.github.io/seal-note-pages-qa-20261114-r47/";
const runPrefix = `https://github.com/${repository}/actions/runs/`;
const manifestPath = ".seal-pages.json";
const sha1 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const publicFile = /^(?:\.nojekyll|[a-z0-9-]{1,80}\.html|(?:assets\/)?[a-z0-9-]+\.css|assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|avif|gif|mp3|wav|ogg|m4a|mp4|webm|mov))$/;
const maxBytes = 64 * 1024 * 1024;
const exits = { passed: 0, failed: 1, pending: 2, unavailable: 3 };

export class Verdict extends Error {
  constructor(state, message) {
    super(message);
    this.state = state;
  }
}
function requireThat(condition, state, message) {
  if (!condition) throw new Verdict(state, message);
}
function digest(algorithm, data) {
  return createHash(algorithm).update(data).digest("hex");
}
export function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
function api(path = "") {
  try {
    // Numeric repository routes stay bound to the authorized repository through renames.
    return JSON.parse(execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET",
      `repositories/${repositoryId}${path}`], {
      timeout: 20_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, env: { ...process.env, GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
    }));
  } catch {
    throw new Verdict("unavailable", "GitHub GET unavailable: " + (path || "repository"));
  }
}
export function eventEvidence(evidence, get = api) {
  const { deployment, status, sha } = evidence;
  const repo = get();
  requireThat(repo.id === repositoryId && repo.full_name === repository && repo.private === false,
    "unavailable", "repository identity or visibility differs");
  const pages = get("/pages");
  requireThat(pages.public && pages.html_url === site && pages.source?.branch === "main"
    && pages.source?.path === "/docs" && pages.build_type === "legacy", "unavailable", "Pages source differs");
  const path = `/deployments/${deployment}`;
  const d = get(path);
  const s = get(`${path}/statuses/${status}`);
  requireThat(String(d.id) === deployment && d.sha === sha && d.environment === "github-pages" && d.ref === "main"
    && String(s.id) === status && s.deployment_url === `https://api.github.com/repos/${repository}${path}`
    && s.environment === "github-pages" && s.state === "success" && s.environment_url === site,
    "unavailable", "deployment or successful status does not match the event");
  const log = String(s.log_url);
  const match = log.startsWith(runPrefix) && /^(\d+)(?:\/job\/\d+)?$/.exec(log.slice(runPrefix.length));
  requireThat(match, "unavailable", "success status has no approved run link");
  evidence.run = runPrefix + match[1];
  evidence.successTime = s.created_at;
  const run = get("/actions/runs/" + match[1]);
  requireThat(run.repository?.id === repositoryId && run.head_repository?.id === repositoryId && run.head_sha === sha
    && run.head_branch === "main" && run.html_url === runPrefix + match[1]
    && run.path === "dynamic/pages/pages-build-deployment", "unavailable", "Pages run identity differs");
  requireThat(run.status === "completed", "pending", "Pages run has not completed");
  requireThat(run.conclusion === "success", "unavailable", "Pages run was unsuccessful");
}
export function fence(deployment, status, get = api) {
  // Observe later activity only as a fence. Never inspect its tree or use it as the target.
  const newest = get("/deployments?environment=github-pages&per_page=1")[0];
  const current = get(`/deployments/${deployment}/statuses?per_page=1`)[0];
  requireThat(String(newest?.id) === deployment && String(current?.id) === status && current.state === "success",
    "unavailable", "a different deployment or status is current; this event cannot be attributed");
}
function inventory(sha) {
  const tree = api(`/git/trees/${sha}?recursive=1`);
  requireThat(tree.truncated === false, "unavailable", "Git tree is incomplete");
  const docs = new Map(tree.tree.filter(e => e.path.startsWith("docs/")).map(e => [e.path.slice(5), e]));
  const entry = docs.get(manifestPath);
  requireThat(entry?.mode === "100644" && sha1.test(entry.sha), "failed", "docs/.seal-pages.json missing or invalid");
  const blob = api("/git/blobs/" + entry.sha);
  const bytes = Buffer.from(blob.content, "base64");
  requireThat(blob.encoding === "base64" && gitBlob(bytes) === entry.sha, "unavailable", "Git manifest blob integrity failed");
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw new Verdict("failed", "docs/.seal-pages.json is invalid JSON"); }
  requireThat(manifest?.format === "seal-note.public-site" && manifest.version === 1 && !manifest.withdrawn
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(manifest.publicationId)
    && manifest.files && Object.hasOwn(manifest.files, ".nojekyll") && Object.hasOwn(manifest.files, "index.html")
    && Object.keys(manifest.files).some(p => p !== "index.html" && p.endsWith(".html")),
    "failed", "docs/.seal-pages.json is not a normal v1 publication");
  const expected = new Map();
  for (const [path, hash] of Object.entries(manifest.files)) {
    requireThat(publicFile.test(path) && sha256.test(hash), "failed", "invalid generated path or digest in manifest");
    const git = docs.get(path);
    requireThat(git?.mode === "100644" && git.type === "blob" && sha1.test(git.sha), "failed", "missing Git file: docs/" + path);
    if (path.startsWith("assets/") && !path.endsWith(".css")) {
      requireThat(path.slice(7, 71) === hash, "failed", "content address differs: " + path);
    }
    // Require both the committed blob ID and the publisher's SHA-256 for each public GET.
    expected.set(path, { hash, git: git.sha, size: git.size });
  }
  expected.set(manifestPath, { hash: digest("sha256", bytes), git: entry.sha, size: bytes.length });
  requireThat([...expected.values()].reduce((sum, e) => sum + e.size, 0) <= maxBytes, "unavailable", "publication exceeds 64 MiB inspection limit");
  return expected;
}

export async function publicRead(path, expectedSize, get = fetch) {
  const url = new URL(path, site);
  requireThat(url.href === site + path && (!path || publicFile.test(path) || path === manifestPath),
    "failed", "out-of-scope request");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await get(url, { redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    requireThat((r.status < 300 || r.status >= 400) && !r.headers.has("refresh"), "failed", "redirect refused: " + (path || "/"));
    requireThat(![401, 403, 429].includes(r.status) && r.status < 500, "unavailable", `HTTP ${r.status}: ${path || "/"}`);
    const chunks = [];
    let size = 0;
    if (r.status === 200) {
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > expectedSize) break;
        chunks.push(chunk);
      }
    }
    return { status: r.status, bytes: Buffer.concat(chunks), size, headers: r.headers };
  } catch (e) {
    if (e instanceof Verdict) throw e;
    throw new Verdict("unavailable", "public GET unavailable: " + (path || "/"));
  } finally { clearTimeout(timeout); }
}
export async function collect(expected, recent, read = publicRead) {
  const records = new Map();
  // Manifest consistency distinguishes a different visible publication from a damaged file.
  const generated = [...expected.keys()].filter(path => path !== manifestPath);
  for (const path of [manifestPath, ...generated, ""]) {
    const e = expected.get(path || "index.html");
    const r = await read(path, e.size);
    const matches = r.status === 200 && r.size === e.size && gitBlob(r.bytes) === e.git;
    requireThat(matches, recent ? "pending" : path === manifestPath ? "unavailable" : "failed",
      `HTTP ${r.status}, pinned blob mismatch: ${path || "/"}`);
    requireThat(digest("sha256", r.bytes) === e.hash, "failed", "manifest SHA-256 mismatch: " + (path || "/"));
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!path || path.endsWith(".html")) requireThat(mime === "text/html", "failed", "HTML MIME differs: " + (path || "/"));
    if (path.endsWith(".css")) requireThat(mime === "text/css", "failed", "stylesheet MIME differs: " + path);
    records.set(site + path, r);
  }
  return records;
}

function recentSuccess(time) {
  const age = Date.now() - Date.parse(time);
  return age >= 0 && age < 120_000;
}
async function inspect(deployment, status, sha, attempts) {
  const evidence = { repositoryId, deployment, status, sha, attempts };
  try {
    eventEvidence(evidence);
    fence(deployment, status);
    const expected = inventory(sha);
    let checks;
    try {
      const records = await collect(expected, recentSuccess(evidence.successTime));
      evidence.files = [...expected].map(([path, e]) => ({ path, sha256: e.hash }));
      checks = await checkBrowser(site, records);
    } finally { fence(deployment, status); }
    return { state: "passed", ...evidence, checks };
  } catch (e) {
    return { state: e.state || "unavailable", ...evidence, reason: e.state ? e.message : "inspection could not complete" };
  }
}
export async function stabilize(inspectOnce, wait = delay) {
  const result = await inspectOnce(1);
  if (result.state !== "pending" || !recentSuccess(result.successTime)) return result;
  await wait(5000);
  return inspectOnce(2);
}
async function main() {
  const { values } = parseArgs({ options: { deployment: { type: "string" }, status: { type: "string" }, sha: { type: "string" } } });
  const { deployment, status, sha } = values;
  requireThat(/^\d{1,16}$/.test(deployment) && /^\d{1,16}$/.test(status) && sha1.test(sha),
    "unavailable", "expected --deployment ID --status SUCCESS_STATUS_ID --sha FULL_SHA");
  return stabilize(attempt => inspect(deployment, status, sha, attempt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await main(); } catch (e) {
    result = { state: "unavailable", reason: e.state ? e.message : "invalid command arguments" };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exits[result.state];
}
