import { Verdict, fence, gitBlob, publicRead, stabilize } from "./scripts/pages-qa.mjs";

const marker = ".seal-pages.json";
const tombstone = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Publication withdrawn</title></head><body><p>Publication withdrawn.</p></body></html>');
const sha1 = /^[a-f0-9]{40}$/;
function expect(ok, state, reason) { if (!ok) throw new Verdict(state, reason); }

function docs(sha, get) {
  const tree = get(`/git/trees/${sha}?recursive=1`);
  expect(tree.truncated === false, "unavailable", "incomplete docs tree");
  return new Map(tree.tree.filter(e => e.path.startsWith("docs/")).map(e => [e.path.slice(5), e]));
}
function manifest(tree, get) {
  const file = tree.get(marker);
  expect(file?.mode === "100644" && sha1.test(file.sha) && file.size <= 1024 * 1024, "failed", "invalid withdrawal manifest blob");
  const blob = get("/git/blobs/" + file.sha);
  const bytes = Buffer.from(blob.content, "base64");
  expect(blob.encoding === "base64" && gitBlob(bytes) === file.sha, "unavailable", "Git manifest integrity differs");
  try { return { bytes, value: JSON.parse(bytes) }; }
  catch { throw new Verdict("failed", "invalid manifest JSON"); }
}

// Called only after the normal checker verified the event and declined this manifest.
export async function inspectWithdrawal(result, get, read = publicRead) {
  const evidence = { ...result };
  delete evidence.reason;
  try {
    const tree = docs(result.sha, get);
    const { bytes, value } = manifest(tree, get);
    if (value?.withdrawn !== true) return result;
    expect(value.format === "seal-note.public-site" && value.version === 1 &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.publicationId) &&
      Object.keys(value).sort().join(",") === "format,publicationId,version,withdrawn",
      "failed", "withdrawal marker fields differ");
    expect(tree.size === 3 && tree.get("index.html")?.mode === "100644" &&
      tree.get("index.html").sha === gitBlob(tombstone) && tree.get(".nojekyll")?.mode === "100644" &&
      tree.get(".nojekyll").sha === gitBlob(Buffer.alloc(0)), "failed", "withdrawal tree or neutral HTML differs");
    const parents = get("/git/commits/" + result.sha).parents;
    expect(parents?.length === 1 && sha1.test(parents[0].sha), "unavailable", "no unique parent publication");
    const prior = manifest(docs(parents[0].sha, get), get).value;
    expect(prior?.format === value.format && prior.version === 1 && prior.publicationId === value.publicationId &&
      !prior.withdrawn && prior.files && Object.hasOwn(prior.files, "index.html"), "unavailable", "parent publication identity differs");
    const removed = Object.keys(prior.files).filter(path => path !== "index.html" && path !== ".nojekyll");
    expect(removed.length > 0 && removed.length <= 1000, "unavailable", "parent file inventory cannot be checked");
    const expected = new Map([[marker, bytes], [".nojekyll", Buffer.alloc(0)], ["index.html", tombstone], ["", tombstone]]);
    return await stabilize(async attempts => {
      const age = Date.now() - Date.parse(result.successTime);
      const mismatch = age >= 0 && age < 120000 ? "pending" : "failed";
      try {
        fence(result.deployment, result.status, get);
        try {
          for (const [path, body] of expected) {
            const r = await read(path, body.length);
            expect(r.status === 200 && r.size === body.length && r.bytes.equals(body), mismatch, "withdrawal body differs: " + (path || "/"));
            if (path === "" || path === "index.html") {
              expect(r.headers.get("content-type")?.split(";")[0].trim() === "text/html", "failed", "withdrawal HTML MIME differs");
            }
          }
          for (const path of removed) {
            const r = await read(path, 0); // Uses the same generated-path allowlist and redirect guard.
            expect([404, 410].includes(r.status), mismatch, "withdrawn public path still responds: " + path);
          }
        } finally { fence(result.deployment, result.status, get); }
        return { ...evidence, state: "withdrawn_verified", attempts, parent: parents[0].sha, removed };
      } catch (e) { return { ...evidence, state: e.state || "unavailable", reason: e.state ? e.message : "withdrawal inspection unavailable", attempts }; }
    });
  } catch (e) { return { ...evidence, state: e.state || "unavailable", reason: e.state ? e.message : "withdrawal contract unavailable" }; }
}
