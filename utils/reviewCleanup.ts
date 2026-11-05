import * as yes from "yes";
import type { WriteablePayload } from "../external.ts";
import { reportReviewNodeId } from "../mcp/review.ts";
import type { ToolContext } from "../mcp/server.ts";
import { primaryRepoState } from "../toolState.ts";
import { log } from "./cli.ts";
import { isPullfrog } from "./isPullfrog.ts";
import { retryTransientOctokit } from "./isTransientNetworkError.ts";
import { patchWorkflowRunFields } from "./patchWorkflowRunFields.ts";

const RE_REVIEW_PREAMBLE =
  "Incrementally re-review the new commits on this pull request. Use the IncrementalReview mode.";

/**
 * post-agent review lifecycle: runs after the agent exits (success or timeout).
 *
 * normally the agent handles new commits inline: create_pull_request_review
 * detects HEAD movement and tells the agent to pull and review the delta.
 * this dispatch is a safety net for cases where the agent couldn't handle
 * it (timeout, error, etc).
 *
 * ordering matters: reportReviewNodeId marks this run "done" FIRST so push
 * webhooks stop being suppressed by dedup. the HEAD check runs SECOND to
 * catch any pushes that were suppressed while this run was in-flight.
 */
export async function postReviewCleanup(ctx: ToolContext): Promise<void> {
  const review = ctx.toolState.review;
  if (!review) {
    // a re-review that submitted nothing has no node id to mark it "done", so the push
    // dedup dropped every commit pushed after its checkout: flag it, then re-review them.
    const checkoutSha = primaryRepoState(ctx.toolState).checkoutSha;
    if (ctx.toolState.selectedMode === "IncrementalReview" && checkoutSha) {
      await patchWorkflowRunFields(ctx, { reviewSkipped: true, reviewedCommitSha: checkoutSha });
      await bestEffort(
        () => dispatchFollowUpReReview(ctx, checkoutSha),
        "follow-up re-review dispatch"
      );
    }
    // a run that pushed commits without reviewing them (an autofix) leaves the new head with no
    // review, and nothing else re-reviews a bot push. see `dispatchReReviewAfterPush`.
    if (ctx.toolState.pushedHeadSha && checkoutSha) {
      await bestEffort(
        () => dispatchReReviewAfterPush(ctx, checkoutSha),
        "post-push re-review dispatch"
      );
    }
    return;
  }
  delete ctx.toolState.review;

  // mark review as submitted — unlocks webhook dedup for new pushes
  await bestEffort(() => reportReviewNodeId(ctx, review), "reportReviewNodeId");

  // dispatch follow-up if PR HEAD moved past the reviewed commit
  if (review.reviewedSha) {
    await bestEffort(
      () => dispatchFollowUpReReview(ctx, review.reviewedSha!),
      "follow-up re-review dispatch"
    );
  }
}

/**
 * consecutive trailing Pullfrog commits at which an autofix stops being re-reviewed. each
 * autofix push dispatches a re-review, and a re-review that rejects again triggers the next
 * autofix: without a bound that is a review/fix loop that burns runs until someone notices.
 */
export const MAX_AUTOFIX_CHAIN = 3;

/**
 * re-review the head an autofix run pushed. only when the repo gates on `pullfrog-approval`
 * (otherwise nobody is waiting on a verdict) and the run was not itself a re-review, which
 * `postReviewCleanup` already covers. `startSha` is the head the run checked out.
 */
export async function dispatchReReviewAfterPush(ctx: ToolContext, startSha: string): Promise<void> {
  const event = ctx.payload.event;
  if (!ctx.payload.approvalCheck || event.is_pr !== true) return;
  if (ctx.toolState.selectedMode === "IncrementalReview") return;
  const pushedSha = ctx.toolState.pushedHeadSha;
  if (!pushedSha || pushedSha === startSha) return;

  const commits = await ctx.octokit.rest.repos.listCommits({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    sha: pushedSha,
    per_page: MAX_AUTOFIX_CHAIN,
  });
  const chain = commits.data.length;
  if (chain >= MAX_AUTOFIX_CHAIN && commits.data.every((c) => isPullfrog(c.author?.login))) {
    log.warning(
      `autofix chain: the last ${MAX_AUTOFIX_CHAIN} commits are all Pullfrog's — not re-reviewing, to avoid a review/fix loop`
    );
    return;
  }
  await dispatchFollowUpReReview(ctx, startSha);
}

