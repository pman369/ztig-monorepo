import { beforeAll, describe, expect, it } from "vitest";
import { AstSieveEngine, IntentGraph } from "@ztig/core";
import { evaluateDiffs } from "../src/evaluator";
import { ChangedFileDiff } from "../src/git-differ";
import path from "path";

let sieve: AstSieveEngine;

beforeAll(async () => {
  const wasm = path.join(__dirname, "..", "..", "core", "node_modules", "tree-sitter-wasms", "out", "tree-sitter-tsx.wasm");
  sieve = await AstSieveEngine.createDefault(wasm);
});

describe("CLI Evaluator", () => {
  const sampleGraph: IntentGraph = {
    invariants: [],
    nodes: {
      auth: {
        id: "auth",
        vibe: "Authentication flow",
        contracts: [],
        artifacts: ["src/auth.ts"],
        status: "pinned",
      },
      dashboard: {
        id: "dashboard",
        vibe: "Dashboard UI",
        contracts: [],
        artifacts: ["src/dashboard.tsx"],
        status: "synced",
      },
    },
    edges: [
      {
        from: "auth",
        to: "dashboard",
        type: "feeds_data_to",
      },
    ],
  };

  it("blocks changes to pinned files during evaluation", async () => {
    const diffs: ChangedFileDiff[] = [
      {
        path: "src/auth.ts",
        baseContent: "export const token = 'secret';",
        headContent: "export const token = 'modified';",
      },
    ];

    const report = await evaluateDiffs(diffs, sampleGraph, sieve);
    expect(report.success).toBe(false);
    expect(report.pinViolations.length).toBeGreaterThan(0);
    expect(report.pinViolations[0]).toContain("PinViolationError");
  });

  it("flags downstream drift when upstream export is removed", async () => {
    const unpinnedGraph: IntentGraph = {
      ...sampleGraph,
      nodes: {
        ...sampleGraph.nodes,
        auth: {
          ...sampleGraph.nodes.auth,
          status: "synced",
        },
      },
    };

    const diffs: ChangedFileDiff[] = [
      {
        path: "src/auth.ts",
        baseContent: "export function getToken(): string { return '123'; }",
        headContent: "export const nothing = 1;",
      },
      {
        path: "src/dashboard.tsx",
        baseContent: "import { getToken } from './auth'; export const D = () => <div>{getToken()}</div>;",
        headContent: "import { getToken } from './auth'; export const D = () => <div>{getToken()}</div>;",
      },
    ];

    const report = await evaluateDiffs(diffs, unpinnedGraph, sieve);
    expect(report.success).toBe(false);
    expect(report.driftedNodes).toContain("dashboard");
  });

  it("passes cleanly when changes are internal refactors", async () => {
    const unpinnedGraph: IntentGraph = {
      ...sampleGraph,
      nodes: {
        ...sampleGraph.nodes,
        auth: {
          ...sampleGraph.nodes.auth,
          status: "synced",
        },
      },
    };

    const diffs: ChangedFileDiff[] = [
      {
        path: "src/auth.ts",
        baseContent: "export function getToken(): string { const a = 1; return '123'; }",
        headContent: "export function getToken(): string { const b = 2; return '123'; }",
      },
    ];

    const report = await evaluateDiffs(diffs, unpinnedGraph, sieve);
    expect(report.success).toBe(true);
    expect(report.pinViolations.length).toBe(0);
    expect(report.driftedNodes.length).toBe(0);
  });
});
