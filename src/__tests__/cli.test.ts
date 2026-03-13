import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We can't import the CLI functions directly since they're not exported.
// Instead, we test the same logic by creating temp fixtures and running
// the scan/transform patterns the CLI uses.

// ---------- Replicate the core CLI logic for testing ----------

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", ".vercel", "coverage"]);

interface FoundFile {
  filePath: string;
  relativePath: string;
  line: number;
  match: string;
  varName: string;
  fullInit: string;
}

function scanFile(filePath: string, cwd: string): FoundFile[] {
  const results: FoundFile[] = [];
  const content = fs.readFileSync(filePath, "utf-8");

  if (
    content.includes('from "costly"') ||
    content.includes("from 'costly'") ||
    content.includes('require("costly")') ||
    content.includes("require('costly')")
  ) {
    return results;
  }

  const lines = content.split("\n");
  const pattern = /(?:(?:export\s+)?(?:const|let|var)\s+)(\w+)\s*=\s*(new\s+Anthropic\s*\([^)]*\))/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) {
      results.push({
        filePath,
        relativePath: path.relative(cwd, filePath),
        line: i + 1,
        match: lines[i].trim(),
        varName: match[1],
        fullInit: match[2],
      });
    }
  }

  return results;
}

function applyChanges(found: FoundFile[]): void {
  const byFile = new Map<string, FoundFile[]>();
  for (const f of found) {
    const existing = byFile.get(f.filePath) || [];
    existing.push(f);
    byFile.set(f.filePath, existing);
  }

  for (const [filePath, items] of byFile) {
    let content = fs.readFileSync(filePath, "utf-8");

    const hasCostlyImport =
      content.includes('from "costly"') ||
      content.includes("from 'costly'") ||
      content.includes('require("costly")') ||
      content.includes("require('costly')");

    const usesEsm = content.includes("import ") && (content.includes(" from ") || content.includes("import {"));

    if (!hasCostlyImport) {
      const importStatement = usesEsm
        ? 'import { costly } from "costly";\n'
        : 'const { costly } = require("costly");\n';

      const lines = content.split("\n");
      let insertIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (
          line.startsWith("import ") ||
          line.startsWith("import{") ||
          (line.includes("require(") && (line.startsWith("const ") || line.startsWith("let ") || line.startsWith("var ")))
        ) {
          insertIndex = i + 1;
        }
      }

      lines.splice(insertIndex, 0, importStatement.trimEnd());
      content = lines.join("\n");
    }

    for (const item of items) {
      content = content.replace(item.fullInit, `costly().wrap(${item.fullInit})`);
    }

    fs.writeFileSync(filePath, content, "utf-8");
  }
}

function addToEnvFile(cwd: string, apiKey: string): void {
  const envPath = path.join(cwd, ".env");
  let content = "";

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");

    if (content.includes("COSTLY_API_KEY=")) {
      content = content.replace(/COSTLY_API_KEY=.*/, `COSTLY_API_KEY=${apiKey}`);
      fs.writeFileSync(envPath, content, "utf-8");
      return;
    }
  }

  const newLine = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(envPath, content + newLine + `COSTLY_API_KEY=${apiKey}\n`, "utf-8");
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

