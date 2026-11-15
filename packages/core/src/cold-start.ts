import { IntentGraph } from "./types";
import { AstSieveEngine } from "./ast-sieve";

export interface CoupledUnit {
  artifactId: string;
  imports: string[];
  sharedKeys: string[];
  skeleton: string;
  isHighRiskSacred: boolean;
}

export const COLD_START_SYSTEM_PROMPT = `You are the ZeroTouchIntentGraph Cold-Start Reverse-Engineer.
Given pre-extracted Contract Skeletons of a codebase, synthesize a complete ZeroTouchIntentGraph.`;

export class ColdStartBootstrapper {
  constructor(
    private sieve: AstSieveEngine,
    private embedFn: (text: string) => Promise<number[]>
  ) {}

  public async bootstrapRepository(
    files: { path: string; content: string }[],
    llmStructuredCall: (system: string, user: string) => Promise<IntentGraph>
  ): Promise<IntentGraph> {
    const units: CoupledUnit[] = [];
    const importFanIn = new Map<string, number>();

    for (const file of files) {
      const tree = this.sieve.parse(file.content);
      const lineCount = file.content.split("\n").length;
      const slices = this.sieve.sliceFile(file.path, tree, file.content);
      const sacred = this.detectSacredCode(file.content);

      // Fan-in is counted for every file's imports, regardless of slicing.
      const fileSurface = this.sieve.extractSurfaceSignature(tree.rootNode, file.content);
      for (const mod of Object.keys(fileSurface.imports)) {
        importFanIn.set(mod, (importFanIn.get(mod) || 0) + 1);
      }

      if (lineCount > 300 && slices.size > 1) {
        for (const [symbolId, slice] of slices) {
          units.push({
            artifactId: symbolId,
            imports: Object.keys(slice.surface.imports),
            sharedKeys: Array.from(slice.surface.sharedKeys),
            skeleton: slice.skeletonText,
            isHighRiskSacred: sacred,
          });
        }
      } else {
        units.push({
          artifactId: file.path,
          imports: Object.keys(fileSurface.imports),
          sharedKeys: Array.from(fileSurface.sharedKeys),
          skeleton: this.sieve.extractContractSkeleton(tree.rootNode, file.content),
          isHighRiskSacred: sacred,
        });
      }
    }

    const clusters = this.clusterByCoupling(units, importFanIn, files.length);
    const graph = await llmStructuredCall(COLD_START_SYSTEM_PROMPT, JSON.stringify(clusters));

    const unitMap = new Map(units.map((u) => [u.artifactId, u]));
    for (const [id, node] of Object.entries(graph.nodes)) {
      node.id = node.id ?? id;
      const touchesSacred = node.artifacts.some((a) => unitMap.get(a)?.isHighRiskSacred);
      node.status = touchesSacred ? "pinned" : "synced";
      node.intentVector = await this.embedFn(`${node.vibe} | ${node.contracts.join(" ; ")}`);
    }

    return graph;
  }

  public detectSacredCode(content: string): boolean {
    return /stripe\.webhooks|crypto\.subtle|WebGLRenderingContext|supabase\.auth\.admin/.test(content);
  }

  /**
   * Foundation = widely imported or theme/config/type files. Fan-in is keyed by module
   * specifier, so a unit matches when any import specifier resolves to its file stem.
   */
  public clusterByCoupling(units: CoupledUnit[], fanIn: Map<string, number>, totalFiles: number) {
    const stemOf = (artifactId: string) =>
      artifactId.split("#")[0].split("/").pop()!.replace(/\.[^.]+$/, "");
    const unitFanIn = (u: CoupledUnit) => {
      const stem = stemOf(u.artifactId);
      let n = 0;
      for (const [mod, count] of fanIn) {
        if (mod.split("/").pop()!.replace(/\.[^.]+$/, "") === stem) n += count;
      }
      return n;
    };
    const foundation = units.filter(
      (u) => unitFanIn(u) / Math.max(totalFiles, 1) >= 0.35 || /theme|config|types/.test(u.artifactId)
    );
    const features = units.filter((u) => !foundation.includes(u));
    return { foundation, features };
  }
}
