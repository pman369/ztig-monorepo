import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export interface ChangedFileDiff {
  path: string;
  baseContent: string;
  headContent: string;
}

export class GitDiffer {
  constructor(private cwd: string = process.cwd()) {}

  public getChangedFiles(baseRef: string = "origin/main", headRef: string = "HEAD"): ChangedFileDiff[] {
    try {
      // Find files changed between baseRef and headRef
      const cmd = `git diff --name-only ${baseRef}...${headRef}`;
      const output = execSync(cmd, { cwd: this.cwd, encoding: "utf8" });
      const relativePaths = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && /\.(tsx?|jsx?)$/.test(l));

      const diffs: ChangedFileDiff[] = [];

      for (const relPath of relativePaths) {
        let baseContent = "";
        try {
          baseContent = execSync(`git show ${baseRef}:${relPath}`, {
            cwd: this.cwd,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
          });
        } catch {
          baseContent = ""; // Newly added file
        }

        let headContent = "";
        const diskPath = path.join(this.cwd, relPath);
        if (fs.existsSync(diskPath)) {
          headContent = fs.readFileSync(diskPath, "utf8");
        } else {
          try {
            headContent = execSync(`git show ${headRef}:${relPath}`, {
              cwd: this.cwd,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "ignore"],
            });
          } catch {
            headContent = ""; // Deleted file
          }
        }

        diffs.push({
          path: relPath,
          baseContent,
          headContent,
        });
      }

      return diffs;
    } catch (err: any) {
      throw new Error(`Failed to resolve git diff between ${baseRef} and ${headRef}: ${err.message}`);
    }
  }
}
