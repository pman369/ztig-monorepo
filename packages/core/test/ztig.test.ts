import { beforeAll, describe, expect, it } from "vitest";
import { AstSieveEngine } from "../src/ast-sieve";
import { DriftDetector } from "../src/drift-detector";
import { ZtigOrchestrator } from "../src/orchestrator";
import { ColdStartBootstrapper } from "../src/cold-start";
import { applyJsonMergePatch } from "../src/merge-patch";
import { IntentGraph } from "../src/types";
import { fakeEmbed, makeSieve } from "./helpers";

let sieve: AstSieveEngine;
beforeAll(async () => {
  sieve = await makeSieve();
});

const node = (id: string, artifacts: string[], status: any = "synced") => ({
  id,
  vibe: `${id} vibe`,
  contracts: [],
  artifacts,
  status,
});

describe("merge patch (RFC 7396)", () => {
  it("adds, replaces, and deletes with null; arrays replaced wholesale", () => {
    const out = applyJsonMergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { b: { c: null, x: 9 }, e: [3], a: 2 });
    expect(out).toEqual({ a: 2, b: { d: 3, x: 9 }, e: [3] });
  });
});

describe("AstSieveEngine", () => {
  const src = `import { useState } from "react";
import { fmt } from "./util";
export function Header(props: {a: string}): JSX.Element { const [x] = useState(0); localStorage.getItem("user_token"); return <div style={{color: "--brand"}}>hi</div>; }
export const Footer = () => <span/>;
`;
  it("extracts surface signature", () => {
    const tree = sieve.parse(src);
    const s = sieve.extractSurfaceSignature(tree.rootNode, src);
    expect(Object.keys(s.exportedSymbols).sort()).toEqual(["Footer", "Header"]);
    expect(s.imports["./util"]).toContain("fmt");
    expect(s.sharedKeys.has("user_token")).toBe(true);
    expect(s.styleHooks.has("--brand")).toBe(true);
  });

  it("slices and hashes position-independently", () => {
    const a = sieve.sliceFile("f.tsx", sieve.parse(src), src);
    const shifted = "// comment\n\n" + src;
    const b = sieve.sliceFile("f.tsx", sieve.parse(shifted), shifted);
    expect([...a.keys()].sort()).toEqual(["f.tsx#Footer", "f.tsx#Header"]);
    expect(a.get("f.tsx#Header")!.astNormalizedHash).toBe(b.get("f.tsx#Header")!.astNormalizedHash);
    expect(a.get("f.tsx#Header")!.skeletonText).toContain("useState");
  });

  it("hash changes on real edits", () => {
    const a = sieve.sliceFile("f.tsx", sieve.parse(src), src).get("f.tsx#Footer")!;
    const e = src.replace("<span/>", "<b/>");
    const b = sieve.sliceFile("f.tsx", sieve.parse(e), e).get("f.tsx#Footer")!;
    expect(a.astNormalizedHash).not.toBe(b.astNormalizedHash);
  });
});

