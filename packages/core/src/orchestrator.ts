import { FileSnapshot, IntentGraph, IntentNode, NodeStatus, SurfaceSignature } from "./types";
import { AstSieveEngine } from "./ast-sieve";
import { DriftDetector } from "./drift-detector";
import { applyJsonMergePatch } from "./merge-patch";

export interface OscillationRecord {
  pass: number;
  repairedNodeId: string;
  collateralDriftedNodeId: string;
  reason: string;
}

export type StopDecision =
  | { action: "done" }
  | { action: "repair"; pass: number; targetNodeId: string; prompt: string }
  | { action: "deadlock"; message: string; options: { A: string; B: string }; oscillations: OscillationRecord[] };

export class ZtigOrchestrator {
  private vfs = new Map<string, FileSnapshot>();
  private turnBaselineVfs = new Map<string, FileSnapshot>();
  private turnBaselineStatuses = new Map<string, NodeStatus>();
  private repairQueue = new Set<string>();
  private repairedThisCycle = new Set<string>();
  private oscillationLog: OscillationRecord[] = [];
  private activeRepairTarget: string | null = null;
  private repairPass = 0;
  private readonly MAX_REPAIR_PASSES = 3;

  constructor(
    private graph: IntentGraph,
    private sieve: AstSieveEngine,
    private driftDetector: DriftDetector,
    private embedFn: (text: string) => Promise<number[]>
  ) {}

  // ---- Graph delta pre-processor (RFC 7396) ----

  public applyGraphPatch(patch: any): IntentGraph {
    this.graph = applyJsonMergePatch(this.graph, patch);
    // Re-attach ids (patches key nodes by slug) and drop edges pointing at deleted nodes.
    for (const [id, node] of Object.entries(this.graph.nodes)) node.id = node.id ?? id;
    this.graph.edges = this.graph.edges.filter((e) => this.graph.nodes[e.from] && this.graph.nodes[e.to]);
    for (const id of [...this.repairQueue]) if (!this.graph.nodes[id]) this.repairQueue.delete(id);
    return this.graph;
  }

  public getGraph(): IntentGraph {
    return this.graph;
  }

  public getSnapshot(path: string): FileSnapshot | undefined {
    return this.vfs.get(path);
  }

  public getRepairQueue(): string[] {
    return this.topologicalRepairOrder();
  }

  public getOscillationLog(): OscillationRecord[] {
    return [...this.oscillationLog];
  }

  /** Seed the VFS (e.g. after cold-start or before PR diff check) without running any gates. */
  public seedFile(path: string, content: string): void {
    this.vfs.set(path, this.buildSnapshot(path, content));
  }

  /** Mark the start of a chat turn: capture a clean rollback point. */
  public beginTurn(): void {
    this.turnBaselineVfs = new Map(this.vfs);
    this.turnBaselineStatuses = new Map(Object.entries(this.graph.nodes).map(([id, n]) => [id, n.status]));
    this.repairQueue.clear();
    this.repairedThisCycle.clear();
    this.oscillationLog = [];
    this.activeRepairTarget = null;
    this.repairPass = 0;
  }

  // ---- Transactional interceptor (Gates A-D) ----

