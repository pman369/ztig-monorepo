#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import path from "path";
import { AstSieveEngine } from "@ztig/core";
import { GitDiffer } from "./git-differ";
import { evaluateDiffs, loadGraph } from "./evaluator";

const program = new Command();

program
  .name("ztig")
  .description("Zero-Touch Intent Graph (ZTIG) CLI - Autonomous state synchronization and drift guardrail")
  .version("1.0.0");

program
  .command("evaluate-drift")
  .description("Evaluate code changes against the Intent Graph to detect contract regressions and pin violations")
  .option("-b, --base <ref>", "Git base reference or branch", "origin/main")
  .option("-h, --head <ref>", "Git head reference", "HEAD")
  .option("-g, --graph <path>", "Path to ztig.json intent graph")
  .option("--fail-on-drift <boolean>", "Exit with code 1 if drift or pin violations are detected", "true")
  .option("--format <type>", "Output format: pretty, markdown, or json", "pretty")
  .action(async (options) => {
    try {
      const failOnDrift = options.failOnDrift === "true" || options.failOnDrift === true;
      const cwd = process.cwd();
      const graph = loadGraph(options.graph, cwd);

      const differ = new GitDiffer(cwd);
      let diffs: any[] = [];
      try {
        diffs = differ.getChangedFiles(options.base, options.head);
      } catch (err: any) {
        if (options.format === "pretty") {
          console.warn(`[ztig] Git diff unavailable (${err.message}). Skipping diff evaluation.`);
        }
        process.exit(0);
      }

      if (diffs.length === 0) {
        if (options.format === "pretty") {
          console.log("No changed files to evaluate.");
        } else if (options.format === "json") {
          console.log(JSON.stringify({ success: true, filesEvaluated: 0 }));
        }
        process.exit(0);
      }

      const sieve = await AstSieveEngine.createDefault();
      const report = await evaluateDiffs(diffs, graph, sieve);

      if (options.format === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else if (options.format === "markdown") {
        console.log("### ZTIG Drift Evaluation Report");
        console.log(`- **Files Evaluated:** ${report.filesEvaluated}`);
        console.log(`- **Status:** ${report.success ? "Passed :white_check_mark:" : "Failed :x:"}`);
        if (report.pinViolations.length > 0) {
          console.log("\n#### Pin Violations");
          report.pinViolations.forEach((v) => console.log(`- ${v}`));
        }
        if (report.driftedNodes.length > 0) {
          console.log("\n#### Drifted Nodes");
          report.driftedNodes.forEach((d) => console.log(`- Node \`${d}\` drifted from contract`));
        }
      } else {
        console.log("\n=======================================================");
        console.log("         ZTIG CONTRACT DRIFT EVALUATION REPORT         ");
        console.log("=======================================================");
        console.log(`Files Evaluated: ${report.filesEvaluated}`);
        console.log(`Overall Status : ${report.success ? "PASSED" : "FAILED"}\n`);

        if (report.pinViolations.length > 0) {
          console.error("PIN VIOLATIONS:");
          report.pinViolations.forEach((v) => console.error(`  x ${v}`));
          console.error("");
        }

        if (report.driftedNodes.length > 0) {
          console.warn("DRIFTED INTENT NODES:");
          report.driftedNodes.forEach((n) => console.warn(`  ! Node [${n}] drifted from contract`));
          console.warn("");
        }

        if (report.alerts.length > 0) {
          console.log("ALERTS & TELEMETRY:");
          report.alerts.forEach((a) => console.log(`  ${a}`));
          console.log("");
        }
      }

      if (!report.success && failOnDrift) {
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`[ztig] Error during evaluation: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("inspect")
  .description("Inspect the Intent Graph nodes, edges, invariants, and statuses")
  .option("-g, --graph <path>", "Path to ztig.json intent graph")
  .action((options) => {
    const graph = loadGraph(options.graph);
    console.log(`\nInvariants (${graph.invariants.length}):`);
    graph.invariants.forEach((inv) => console.log(` - ${inv}`));

    console.log(`\nIntent Nodes (${Object.keys(graph.nodes).length}):`);
    for (const [id, node] of Object.entries(graph.nodes)) {
      console.log(` [${node.status.toUpperCase()}] ${id}: "${node.vibe}"`);
      console.log(`   Artifacts: ${node.artifacts.join(", ") || "none"}`);
      console.log(`   Contracts: ${node.contracts.join("; ") || "none"}`);
    }

    console.log(`\nDirected Edges (${graph.edges.length}):`);
    graph.edges.forEach((e) => console.log(` - ${e.from} --(${e.type})--> ${e.to}`));
    console.log("");
  });

program
  .command("init")
  .description("Initialize an empty ztig.json intent graph file in the current directory")
  .action(() => {
    const target = path.join(process.cwd(), "ztig.json");
    if (fs.existsSync(target)) {
      console.log("ztig.json already exists.");
      return;
    }
    const template = {
      $schema: "https://spec.ztig.dev/v1/schema.json",
      invariants: [],
      nodes: {},
      edges: [],
    };
    fs.writeFileSync(target, JSON.stringify(template, null, 2), "utf8");
    console.log("Initialized empty ztig.json configuration.");
  });

if (process.argv.length <= 2) {
  program.help();
} else {
  program.parse(process.argv);
}
