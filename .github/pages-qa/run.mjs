import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectWithdrawal } from "./withdrawal.mjs";

const repo = "tipsy-kereru/seal-note-pages-qa-20261114-r47";
const repoId = 1469361731;
const workflowId = 428361625;
const site = "https://tipsy-kereru.github.io/seal-note-pages-qa-20261114-r47/";
const runBase = `https://github.com/${repo}/actions/runs/`;
const id = value => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const commit = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

function check(ok, reason) {
  if (!ok) throw new Error(reason);
}
function get(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET",
      `repositories/${repoId}${path}`], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 4 * 1024 * 1024 }));
  } catch { throw new Error("GitHub GET did not return the required evidence"); }
}

export function resolveEvent(event, name, api = get) {
  check(event.repository?.id === repoId && event.repository.full_name === repo && event.repository.private === false,
    "event repository identity differs");
  const manual = name === "workflow_dispatch";
  let runId, attempt, sha;
  if (manual) {
    const i = event.inputs;
    check(["main", "refs/heads/main"].includes(event.ref) && i && id(i.pages_run) && id(i.deployment) && id(i.status)
      && commit(i.sha), "invalid dispatch ref or exact identifiers");
    runId = i.pages_run;
    attempt = 1;
    sha = i.sha;
  } else {
    const w = event.workflow_run;
    check(name === "workflow_run" && event.action === "completed" && w?.workflow_id === workflowId &&
      w.head_repository?.id === repoId && w.conclusion === "success" && w.head_branch === "main" &&
      id(w.id) && id(w.run_attempt) && commit(w.head_sha), "unexpected workflow completion");
    runId = String(w.id);
    attempt = w.run_attempt;
    sha = w.head_sha;
  }
  const run = api(`/actions/runs/${runId}/attempts/${attempt}`);
  check(String(run.id) === runId && run.run_attempt === attempt && run.workflow_id === workflowId &&
    run.name === "pages build and deployment" && run.path === "dynamic/pages/pages-build-deployment" &&
    run.event === "dynamic" && run.head_sha === sha && run.head_branch === "main" &&
    run.repository?.id === repoId && run.head_repository?.id === repoId &&
    run.status === "completed" && run.conclusion === "success", "Pages run or attempt differs");
  const jobs = api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  check(jobs.total_count === jobs.jobs.length, "incomplete Pages job list");
  const deployJobs = jobs.jobs.filter(j => j.name === "deploy" && j.conclusion === "success" && id(j.id));
  check(deployJobs.length === 1, "ambiguous or absent successful Pages deploy job");
  const logUrl = runBase + runId + "/job/" + deployJobs[0].id;
  const deployments = manual ? [api("/deployments/" + event.inputs.deployment)] :
    api(`/deployments?sha=${sha}&environment=github-pages&per_page=100`);
  check(deployments.length < 100, "deployment candidate list may be incomplete");
  const matches = [];
  for (const d of deployments) {
    if (!id(d.id) || d.environment !== "github-pages" || d.ref !== "main" || d.sha !== sha || d.task !== "deploy") continue;
    const path = "/deployments/" + d.id;
    const statuses = manual ? [api(path + "/statuses/" + event.inputs.status)] : api(path + "/statuses?per_page=100");
    check(statuses.length < 100, "deployment status candidate list may be incomplete");
    for (const s of statuses) {
      if (id(s.id) && s.state === "success" && s.environment === "github-pages" && s.environment_url === site &&
        s.log_url === logUrl && s.deployment_url === `https://api.github.com/repos/${repo}${path}` &&
        (!manual || (String(d.id) === event.inputs.deployment && String(s.id) === event.inputs.status))) {
        matches.push({ deployment: String(d.id), status: String(s.id), sha, pagesRun: runId, attempt });
      }
    }
  }
  check(matches.length === 1, "no unique successful deployment/status bound to this SHA and Pages job");
  return matches[0];
}

async function main() {
  let summary;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const target = resolveEvent(event, process.env.GITHUB_EVENT_NAME);
    const p = spawnSync(process.execPath, ["scripts/pages-qa.mjs", "--deployment", target.deployment,
      "--status", target.status, "--sha", target.sha], { encoding: "utf8", timeout: 150000, maxBuffer: 4 * 1024 * 1024 });
    check(!p.error && Number.isInteger(p.status), "inspection did not finish");
    let result = JSON.parse(p.stdout);
    check(result.sha === target.sha && result.deployment === target.deployment && result.status === target.status &&
      (!result.run || result.run === runBase + target.pagesRun), "inspection evidence differs");
    if (result.state === "failed" && result.reason === "docs/.seal-pages.json is not a normal v1 publication") {
      result = await inspectWithdrawal(result, get);
    }
    console.log(JSON.stringify(result));
    summary = [`**${result.state}** · \`${process.env.GITHUB_EVENT_NAME}\``,
      `Commit \`${target.sha}\` · deployment \`${target.deployment}\` · success status \`${target.status}\``,
      `[Pages run ${target.pagesRun}](${runBase}${target.pagesRun}) · attempt ${target.attempt}`,
      `[QA run ${process.env.GITHUB_RUN_ID}](${runBase}${process.env.GITHUB_RUN_ID}) · checker \`f0b9cd1\``].join("\n\n");
    process.exitCode = { passed: 0, withdrawn_verified: 0, failed: 1, pending: 2, unavailable: 3 }[result.state] ?? 3;
  } catch (error) {
    // The event and HTTP bodies can contain free text. Only print our fixed evidence errors.
    const reason = error.constructor === Error ? error.message : "cannot read event or inspection evidence";
    summary = "**unavailable** · " + reason;
    console.log(summary);
    process.exitCode = 3;
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