  public async interceptWriteFile(path: string, newContent: string): Promise<string> {
    const prevSnap = this.vfs.get(path);
    const nextSnap = this.buildSnapshot(path, newContent);
    const owningNodes = this.getNodesOwningFileOrSymbol(path);

    // Gate A: direct & sub-file pin check.
    for (const { node, symbolName } of owningNodes) {
      if (node.status !== "pinned") continue;
      if (!symbolName) {
        if (!prevSnap || prevSnap.fullAstHash !== nextSnap.fullAstHash) {
          return `ERROR [PinViolationError]: Whole file '${path}' is locked by pinned node [${node.id}].`;
        }
      } else {
        const symbolId = `${path}#${symbolName}`;
        const prevSlice = prevSnap?.slices.get(symbolId);
        const nextSlice = nextSnap.slices.get(symbolId);
        if (prevSlice && (!nextSlice || prevSlice.astNormalizedHash !== nextSlice.astNormalizedHash)) {
          return `ERROR [PinViolationError]: Sub-component '${symbolName}' locked by [${node.id}].`;
        }
        // If not yet in VFS but node is declared pinned for this symbol and slice exists:
        if (!prevSlice && nextSlice && !prevSnap) {
          return `ERROR [PinViolationError]: Sub-component '${symbolName}' locked by [${node.id}].`;
        }
      }
    }

    // Gates B + C: evaluate against a hypothetical post-write VFS, without mutating state.
    const pending: { node: IntentNode; reason: string }[] = [];
    const tier2Candidates: { node: IntentNode; skeleton: string }[] = [];
    const withWrite = new Map(this.vfs).set(path, nextSnap);

    for (const { node, symbolName } of owningNodes) {
      const prevSurface = symbolName
        ? prevSnap?.slices.get(`${path}#${symbolName}`)?.surface
        : prevSnap?.fileSurface;
      const currSurface = symbolName ? nextSnap.slices.get(`${path}#${symbolName}`)?.surface : nextSnap.fileSurface;
      if (!prevSurface || !currSurface) continue;

      const delta = this.driftDetector.diffSurfaceSignatures(prevSurface, currSurface);

      if (delta.isPureInternalRefactor) {
        // Gate D candidate: only when the artifact's AST actually changed.
        const changed = symbolName
          ? prevSnap?.slices.get(`${path}#${symbolName}`)?.astNormalizedHash !==
            nextSnap.slices.get(`${path}#${symbolName}`)?.astNormalizedHash
          : prevSnap?.fullAstHash !== nextSnap.fullAstHash;
        if (changed && node.status !== "pinned") {
          const skeleton = symbolName
            ? nextSnap.slices.get(`${path}#${symbolName}`)!.skeletonText
            : this.skeletonOf(newContent);
          tier2Candidates.push({ node, skeleton });
        }
        continue;
      }

      for (const edge of this.graph.edges.filter((e) => e.from === node.id)) {
        const downstreamNode = this.graph.nodes[edge.to];
        if (!downstreamNode || downstreamNode.id === node.id) continue;
        const edgeCheck = this.driftDetector.doesDeltaBreakEdge(
          edge,
          delta,
          this.getAggregatedNodeSurface(downstreamNode, withWrite)
        );
        if (!edgeCheck.broken) continue;
        if (downstreamNode.status === "pinned") {
          return `ERROR [TransitivePinViolation]: Breaks edge to PINNED node [${downstreamNode.id}]. ${edgeCheck.reason}`;
        }
        pending.push({ node: downstreamNode, reason: edgeCheck.reason! });
      }
    }

    // Gate D: Tier-2 semantic skeleton velocity (async, only for ambiguous internal changes).
    const semanticUpdates: { node: IntentNode; sim: number }[] = [];
    for (const { node, skeleton } of tier2Candidates) {
      const res = await this.driftDetector.evaluateSemanticVelocity(node, skeleton, this.embedFn);
      if (res.drifted) {
        pending.push({
          node,
          reason: `Semantic drift (velocity ${res.velocity.toFixed(3)}) in [${node.id}]`,
        });
      } else {
        semanticUpdates.push({ node, sim: res.newSimilarity });
      }
    }

    // Commit.
    const driftAlerts: string[] = [];
    for (const { node, reason } of pending) {
      node.status = "drifted";
      this.repairQueue.add(node.id);
      driftAlerts.push(`DRIFT in [${node.id}]: ${reason}`);
      if (this.repairedThisCycle.has(node.id) && this.activeRepairTarget && this.activeRepairTarget !== node.id) {
        this.oscillationLog.push({
          pass: this.repairPass,
          repairedNodeId: this.activeRepairTarget,
          collateralDriftedNodeId: node.id,
          reason,
        });
      }
    }
    for (const { node, sim } of semanticUpdates) {
      if (node.lastRecordedSimilarity === undefined) node.lastRecordedSimilarity = sim;
      else node.lastRecordedSimilarity = Math.max(node.lastRecordedSimilarity, sim);
    }
    this.vfs.set(path, nextSnap);

    return driftAlerts.length > 0
      ? `Committed with drift alerts.\n${driftAlerts.join("\n")}`
      : `Committed cleanly.`;
  }

  // ---- Stop-signal hijacker & scheduler ----

  /** Called when the agent attempts to stop. Decides whether to continue repairing, finish, or deadlock. */
  public onAgentStop(): StopDecision {
    // Mark the node we last asked to repair as synced; re-drift would have re-queued it.
    if (this.activeRepairTarget) {
      const n = this.graph.nodes[this.activeRepairTarget];
      if (n && !this.repairQueue.has(n.id) && n.status === "drifted") n.status = "synced";
    }

    if (this.repairQueue.size === 0) {
      this.activeRepairTarget = null;
      return { action: "done" };
    }

    if (this.repairPass >= this.MAX_REPAIR_PASSES) {
      return this.resolveDeadlock();
    }

    const order = this.topologicalRepairOrder();
    const target = order[0];
    this.repairQueue.delete(target);
    this.repairedThisCycle.add(target);
    this.activeRepairTarget = target;
    this.repairPass++;

    const node = this.graph.nodes[target];
    const prompt =
      `Silent repair pass ${this.repairPass}/${this.MAX_REPAIR_PASSES}: node [${target}] drifted. ` +
      `Restore its intent: "${node.vibe}". Contracts: ${node.contracts.join("; ") || "none"}. ` +
      `Artifacts: ${node.artifacts.join(", ")}.`;
    return { action: "repair", pass: this.repairPass, targetNodeId: target, prompt };
  }

