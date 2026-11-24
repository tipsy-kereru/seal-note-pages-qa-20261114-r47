import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

function problem(message, state = "failed") {
  return Object.assign(new Error(message), { state });
}

// Only CDP uses loopback. The page cannot make real network requests. Chromium receives
// the captured HTTP responses at their original URLs, preserving project-base resolution.
async function withBrowser(records, inspect) {
  const chrome = [process.env.PAGES_QA_CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(p => p && existsSync(p));
  if (!chrome) throw problem("set PAGES_QA_CHROME to an installed Chromium executable", "unavailable");
  const profile = mkdtempSync(join(tmpdir(), "seal-pages-qa-"));
  const child = spawn(chrome, ["--headless=new", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "--no-first-run",
    "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-background-networking",
    "--disable-component-update", "--disable-quic", "--disable-gpu", "--disk-cache-size=1",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const stopped = once(child, "close").catch(() => {});
  let socket;
  try {
    // Chromium publishes its listening port in the dedicated profile. Hosted runners
    // can emit a burst of unrelated stderr after the announcement, or start slowly.
    let port, launchError, diagnostic = "", tail = "";
    child.once("error", () => { launchError = true; });
    child.stderr.on("data", data => {
      const log = tail + data.toString();
      tail = log.slice(-160);
      port ||= /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)?.[1];
      if (/No usable sandbox|Failed to move to new namespace|sandbox.*Operation not permitted/i.test(log)) diagnostic = " (sandbox)";
      if (/error while loading shared libraries/i.test(log)) diagnostic = " (shared library)";
    });
    const deadline = Date.now() + 35_000;
    while (!port && Date.now() < deadline) {
      if (launchError || child.exitCode !== null || child.signalCode) {
        throw problem("Chromium exited before CDP readiness" + diagnostic, "unavailable");
      }
      try {
        const active = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
        port = /^([1-9]\d{0,4})\r?\n\/devtools\/browser\//.exec(active)?.[1];
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (!port) await delay(200);
    }
    if (!port || Number(port) > 65535) throw problem("Chromium CDP readiness timed out" + diagnostic, "unavailable");
    const local = `127.0.0.1:${port}`;
    const list = await fetch(`http://${local}/json/list`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const tab = (await list.json()).find(t => t.type === "page" && t.url === "about:blank");
    if (!tab?.webSocketDebuggerUrl.startsWith(`ws://${local}/devtools/page/`)) throw problem("Chromium tab unavailable", "unavailable");
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    let id = 0;
    const pending = new Map();
    const blocked = [];
    socket.onclose = () => {
      for (const finish of pending.values()) finish({ error: true });
      pending.clear();
    };
    function command(method, params = {}) {
      const key = ++id;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(key); reject(problem("Chromium command timeout", "unavailable")); }, 12_000);
        pending.set(key, reply => {
          clearTimeout(timeout);
          if (reply.error) reject(problem("Chromium command failed: " + method, "unavailable"));
          else resolve(reply.result);
        });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    }
    socket.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } else if (m.method === "Fetch.requestPaused") {
        const { requestId, request, resourceType } = m.params;
        const record = records.get(request.url);
        if (record && request.method === "GET") {
          const headers = ["content-type", "content-security-policy", "x-content-type-options", "referrer-policy"]
            .filter(k => record.headers.has(k)).map(k => ({ name: k, value: record.headers.get(k) }));
          headers.push({ name: "Content-Security-Policy", value: "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'" });
          command("Fetch.fulfillRequest", { requestId, responseCode: record.status, responseHeaders: headers,
            body: record.bytes.toString("base64") }).catch(() => blocked.push("response replay"));
        } else {
          // Chromium itself requests the origin's favicon even when the document has no icon.
          if (!(resourceType === "Other" && request.url === new URL("/favicon.ico", records.keys().next().value).href)) {
            blocked.push(resourceType);
          }
          command("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
        }
      }
    };
    await command("Page.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await command("Network.enable");
    await command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    async function evaluate(expression) {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw problem("browser DOM inspection failed");
      return result.result.value;
    }
    async function visit(url, click) {
      if (click === undefined) await command("Page.navigate", { url });
      else await evaluate(`document.querySelectorAll("a[href]")[${click}].click()`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`)) return;
        await delay(40);
      }
      throw problem("browser navigation did not reach the checked destination");
    }
    const result = await inspect(visit, evaluate);
    if (blocked.length) throw problem("browser requested an unapproved resource (" + blocked[0] + ")");
    return result;
  } finally {
    socket?.close();
    child.kill();
    await stopped;
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

// Executed in the rendered document, including publisher templates and the response CSP.
async function measure(baseCss, linkedBase, site) {
  if (document.querySelector('base, meta[http-equiv="refresh" i]')) return { error: "unexpected base or redirect" };
  const article = document.querySelector("article.seal-note-document.markdown-body");
  if (!article || !article.querySelector("h1")) return { error: "generated article missing" };
  const sheets = [...document.querySelectorAll('style, link[rel~="stylesheet"]')];
  if (sheets.some(el => el.tagName === "LINK" && !el.href.startsWith(site))) return { error: "unapproved stylesheet URL" };
  if (!sheets.length || sheets.some(el => !el.sheet || el.sheet.disabled || !el.sheet.cssRules.length)) {
    return { error: "stylesheet unavailable or empty" };
  }
  const baseInline = sheets.some(el => el.tagName === "STYLE" && el.textContent.includes(baseCss));
  if (!baseInline && !sheets.some(el => linkedBase.includes(el.href))) return { error: "static document CSS missing" };
  const signature = () => {
    const s = getComputedStyle(article);
    return { color: s.color, boxSizing: s.boxSizing, lineHeight: s.lineHeight, fontFamily: s.fontFamily };
  };
  const style = signature();
  // The renderer appends optional custom CSS after its final paragraph rule.
  // The uncustomized built-ins also have exact, independently checkable computed values.
  if (sheets.length === 1 && baseInline && sheets[0].textContent.trimEnd().endsWith("p{white-space:pre-wrap}")) {
    const compact = article.classList.contains("compact-note");
    const expectedLine = parseFloat(getComputedStyle(article).fontSize) * (compact ? 1.6 : 1.8);
    const actualLine = parseFloat(style.lineHeight);
    if (style.boxSizing !== "border-box" || style.color !== "rgb(32, 49, 59)"
      || !Number.isFinite(actualLine) || Math.abs(actualLine - expectedLine) > 0.01 || !style.fontFamily.includes("monospace")) {
      return { error: "built-in computed document style differs" };
    }
  }
  const base = getComputedStyle(article).getPropertyValue("--content-width").trim();
  for (const el of sheets) el.sheet.disabled = true;
  const plain = signature();
  for (const el of sheets) el.sheet.disabled = false;
  if (!base || JSON.stringify(style) === JSON.stringify(plain)) return { error: "document CSS has no expected computed effect" };
  const images = [];
  for (const img of document.images) {
    img.loading = "eager";
    try { await img.decode(); } catch { return { error: "image decode failed" }; }
    if (!img.naturalWidth || !img.naturalHeight) return { error: "image has no dimensions" };
    images.push({ url: img.currentSrc, width: img.naturalWidth, height: img.naturalHeight });
  }
  const links = [...document.querySelectorAll("a[href]")].map(a => ({
    raw: a.getAttribute("href"), url: a.href, target: a.target, ping: a.hasAttribute("ping"), download: a.hasAttribute("download"),
  }));
  return { style, inlineSheets: sheets.filter(el => el.tagName === "STYLE").length,
    stylesheets: sheets.filter(el => el.tagName === "LINK").map(el => el.href), images, links };
}

export function resolveLink(raw, page, site, records) {
  if (!raw || /[\s\\<>"'\u0000-\u001f\u007f]/u.test(raw) || /^\/\//.test(raw)) throw problem("unsafe link syntax");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1].toLowerCase();
  if (scheme && !["https", "http", "mailto"].includes(scheme)) throw problem("external scheme unsafe; structure unchecked");
  let u;
  try { u = new URL(raw, page); } catch { throw problem("invalid link URL"); }
  if (u.username || u.password || /%(?:0a|0d|00)/i.test(raw)) throw problem("unsafe link structure");
  if ((scheme === "https" || scheme === "http") && !/^https?:\/\/[^/]/i.test(raw)) throw problem("HTTP link structure invalid");
  if (u.origin !== new URL(site).origin) {
    if (/^https?:\/\/[^/]/i.test(raw) && u.hostname) return { external: u.protocol.slice(0, -1) };
    if (scheme === "mailto" && u.pathname.split(",").every(address => /^[^/?#@]+@[a-z\d.-]+$/i.test(address))
        && !u.hash) return { external: "mailto" };
    throw problem("external address structure invalid");
  }
  const href = u.href;
  let fragment;
  try { fragment = decodeURIComponent(u.hash.slice(1)); } catch { throw problem("invalid anchor encoding"); }
  u.hash = "";
  if (!u.href.startsWith(site) || !records.has(u.href)) throw problem("internal link outside generated files");
  return { href, resource: u.href, fragment };
}

export async function checkBrowser(site, records) {
  const baseCss = readFileSync(new URL("../knowledge/templates/clean-note.css", import.meta.url), "utf8").replaceAll("\r\n", "\n").trim();
  const linkedBase = [...records].filter(([url, r]) => url.endsWith(".css")
    && r.bytes.toString("utf8").replaceAll("\r\n", "\n").includes(baseCss)).map(([url]) => url);
  const inspect = async (visit, evaluate) => {
    const pages = [...records.keys()].filter(url => url === site || url.endsWith(".html"));
    const results = [];
    const homeTargets = new Set();
    for (const page of pages) {
      const path = page.slice(site.length) || "/";
      try {
        await visit(page);
        const data = await evaluate(`(${measure})(${JSON.stringify(baseCss)}, ${JSON.stringify(linkedBase)}, ${JSON.stringify(site)})`);
        if (data.error) throw problem(data.error);
        const resourcePath = url => {
          if (!url.startsWith(site) || !records.has(url)) throw problem("unapproved resource");
          return url.slice(site.length);
        };
        const images = data.images.map(({ url, width, height }) => ({ path: resourcePath(url), width, height }));
        const stylesheetPaths = data.stylesheets.map(resourcePath);
        for (const url of data.stylesheets) {
          const record = records.get(url);
          if (record.status !== 200 || record.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/css") {
            throw problem("stylesheet HTTP status or MIME differs: " + resourcePath(url));
          }
        }
        const external = {};
        const internal = [];
        for (const [index, anchor] of data.links.entries()) {
          const link = resolveLink(anchor.raw, page, site, records);
          if (link.external) {
            external[link.external] ??= { safeScheme: true, validStructure: true, visited: false, count: 0 };
            external[link.external].count++;
            continue;
          }
          if (anchor.url !== link.href || anchor.target || anchor.ping || anchor.download) throw problem("unexpected internal link behavior");
          await visit(page);
          await visit(link.href, index);
          if (link.fragment && !(link.resource.includes("/assets/") && /^t=[\d.,:]+$/.test(link.fragment))) {
            const fragment = JSON.stringify(link.fragment);
            if (!await evaluate(`!!document.getElementById(${fragment}) || [...document.anchors].some(a => a.name === ${fragment})`)) {
              throw problem("anchor target missing: " + (link.resource.slice(site.length) || "/"));
            }
          }
          internal.push({ path: link.resource.slice(site.length) || "/", anchor: Boolean(link.fragment) });
          if (page === site) homeTargets.add(link.resource);
        }
        results.push({ path, style: data.style, inlineSheets: data.inlineSheets, stylesheetPaths, images, internal, external });
      } catch (e) {
        if (!e.state) throw e;
        throw problem(path + ": " + e.message, e.state);
      }
    }
    if (pages.some(url => url !== site && url !== site + "index.html" && !homeTargets.has(url))) {
      throw problem("home index is missing a published note");
    }
    return results;
  };
  try { return await withBrowser(records, inspect); }
  catch (e) {
    if (e.state !== "unavailable" || e.message !== "Chromium CDP readiness timed out") throw e;
    // Reuse the same captured bytes, with exactly one fresh isolated browser.
    return withBrowser(records, inspect);
  }
}
