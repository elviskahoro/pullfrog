import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../mcp/server.ts";
import { postReviewCleanup } from "./reviewCleanup.ts";

const START = "a".repeat(40);
const PUSHED = "b".repeat(40);

function makeCtx(opts: {
  pushedHeadSha?: string | undefined;
  approvalCheck?: boolean;
  mode?: string;
  headSha?: string;
}) {
  const dispatch = vi.fn(async (_p: any) => ({}));
  const ctx = {
    octokit: {
      rest: {
        pulls: {
          get: vi.fn(async () => ({
            data: {
              head: { sha: opts.headSha ?? PUSHED, ref: "feat" },
              state: "open",
              draft: false,
              title: "t",
              base: { repo: { default_branch: "main" } },
            },
          })),
        },
        actions: { createWorkflowDispatch: dispatch },
      },
    },
    repo: { owner: "o", name: "r" },
    reviewDrafts: false,
    payload: {
      version: "0.0.0",
      approvalCheck: opts.approvalCheck ?? true,
      event: { trigger: "check_suite_completed", is_pr: true, issue_number: 7 },
    },
    toolState: {
      review: undefined,
      selectedMode: opts.mode ?? "Fix",
      pushedHeadSha: opts.pushedHeadSha,
      primaryRepoKey: "o/r",
      repos: new Map([["o/r", { checkoutSha: START }]]),
    },
  } as unknown as ToolContext;
  return { ctx, dispatch };
}

describe("postReviewCleanup: re-review after an autofix push", () => {
  it("dispatches an IncrementalReview from the pre-push head", async () => {
    const { ctx, dispatch } = makeCtx({ pushedHeadSha: PUSHED });
    await postReviewCleanup(ctx);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(dispatch.mock.calls[0]![0].inputs.prompt);
    expect(payload.event).toMatchObject({
      trigger: "pull_request_synchronize",
      issue_number: 7,
      before_sha: START,
    });
    expect(payload.eventInstructions).toContain("IncrementalReview");
  });

  it("does nothing when the run pushed nothing", async () => {
    const { ctx, dispatch } = makeCtx({});
    await postReviewCleanup(ctx);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does nothing when the repo does not gate on pullfrog-approval", async () => {
    const { ctx, dispatch } = makeCtx({ pushedHeadSha: PUSHED, approvalCheck: false });
    await postReviewCleanup(ctx);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
