import _Parser from "web-tree-sitter";
import { createHash } from "crypto";
import path from "path";
import { SurfaceSignature, SymbolSlice } from "./types";

const Parser: any = (_Parser as any).default || _Parser;
type SyntaxNode = _Parser.SyntaxNode;
type Tree = _Parser.Tree;

export class AstSieveEngine {
  private parser: _Parser;

  constructor(parserInstance: _Parser) {
    this.parser = parserInstance;
  }

  public static async createDefault(wasmPath?: string): Promise<AstSieveEngine> {
    await Parser.init();
    const parser = new Parser();
    const targetWasm = wasmPath || require.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm");
    const lang = await Parser.Language.load(targetWasm);
    parser.setLanguage(lang);
    return new AstSieveEngine(parser);
  }

  public parse(source: string): Tree {
    return this.parser.parse(source);
  }

  /** Position-independent hash of a subtree (S-expression of node types + leaf text). */
  public hashNormalizedSubtree(node: SyntaxNode, source: string): string {
    const tokens: string[] = [];
    const walk = (n: SyntaxNode) => {
      if (n.childCount === 0) {
        tokens.push(`${n.type}:${source.slice(n.startIndex, n.endIndex).trim()}`);
      } else {
        tokens.push(`(${n.type}`);
        for (const child of n.namedChildren) walk(child);
        tokens.push(`)`);
      }
    };
    walk(node);
    return createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
  }

  public extractSurfaceSignature(root: SyntaxNode, source: string): SurfaceSignature {
    const exportedSymbols: Record<string, string> = {};
    const sharedKeys = new Set<string>();
    const styleHooks = new Set<string>();
    const imports: Record<string, string[]> = {};
    const text = (n: SyntaxNode) => source.slice(n.startIndex, n.endIndex);

    const visit = (node: SyntaxNode) => {
      if (node.type === "import_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const modName = source.slice(sourceNode.startIndex + 1, sourceNode.endIndex - 1);
          imports[modName] = imports[modName] || [];
          node.descendantsOfType("identifier").forEach((id) => {
            imports[modName].push(text(id));
          });
        }
      }

      if (node.type === "export_statement") {
        const decl = node.childForFieldName("declaration");
        if (decl) {
          const id = decl.childForFieldName("name") || decl.descendantsOfType("identifier")[0];
          if (id) {
            const name = text(id);
            // For `export const X = (...) => ...` the signature lives on the declarator value.
            let sigNode: SyntaxNode = decl;
            if (decl.type === "lexical_declaration") {
              const value = decl.descendantsOfType("variable_declarator")[0]?.childForFieldName("value");
              if (value) sigNode = value;
            }
            const params = sigNode.childForFieldName("parameters");
            const returnType = sigNode.childForFieldName("return_type");
            const sigRaw = [
              params ? text(params) : "()",
              returnType ? text(returnType) : "any",
            ].join("->");
            exportedSymbols[name] = createHash("md5").update(sigRaw).digest("hex").slice(0, 8);
          }
        }
      }

      if (node.type === "string" || node.type === "template_string") {
        const val = source.slice(node.startIndex + 1, node.endIndex - 1);
        if (val.startsWith("--")) {
          styleHooks.add(val);
        } else if (
          node.parent?.type === "arguments" &&
          /localStorage|sessionStorage|from|rpc|getItem|setItem|dispatchEvent|useSearchParams/.test(
            source.slice(node.parent.parent?.startIndex || 0, node.parent.startIndex)
          )
        ) {
          sharedKeys.add(val);
        }
      }

      for (const child of node.namedChildren) visit(child);
    };

    visit(root);
    return { exportedSymbols, sharedKeys, styleHooks, imports };
  }

  public extractContractSkeleton(root: SyntaxNode, source: string): string {
    const surface = this.extractSurfaceSignature(root, source);
    const jsxElements = new Set<string>();
    const stateHooks = new Set<string>();

    root.descendantsOfType(["jsx_opening_element", "jsx_self_closing_element"]).forEach((el) => {
      const nameNode = el.childForFieldName("name");
      if (nameNode) jsxElements.add(source.slice(nameNode.startIndex, nameNode.endIndex));
    });

    root.descendantsOfType("call_expression").forEach((call) => {
      const fn = call.childForFieldName("function");
      if (fn) {
        const fnName = source.slice(fn.startIndex, fn.endIndex);
        if (/^use[A-Z]/.test(fnName) || /fetch|axios|supabase|dispatch/.test(fnName)) {
          stateHooks.add(fnName);
        }
      }
    });

    return [
      `EXPORTS: ${Object.keys(surface.exportedSymbols).join(", ") || "none"}`,
      `HOOKS_AND_CALLS: ${Array.from(stateHooks).join(", ") || "none"}`,
      `STATE_KEYS: ${Array.from(surface.sharedKeys).join(", ") || "none"}`,
      `STYLE_VARS: ${Array.from(surface.styleHooks).join(", ") || "none"}`,
      `UI_ELEMENTS: ${Array.from(jsxElements).join(", ") || "none"}`,
    ].join(" | ");
  }

  public sliceFile(path: string, tree: Tree, source: string): Map<string, SymbolSlice> {
    const slices = new Map<string, SymbolSlice>();
    for (const child of tree.rootNode.namedChildren) {
      const name = this.resolveTopLevelSymbolName(child, source);
      if (!name) continue;

      const symbolId = `${path}#${name}`;
      slices.set(symbolId, {
        symbolId,
        name,
        startIndex: child.startIndex,
        endIndex: child.endIndex,
        astNormalizedHash: this.hashNormalizedSubtree(child, source),
        surface: this.extractSurfaceSignature(child, source),
        skeletonText: this.extractContractSkeleton(child, source),
      });
    }
    return slices;
  }

  private resolveTopLevelSymbolName(node: SyntaxNode, source: string): string | null {
    const target = node.type === "export_statement" ? node.childForFieldName("declaration") : node;
    if (!target) return null;

    if (target.type === "function_declaration" || target.type === "class_declaration") {
      const nameNode = target.childForFieldName("name");
      return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
    }
    if (target.type === "lexical_declaration") {
      const declarator = target.descendantsOfType("variable_declarator")[0];
      const nameNode = declarator?.childForFieldName("name");
      return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
    }
    return null;
  }
}
