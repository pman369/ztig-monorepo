import { IntentEdge, IntentNode, SurfaceSignature } from "./types";

export interface SurfaceDelta {
  isPureInternalRefactor: boolean;
  droppedExports: string[];
  mutatedExportSignatures: string[];
  droppedSharedKeys: string[];
  droppedStyleHooks: string[];
}

export class DriftDetector {
  private readonly SEMANTIC_VELOCITY_THRESHOLD = -0.06;

  public diffSurfaceSignatures(prev: SurfaceSignature, next: SurfaceSignature): SurfaceDelta {
    const droppedExports: string[] = [];
    const mutatedExportSignatures: string[] = [];

    for (const [sym, hash] of Object.entries(prev.exportedSymbols)) {
      if (!(sym in next.exportedSymbols)) {
        droppedExports.push(sym);
      } else if (next.exportedSymbols[sym] !== hash) {
        mutatedExportSignatures.push(sym);
      }
    }

    const droppedSharedKeys = Array.from(prev.sharedKeys).filter((k) => !next.sharedKeys.has(k));
    const droppedStyleHooks = Array.from(prev.styleHooks).filter((s) => !next.styleHooks.has(s));

    const isPureInternalRefactor =
      droppedExports.length === 0 &&
      mutatedExportSignatures.length === 0 &&
      droppedSharedKeys.length === 0 &&
      droppedStyleHooks.length === 0 &&
      Object.keys(prev.exportedSymbols).length === Object.keys(next.exportedSymbols).length;

    return {
      isPureInternalRefactor,
      droppedExports,
      mutatedExportSignatures,
      droppedSharedKeys,
      droppedStyleHooks,
    };
  }

  public doesDeltaBreakEdge(
    edge: IntentEdge,
    delta: SurfaceDelta,
    downstreamSurface: SurfaceSignature
  ): { broken: boolean; reason?: string } {
    const allImportedSymbols = new Set(Object.values(downstreamSurface.imports).flat());

    const brokenImports = [...delta.droppedExports, ...delta.mutatedExportSignatures].filter((sym) =>
      allImportedSymbols.has(sym)
    );

    if (brokenImports.length > 0) {
      return {
        broken: true,
        reason: `Upstream export signature changed or deleted for [${brokenImports.join(", ")}]`,
      };
    }

    if (edge.type === "feeds_data_to" && delta.droppedSharedKeys.length > 0) {
      return {
        broken: true,
        reason: `Upstream dropped shared storage/DB key(s): [${delta.droppedSharedKeys.join(", ")}]`,
      };
    }

    if (edge.type === "constrains" && delta.droppedStyleHooks.length > 0) {
      return {
        broken: true,
        reason: `Upstream constraint dropped CSS hook(s): [${delta.droppedStyleHooks.join(", ")}]`,
      };
    }

    return { broken: false };
  }

  /** Tier-2 check: semantic velocity = currentSim - baselineSim; drift when below threshold. */
  public async evaluateSemanticVelocity(
    node: IntentNode,
    newSkeletonText: string,
    embedFn: (text: string) => Promise<number[]>
  ): Promise<{ drifted: boolean; newSimilarity: number; velocity: number }> {
    if (!node.intentVector) {
      node.intentVector = await embedFn(`${node.vibe} | ${node.contracts.join(" ; ")}`);
    }

    const skeletonVec = await embedFn(newSkeletonText);
    const currentSim = this.cosineSimilarity(node.intentVector, skeletonVec);
    const baselineSim = node.lastRecordedSimilarity ?? currentSim;
    const velocity = currentSim - baselineSim;

    return { drifted: velocity < this.SEMANTIC_VELOCITY_THRESHOLD, newSimilarity: currentSim, velocity };
  }

  public cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
  }
}