describe("DriftDetector", () => {
  const d = new DriftDetector();
  it("cosine similarity", () => {
    expect(d.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(d.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("semantic velocity flags big drops only", async () => {
    const n: any = { id: "n", vibe: "login button", contracts: ["auth"], artifacts: [], status: "synced" };
    const first = await d.evaluateSemanticVelocity(n, "login button auth", fakeEmbed);
    n.lastRecordedSimilarity = first.newSimilarity;
    const bad = await d.evaluateSemanticVelocity(n, "zebra giraffe", fakeEmbed);
    expect(bad.drifted).toBe(true);
    const ok = await d.evaluateSemanticVelocity(n, "login button auth", fakeEmbed);
    expect(ok.drifted).toBe(false);
  });
});

function makeOrch(graph: IntentGraph) {
  return new ZtigOrchestrator(graph, sieve, new DriftDetector(), fakeEmbed);
}

const upstream = `export function getUser(id: string): string { return localStorage.getItem("user_token") ?? id; }`;
const downstream = `import { getUser } from "./up";\nexport const View = () => <div>{getUser("1")}</div>;`;

describe("ZtigOrchestrator", () => {
  const baseGraph = (): IntentGraph => ({
    invariants: [],
    nodes: { up: node("up", ["up.tsx"]), down: node("down", ["down.tsx"]) },
    edges: [{ from: "up", to: "down", type: "feeds_data_to" }],
  });

  it("rejects writes to a pinned whole file", async () => {
    const g = baseGraph();
    g.nodes.up.status = "pinned";
    const o = makeOrch(g);
    o.seedFile("up.tsx", upstream);
    expect(await o.interceptWriteFile("up.tsx", upstream + "\n//x")).toMatch(/PinViolationError/);
  });

  it("allows edits outside a pinned sub-symbol but rejects inside", async () => {
    const file = `export function A() { return 1; }\nexport function B() { return 2; }`;
    const g: IntentGraph = { invariants: [], nodes: { n: node("n", ["f.tsx#A"], "pinned") }, edges: [] };
    const o = makeOrch(g);
    o.seedFile("f.tsx", file);
    expect(await o.interceptWriteFile("f.tsx", file.replace("return 2", "return 3"))).toMatch(/Committed/);
    expect(await o.interceptWriteFile("f.tsx", file.replace("return 1", "return 9"))).toMatch(/PinViolationError/);
  });

  it("flags downstream drift on export signature change", async () => {
    const o = makeOrch(baseGraph());
    o.seedFile("up.tsx", upstream);
    o.seedFile("down.tsx", downstream);
    o.beginTurn();
    const res = await o.interceptWriteFile("up.tsx", upstream.replace("(id: string)", "(id: string, x: number)"));
    expect(res).toMatch(/drift alerts/);
    expect(o.getGraph().nodes.down.status).toBe("drifted");
    expect(o.getRepairQueue()).toEqual(["down"]);
  });

  it("does not mutate state when a transitive pin violation rejects the write", async () => {
    const g = baseGraph();
    g.nodes.down.status = "pinned";
    g.nodes.extra = node("extra", ["ex.tsx"]);
    g.edges.push({ from: "up", to: "extra", type: "feeds_data_to" });
    const o = makeOrch(g);
    o.seedFile("up.tsx", upstream);
    o.seedFile("down.tsx", downstream);
    o.seedFile("ex.tsx", `import { getUser } from "./up";\nexport const E = 1;`);
    const res = await o.interceptWriteFile("up.tsx", "export const nothing = 1;");
    expect(res).toMatch(/TransitivePinViolation/);
    expect(g.nodes.extra.status).toBe("synced");
    expect(o.getSnapshot("up.tsx")!.content).toBe(upstream);
  });

  it("pure internal refactor is silent", async () => {
    const o = makeOrch(baseGraph());
    o.seedFile("up.tsx", upstream);
    o.seedFile("down.tsx", downstream);
    const res = await o.interceptWriteFile("up.tsx", upstream.replace("?? id", "?? String(id)"));
    expect(res).toBe("Committed cleanly.");
  });

  it("stop hijacker runs repair pass then finishes", async () => {
    const o = makeOrch(baseGraph());
    o.seedFile("up.tsx", upstream);
    o.seedFile("down.tsx", downstream);
    o.beginTurn();
    await o.interceptWriteFile("up.tsx", "export const nothing = 1;");
    const d1 = o.onAgentStop();
    expect(d1).toMatchObject({ action: "repair", targetNodeId: "down", pass: 1 });
    await o.interceptWriteFile("down.tsx", `export const View = () => <div/>;`);
    expect(o.onAgentStop()).toEqual({ action: "done" });
    expect(o.getGraph().nodes.down.status).toBe("synced");
  });

  it("repairs in topological order", async () => {
    const g: IntentGraph = {
      invariants: [],
      nodes: { a: node("a", ["a.tsx"]), b: node("b", ["b.tsx"]), c: node("c", ["c.tsx"]) },
      edges: [{ from: "c", to: "b", type: "triggers" }, { from: "b", to: "a", type: "triggers" }],
    };
    const o = makeOrch(g);
    o.beginTurn();
    (o as any).repairQueue = new Set(["a", "b", "c"]);
    expect(o.getRepairQueue()).toEqual(["c", "b", "a"]);
  });

  it("deadlocks after 3 passes, rolls back VFS, and offers A/B", async () => {
    const g: IntentGraph = {
      invariants: [],
      nodes: { a: node("a", ["a.tsx"]), b: node("b", ["b.tsx"]) },
      edges: [{ from: "a", to: "b", type: "feeds_data_to" }, { from: "b", to: "a", type: "feeds_data_to" }],
    };
    const aSrc = `import { fb } from "./b";\nexport function fa(x: number) { return fb(x); }`;
    const bSrc = `import { fa } from "./a";\nexport function fb(x: number) { return fa(x); }`;
    const o = makeOrch(g);
    o.seedFile("a.tsx", aSrc);
    o.seedFile("b.tsx", bSrc);
    o.beginTurn();
    // each write breaks the other side's imports -> endless ping-pong
    await o.interceptWriteFile("a.tsx", aSrc.replace("(x: number)", "(x: string)"));
    let decision = o.onAgentStop();
    let n = 0;
    while (decision.action === "repair" && n++ < 10) {
      const t = decision.targetNodeId;
      const file = t === "a" ? "a.tsx" : "b.tsx";
      const src = t === "a" ? aSrc : bSrc;
      await o.interceptWriteFile(file, src.replace("(x: number)", `(x: ${"s".repeat(n)})`));
      decision = o.onAgentStop();
    }
    expect(decision.action).toBe("deadlock");
    expect(o.getSnapshot("a.tsx")!.content).toBe(aSrc);
    expect(o.getSnapshot("b.tsx")!.content).toBe(bSrc);
    expect(o.getGraph().nodes.a.status).toBe("synced");
    if (decision.action === "deadlock") expect(decision.options.A).toMatch(/Keep/);
  });

  it("applies graph patches and prunes dangling edges", () => {
    const o = makeOrch(baseGraph());
    const g = o.applyGraphPatch({ nodes: { down: null, fresh: node("fresh", ["z.tsx"]) } });
    expect(Object.keys(g.nodes).sort()).toEqual(["fresh", "up"]);
    expect(g.edges).toEqual([]);
  });
});

describe("ColdStartBootstrapper", () => {
  it("pins sacred nodes, embeds intents, counts fan-in", async () => {
    const cs = new ColdStartBootstrapper(sieve, fakeEmbed);
    const files = [
      { path: "pay.ts", content: `export const hook = () => stripe.webhooks.constructEvent();` },
      { path: "ui.tsx", content: `import { x } from "./theme";\nexport const U = () => <div/>;` },
      { path: "theme.ts", content: `export const x = "--brand";` },
    ];
    let seen: any;
    const graph = await cs.bootstrapRepository(files, async (_s, user) => {
      seen = JSON.parse(user);
      return {
        invariants: [],
        nodes: {
          payments: node("payments", ["pay.ts"]),
          screen: node("screen", ["ui.tsx"]),
        },
        edges: [],
      };
    });
    expect(graph.nodes.payments.status).toBe("pinned");
    expect(graph.nodes.screen.status).toBe("synced");
    expect(graph.nodes.screen.intentVector).toHaveLength(256);
    expect(seen.foundation.map((u: any) => u.artifactId)).toContain("theme.ts");
  });
});
