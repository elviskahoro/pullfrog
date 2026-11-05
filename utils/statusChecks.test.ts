import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../mcp/server.ts";
import { reportStatusChecks } from "./statusChecks.ts";

const FROM = "a".repeat(40);
const PUSHED = "b".repeat(40);

type Verdicts = Record<string, "success" | "failure">;

// minimal fake: only the surface reportStatusChecks touches.
function makeCtx(opts: {
  verdicts: Verdicts;
  mode?: string;
  pushedHeadSha?: string;
  approval?: { wouldApprove: boolean; sha: string | undefined };
}) {
  const created: { name: string; head_sha: string; conclusion?: string; output?: any }[] = [];
  const octokit = {
    graphql: vi.fn(async () => ({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } },
    })),
    rest: {
      pulls: { get: vi.fn(async () => ({ data: { head: { sha: PUSHED } } })) },
      checks: {
        update: vi.fn(async () => ({ data: { id: 1 } })),
        create: vi.fn(async (p: any) => {
          created.push(p);
          return { data: { id: 2 } };
        }),
        listForRef: vi.fn(async (p: any) => ({
          data: {
            check_runs: p.ref in opts.verdicts
              ? [
                  {
                    id: 9,
                    app: { slug: "pullfrog" },
                    completed_at: "2026-01-01T00:00:00Z",
                    conclusion: opts.verdicts[p.ref],
                  },
                ]
              : [],
          },
        })),
      },
    },
  };
  const ctx = {
    octokit,
    repo: { owner: "o", name: "r" },
    runId: undefined,
    payload: {
      event: { is_pr: true, issue_number: 7, silent: false },
      approvalCheck: true,
      runStatusCheck: false,
      checkRun: undefined,
    },
    toolState: {
      approval: opts.approval,
      selectedMode: opts.mode ?? "Fix",
      pushedHeadSha: opts.pushedHeadSha,
      primaryRepoKey: "o/r",
      repos: new Map([["o/r", { checkoutSha: FROM, beforeSha: undefined }]]),
    },
  } as unknown as ToolContext;
  return { ctx, created };
}

describe("reportStatusChecks: verdict after a run that pushed", () => {
  it("carries a prior rejection onto the pushed head", async () => {
    const { ctx, created } = makeCtx({ verdicts: { [FROM]: "failure" }, pushedHeadSha: PUSHED });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: "pullfrog-approval",
      head_sha: PUSHED,
      conclusion: "failure",
    });
    expect(created[0]?.output.summary).toContain("no review covered");
  });

  it("never carries a prior approval onto unreviewed pushed code", async () => {
    const { ctx, created } = makeCtx({ verdicts: { [FROM]: "success" }, pushedHeadSha: PUSHED });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(0);
  });

  it("posts nothing when there was no prior verdict", async () => {
    const { ctx, created } = makeCtx({ verdicts: {}, pushedHeadSha: PUSHED });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(0);
  });

  it("does not shadow a verdict already posted on the pushed head", async () => {
    const { ctx, created } = makeCtx({
      verdicts: { [FROM]: "failure", [PUSHED]: "success" },
      pushedHeadSha: PUSHED,
    });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(0);
  });

  it("posts nothing when the run did not push and recorded no verdict", async () => {
    const { ctx, created } = makeCtx({ verdicts: { [FROM]: "failure" } });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(0);
  });

  it("leaves an explicit review verdict alone", async () => {
    const { ctx, created } = makeCtx({
      verdicts: { [FROM]: "failure" },
      pushedHeadSha: PUSHED,
      approval: { wouldApprove: true, sha: PUSHED },
    });
    await reportStatusChecks(ctx, { runSucceeded: true });
    expect(created).toHaveLength(1);
    expect(created[0]?.conclusion).toBe("success");
  });
});