// ---------- Tests ----------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "costly-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanFile — detecting new Anthropic() calls", () => {
  it("finds basic const anthropic = new Anthropic()", () => {
    const file = path.join(tmpDir, "index.ts");
    fs.writeFileSync(file, `import Anthropic from "@anthropic-ai/sdk";\n\nconst anthropic = new Anthropic();\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].varName).toBe("anthropic");
    expect(results[0].fullInit).toBe("new Anthropic()");
    expect(results[0].line).toBe(3);
  });

  it("finds new Anthropic({ apiKey: ... })", () => {
    const file = path.join(tmpDir, "client.ts");
    fs.writeFileSync(file, `const client = new Anthropic({ apiKey: "sk-test" });\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].varName).toBe("client");
    expect(results[0].fullInit).toBe('new Anthropic({ apiKey: "sk-test" })');
  });

  it("finds export const", () => {
    const file = path.join(tmpDir, "shared.ts");
    fs.writeFileSync(file, `export const ai = new Anthropic();\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].varName).toBe("ai");
  });

  it("finds let and var declarations", () => {
    const file = path.join(tmpDir, "app.ts");
    fs.writeFileSync(file, `let client = new Anthropic();\nvar backup = new Anthropic();\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(2);
  });

  it("skips files that already use costly", () => {
    const file = path.join(tmpDir, "wrapped.ts");
    fs.writeFileSync(file, `import { costly } from "costly";\nconst anthropic = costly().wrap(new Anthropic());\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(0);
  });

  it("skips files with require('costly')", () => {
    const file = path.join(tmpDir, "wrapped.js");
    fs.writeFileSync(file, `const { costly } = require('costly');\nconst anthropic = costly().wrap(new Anthropic());\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(0);
  });

  it("returns empty for files without Anthropic", () => {
    const file = path.join(tmpDir, "other.ts");
    fs.writeFileSync(file, `const x = 42;\n`);

    const results = scanFile(file, tmpDir);
    expect(results).toHaveLength(0);
  });
});

describe("applyChanges — code transformation", () => {
  it("adds ESM import and wraps new Anthropic()", () => {
    const file = path.join(tmpDir, "index.ts");
    const original = `import Anthropic from "@anthropic-ai/sdk";\n\nconst anthropic = new Anthropic();\n`;
    fs.writeFileSync(file, original);

    const found = scanFile(file, tmpDir);
    applyChanges(found);

    const result = fs.readFileSync(file, "utf-8");
    expect(result).toContain('import { costly } from "costly";');
    expect(result).toContain("costly().wrap(new Anthropic())");
    expect(result).not.toMatch(/(?<!costly\(\)\.wrap\()new Anthropic\(\)(?!\))/);
  });

  it("adds CJS require for CommonJS files", () => {
    const file = path.join(tmpDir, "index.js");
    const original = `const Anthropic = require("@anthropic-ai/sdk");\n\nconst client = new Anthropic();\n`;
    fs.writeFileSync(file, original);

    const found = scanFile(file, tmpDir);
    applyChanges(found);

    const result = fs.readFileSync(file, "utf-8");
    expect(result).toContain('const { costly } = require("costly");');
    expect(result).toContain("costly().wrap(new Anthropic())");
  });

  it("inserts import after existing imports", () => {
    const file = path.join(tmpDir, "app.ts");
    const original = [
      'import Anthropic from "@anthropic-ai/sdk";',
      'import { config } from "dotenv";',
      "",
      "const anthropic = new Anthropic();",
      "",
    ].join("\n");
    fs.writeFileSync(file, original);

    const found = scanFile(file, tmpDir);
    applyChanges(found);

    const result = fs.readFileSync(file, "utf-8");
    const lines = result.split("\n");

    // costly import should be after the last import
    const costlyLine = lines.findIndex((l) => l.includes('from "costly"'));
    const dotenvLine = lines.findIndex((l) => l.includes("dotenv"));
    expect(costlyLine).toBeGreaterThan(dotenvLine);
  });

  it("handles multiple files in one pass", () => {
    const file1 = path.join(tmpDir, "a.ts");
    const file2 = path.join(tmpDir, "b.ts");
    fs.writeFileSync(file1, `import Anthropic from "@anthropic-ai/sdk";\nconst a = new Anthropic();\n`);
    fs.writeFileSync(file2, `import Anthropic from "@anthropic-ai/sdk";\nconst b = new Anthropic();\n`);

    const found = [...scanFile(file1, tmpDir), ...scanFile(file2, tmpDir)];
    applyChanges(found);

    expect(fs.readFileSync(file1, "utf-8")).toContain("costly().wrap(new Anthropic())");
    expect(fs.readFileSync(file2, "utf-8")).toContain("costly().wrap(new Anthropic())");
  });

  it("preserves original Anthropic constructor args", () => {
    const file = path.join(tmpDir, "index.ts");
    fs.writeFileSync(file, `import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic({ apiKey: "sk-test" });\n`);

    const found = scanFile(file, tmpDir);
    applyChanges(found);

    const result = fs.readFileSync(file, "utf-8");
    expect(result).toContain('costly().wrap(new Anthropic({ apiKey: "sk-test" }))');
  });
});

