export type NodeStatus = "draft" | "synced" | "drifted" | "pinned";
export type EdgeType = "feeds_data_to" | "triggers" | "constrains";

export interface IntentNode {
  id: string;
  vibe: string;
  contracts: string[];
  artifacts: string[]; // Supports "path/to/file.tsx" or "path/to/file.tsx#SymbolName"
  status: NodeStatus;
  intentVector?: number[];
  lastRecordedSimilarity?: number;
}

export interface IntentEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface IntentGraph {
  invariants: string[];
  nodes: Record<string, IntentNode>;
  edges: IntentEdge[];
}

export interface SurfaceSignature {
  exportedSymbols: Record<string, string>; // symbolName -> normalized parameter/return type hash
  sharedKeys: Set<string>; // localStorage keys, DB tables, custom events, URL params
  styleHooks: Set<string>; // CSS custom properties (--var), root theme classes
  imports: Record<string, string[]>; // modulePath -> imported identifiers
}

export interface SymbolSlice {
  symbolId: string; // e.g., "src/Dashboard.tsx#BillingPortal"
  name: string;
  startIndex: number;
  endIndex: number;
  astNormalizedHash: string; // Position-independent S-expression hash
  surface: SurfaceSignature;
  skeletonText: string;
}

export interface FileSnapshot {
  path: string;
  content: string;
  fullAstHash: string;
  fileSurface: SurfaceSignature;
  slices: Map<string, SymbolSlice>;
}
