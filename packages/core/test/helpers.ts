import _Parser from "web-tree-sitter";
import path from "path";
import { AstSieveEngine } from "../src/ast-sieve";

const Parser: any = (_Parser as any).default || _Parser;

export async function makeSieve(): Promise<AstSieveEngine> {
  await Parser.init();
  const parser = new Parser();
  const wasm = path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out", "tree-sitter-tsx.wasm");
  parser.setLanguage(await Parser.Language.load(wasm));
  return new AstSieveEngine(parser);
}

/** Deterministic bag-of-words hash embedding (256-dim) for offline tests. */
export async function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array(256).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 256] += 1;
  }
  return v;
}