  private resolveDeadlock(): StopDecision {
    const oscillations = [...this.oscillationLog];
    // VFS rollback to the clean turn baseline.
    this.vfs = new Map(this.turnBaselineVfs);
    for (const [id, status] of this.turnBaselineStatuses) {
      if (this.graph.nodes[id]) this.graph.nodes[id].status = status;
    }
    const queued = [...this.repairQueue, ...(this.activeRepairTarget ? [this.activeRepairTarget] : [])];
    const involved = Array.from(new Set([...oscillations.flatMap((o) => [o.repairedNodeId, o.collateralDriftedNodeId]), ...queued]));
    const describe = (id: string) => this.graph.nodes[id]?.vibe ?? id;
    const [a, b] = involved;

    this.repairQueue.clear();
    this.repairedThisCycle.clear();
    this.activeRepairTarget = null;
    this.repairPass = 0;
    this.oscillationLog = [];

    return {
      action: "deadlock",
      message:
        "These two goals can't both be satisfied by the same change. Your files were restored to before this request. Which one matters more?",
      options: {
        A: `Keep: ${a ? describe(a) : "the new request"}`,
        B: `Keep: ${b ? describe(b) : "the existing behavior"}`,
      },
      oscillations,
    };
  }

  /** Kahn's algorithm over edges restricted to the queue; cycles fall back to insertion order. */
  private topologicalRepairOrder(): string[] {
    const ids = [...this.repairQueue];
    const inSet = new Set(ids);
    const indeg = new Map(ids.map((id) => [id, 0]));
    const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of this.graph.edges) {
      if (inSet.has(e.from) && inSet.has(e.to) && e.from !== e.to) {
        adj.get(e.from)!.push(e.to);
        indeg.set(e.to, indeg.get(e.to)! + 1);
      }
    }
    const ready = ids.filter((id) => indeg.get(id) === 0);
    const out: string[] = [];
    while (ready.length) {
      const id = ready.shift()!;
      out.push(id);
      for (const nxt of adj.get(id)!) {
        indeg.set(nxt, indeg.get(nxt)! - 1);
        if (indeg.get(nxt) === 0) ready.push(nxt);
      }
    }
    for (const id of ids) if (!out.includes(id)) out.push(id);
    return out;
  }

  // ---- helpers ----

  private buildSnapshot(path: string, content: string): FileSnapshot {
    const tree = this.sieve.parse(content);
    return {
      path,
      content,
      fullAstHash: this.sieve.hashNormalizedSubtree(tree.rootNode, content),
      fileSurface: this.sieve.extractSurfaceSignature(tree.rootNode, content),
      slices: this.sieve.sliceFile(path, tree, content),
    };
  }

  private skeletonOf(content: string): string {
    return this.sieve.extractContractSkeleton(this.sieve.parse(content).rootNode, content);
  }

  private getNodesOwningFileOrSymbol(path: string): { node: IntentNode; symbolName?: string }[] {
    const matches: { node: IntentNode; symbolName?: string }[] = [];
    for (const node of Object.values(this.graph.nodes)) {
      for (const art of node.artifacts) {
        if (art === path) matches.push({ node });
        else if (art.startsWith(`${path}#`)) matches.push({ node, symbolName: art.split("#")[1] });
      }
    }
    return matches;
  }

  private getAggregatedNodeSurface(node: IntentNode, vfs: Map<string, FileSnapshot> = this.vfs): SurfaceSignature {
    const combined: SurfaceSignature = { exportedSymbols: {}, sharedKeys: new Set(), styleHooks: new Set(), imports: {} };
    for (const art of node.artifacts) {
      const [filePath, sym] = art.split("#");
      const snap = vfs.get(filePath);
      if (!snap) continue;
      const surf = sym ? snap.slices.get(art)?.surface : snap.fileSurface;
      if (!surf) continue;
      Object.assign(combined.exportedSymbols, surf.exportedSymbols);
      surf.sharedKeys.forEach((k) => combined.sharedKeys.add(k));
      surf.styleHooks.forEach((s) => combined.styleHooks.add(s));
      for (const [mod, ids] of Object.entries(surf.imports)) {
        combined.imports[mod] = Array.from(new Set([...(combined.imports[mod] ?? []), ...ids]));
      }
    }
    return combined;
  }
}