async function bestEffort(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.debug(`${label} failed: ${error}`);
  }
}

async function dispatchFollowUpReReview(ctx: ToolContext, reviewedSha: string): Promise<void> {
  const issueNumber = ctx.payload.event.issue_number;
  if (!issueNumber) return;
  // a run that ended where it was dispatched from would dispatch a copy of itself, forever:
  // a stale pull ref (#1527), a failed checkout (#1523). read the payload, which review.ts never rewrites.
  const dispatched = ctx.payload.event;
  if (dispatched.trigger === "pull_request_synchronize" && dispatched.before_sha === reviewedSha) {
    log.warning(
      `safety net: run made no progress past before_sha ${reviewedSha.slice(0, 7)} — not re-dispatching`
    );
    return;
  }

  const pr = await ctx.octokit.rest.pulls.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: issueNumber,
  });

  if (pr.data.head.sha === reviewedSha) return;
  if (pr.data.state !== "open") return;
  if (pr.data.draft && !ctx.reviewDrafts) return;

  log.info(
    `safety net: pr HEAD moved from ${reviewedSha.slice(0, 7)} to ${pr.data.head.sha.slice(0, 7)} ` +
      `and agent did not review inline — dispatching follow-up re-review`
  );

  const event: WriteablePayload["event"] = {
    trigger: "pull_request_synchronize",
    issue_number: issueNumber,
    is_pr: true,
    title: pr.data.title,
    body: null,
    branch: pr.data.head.ref,
    before_sha: reviewedSha,
    silent: true,
  };
  if (ctx.payload.event.authorPermission) {
    event.authorPermission = ctx.payload.event.authorPermission;
  }

  const payload: WriteablePayload = {
    "~pullfrog": true,
    version: ctx.payload.version,
    model: ctx.payload.model,
    effort: ctx.payload.effort,
    prompt: "",
    eventInstructions: RE_REVIEW_PREAMBLE,
    event,
  };

  // GitHub intermittently 500s on workflow_dispatch; retry the transient blip
  // so this best-effort safety-net re-review isn't silently dropped (the caller
  // swallows failures via bestEffort → log.debug). 4xx fails fast. same
  // dispatch-hardening theme as the server's dispatchWithRetry (#838/#958).
  // unlike dispatchReservedRun this dispatch carries no reservation suffix, so
  // the downstream duplicate-cancel can't dedup a retry that fires after GitHub
  // queued the first run — accepted tradeoff: both re-reviews are unbilled, and
  // a rare cosmetic duplicate beats dropping the safety-net re-review.
  await yes.mutation({
    run: () =>
      ctx.octokit.rest.actions.createWorkflowDispatch({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        workflow_id: getCurrentWorkflowFilename(),
        ref: pr.data.base.repo.default_branch,
        inputs: { prompt: JSON.stringify(payload) },
      }),
    name: "reReviewDispatch",
    retry: retryTransientOctokit,
  })();
}

/**
 * derive the running workflow's filename from `GITHUB_WORKFLOW_REF`, which has the form
 * `<owner>/<repo>/.github/workflows/<filename>@<ref>` (e.g. `.../pullfrog.yaml@refs/heads/main`).
 * falls back to `pullfrog.yml` if the env var is missing or malformed (shouldn't happen in CI).
 */
function getCurrentWorkflowFilename(): string {
  const ref = process.env.GITHUB_WORKFLOW_REF ?? "";
  const match = ref.match(/\/([^/]+)@/);
  return match?.[1] ?? "pullfrog.yml";
}
