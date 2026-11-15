import fs from "fs";
import path from "path";
import { AstSieveEngine, DriftDetector, IntentGraph, ZtigOrchestrator } from "@ztig/core";
import { ChangedFileDiff } from "./git-differ";

export interface EvaluationOptions {
  graphPath?: string;
  failOnDrift?: boolean;
  baseRef?: string;
  headRef?: string;
}

export interface EvaluationReport {
  success: boolean;
  pinViolations: string[];
  driftedNodes: string[];
  alerts: string[];
  filesEvaluated: number;
}

export async function evaluateDiffs(
  diffs: ChangedFileDiff[],
  graph: IntentGraph,
  sieve: AstSieveEngine,
  embedFn: (text: string) => Promise<number[]> = async () => new Array(256).fill(0.1)
): Promise<EvaluationReport> {
  const detector = new DriftDetector();
  const orchestrator = new ZtigOrchestrator(graph, sieve, detector, embedFn);

  // 1. Seed baseline files
  for (const diff of diffs) {
    if (diff.baseContent) {
      orchestrator.seedFile(diff.path, diff.baseContent);
    }
  }

  orchestrator.beginTurn();

  const pinViolations: string[] = [];
  const alerts: string[] = [];

  // 2. Intercept proposed writes
  for (const diff of diffs) {
    if (!diff.headContent) continue;
    const result = await orchestrator.interceptWriteFile(diff.path, diff.headContent);
    if (result.startsWith("ERROR")) {
      pinViolations.push(`[${diff.path}] ${result}`);
    } else if (result.includes("DRIFT") || result.includes("drift alerts")) {
      alerts.push(`[${diff.path}] ${result}`);
    }
  }

  const driftedNodes = orchestrator.getRepairQueue();
  const success = pinViolations.length === 0 && driftedNodes.length === 0;

  return {
    success,
    pinViolations,
    driftedNodes,
    alerts,
    filesEvaluated: diffs.length,
  };
}

export function loadGraph(graphPath?: string, cwd: string = process.cwd()): IntentGraph {
  const target = graphPath ? path.resolve(cwd, graphPath) : path.join(cwd, "ztig.json");
  if (fs.existsSync(target)) {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  }
  // Default empty graph if not specified
  return {
    invariants: [],
    nodes: {},
    edges: [],
  };
}