describe("addToEnvFile", () => {
  it("creates .env if it doesn't exist", () => {
    addToEnvFile(tmpDir, "ck_test123");

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toBe("COSTLY_API_KEY=ck_test123\n");
  });

  it("appends to existing .env", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "DATABASE_URL=postgres://localhost\n");

    addToEnvFile(tmpDir, "ck_test456");

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("DATABASE_URL=postgres://localhost");
    expect(content).toContain("COSTLY_API_KEY=ck_test456");
  });

  it("replaces existing COSTLY_API_KEY", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "COSTLY_API_KEY=ck_old_key\nOTHER=value\n");

    addToEnvFile(tmpDir, "ck_new_key");

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("COSTLY_API_KEY=ck_new_key");
    expect(content).not.toContain("ck_old_key");
    expect(content).toContain("OTHER=value");
  });

  it("handles .env without trailing newline", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "FOO=bar");

    addToEnvFile(tmpDir, "ck_test");

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toBe("FOO=bar\nCOSTLY_API_KEY=ck_test\n");
  });
});

describe("detectPackageManager", () => {
  it("detects pnpm", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("detects yarn", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("detects bun (bun.lockb)", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("detects bun (bun.lock)", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("defaults to npm", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("pnpm takes precedence over yarn", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });
});

describe("end-to-end: scan → transform → verify", () => {
  it("full workflow on a realistic project structure", () => {
    // Set up a fake project
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir);

    // Main file with Anthropic usage
    fs.writeFileSync(
      path.join(srcDir, "ai.ts"),
      [
        'import Anthropic from "@anthropic-ai/sdk";',
        'import { config } from "dotenv";',
        "",
        "config();",
        "",
        "const anthropic = new Anthropic();",
        "",
        'export async function chat(msg: string) {',
        "  const response = await anthropic.messages.create({",
        '    model: "claude-sonnet-4-20250514",',
        "    max_tokens: 1024,",
        '    messages: [{ role: "user", content: msg }],',
        "  });",
        "  return response;",
        "}",
        "",
      ].join("\n"),
    );

    // A file that should NOT be touched
    fs.writeFileSync(path.join(srcDir, "utils.ts"), 'export const foo = "bar";\n');

    // package.json for context
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name": "test-project"}\n');
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");

    // 1. Scan
    const found = scanFile(path.join(srcDir, "ai.ts"), tmpDir);
    expect(found).toHaveLength(1);
    expect(found[0].varName).toBe("anthropic");
    expect(found[0].line).toBe(6);

    // 2. Transform
    applyChanges(found);

    // 3. Verify the transformed file
    const result = fs.readFileSync(path.join(srcDir, "ai.ts"), "utf-8");

    // Has costly import after existing imports
    expect(result).toContain('import { costly } from "costly";');

    // Wrapped the Anthropic constructor
    expect(result).toContain("const anthropic = costly().wrap(new Anthropic());");

    // Didn't break the rest of the file
    expect(result).toContain("anthropic.messages.create");
    expect(result).toContain("export async function chat");

    // 4. Add .env
    addToEnvFile(tmpDir, "ck_abc123");
    const envContent = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(envContent).toBe("COSTLY_API_KEY=ck_abc123\n");

    // 5. Detect package manager
    expect(detectPackageManager(tmpDir)).toBe("pnpm");

    // 6. Verify utils.ts was untouched
    expect(fs.readFileSync(path.join(srcDir, "utils.ts"), "utf-8")).toBe('export const foo = "bar";\n');
  });
});
