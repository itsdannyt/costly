import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const VERIFY_URL = "https://www.getcostly.dev/api/v1/verify-key";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(msg);
}

function success(msg: string) {
  log(`${GREEN}  ✓${RESET} ${msg}`);
}

function warn(msg: string) {
  log(`${YELLOW}  !${RESET} ${msg}`);
}

function error(msg: string) {
  log(`${RED}  ✗${RESET} ${msg}`);
}

function dim(msg: string): string {
  return `${DIM}${msg}${RESET}`;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} ${dim("(Y/n)")} `);
  return answer === "" || answer.toLowerCase() === "y";
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function installCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm": return "pnpm add costly";
    case "yarn": return "yarn add costly";
    case "bun":  return "bun add costly";
    default:     return "npm install costly";
  }
}

// ---------------------------------------------------------------------------
// Source file scanning
// ---------------------------------------------------------------------------

interface FoundFile {
  filePath: string;
  relativePath: string;
  line: number;
  match: string;       // the matched line, trimmed
  varName: string;     // e.g. "anthropic", "client"
  fullInit: string;    // e.g. "new Anthropic()" or "new Anthropic({ apiKey: ... })"
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", ".vercel", "coverage"]);

function scanDirectory(dir: string, cwd: string): FoundFile[] {
  const results: FoundFile[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...scanDirectory(fullPath, cwd));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      const found = scanFile(fullPath, cwd);
      if (found.length > 0) results.push(...found);
    }
  }

  return results;
}

function scanFile(filePath: string, cwd: string): FoundFile[] {
  const results: FoundFile[] = [];
  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return results;
  }

  // Skip files that already use costly
  if (content.includes("from \"costly\"") || content.includes("from 'costly'") || content.includes("require(\"costly\")") || content.includes("require('costly')")) {
    return results;
  }

  const lines = content.split("\n");
  // Match patterns like:
  //   const anthropic = new Anthropic()
  //   const client = new Anthropic({ apiKey: ... })
  //   let ai = new Anthropic();
  //   export const anthropic = new Anthropic()
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

// ---------------------------------------------------------------------------
// File modification
// ---------------------------------------------------------------------------

function applyChanges(found: FoundFile[]): void {
  // Group by file
  const byFile = new Map<string, FoundFile[]>();
  for (const f of found) {
    const existing = byFile.get(f.filePath) || [];
    existing.push(f);
    byFile.set(f.filePath, existing);
  }

  for (const [filePath, items] of byFile) {
    let content = fs.readFileSync(filePath, "utf-8");

    // Check if file already imports costly
    const hasCostlyImport =
      content.includes("from \"costly\"") ||
      content.includes("from 'costly'") ||
      content.includes("require(\"costly\")") ||
      content.includes("require('costly')");

    // Determine if the file uses ESM imports or CJS require
    const usesEsm = content.includes("import ") && (content.includes(" from ") || content.includes("import {"));

    // Add costly import if not present
    if (!hasCostlyImport) {
      const importStatement = usesEsm
        ? 'import { costly } from "costly";\n'
        : 'const { costly } = require("costly");\n';

      // Find the best place to insert: after the last import/require statement
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

    // Wrap each new Anthropic() call
    for (const item of items) {
      content = content.replace(
        item.fullInit,
        `costly().wrap(${item.fullInit})`,
      );
    }

    fs.writeFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// .env handling
// ---------------------------------------------------------------------------

function addToEnvFile(cwd: string, apiKey: string): void {
  const envPath = path.join(cwd, ".env");
  let content = "";

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");

    // Check if COSTLY_API_KEY already exists
    if (content.includes("COSTLY_API_KEY=")) {
      // Replace existing value
      content = content.replace(/COSTLY_API_KEY=.*/, `COSTLY_API_KEY=${apiKey}`);
      fs.writeFileSync(envPath, content, "utf-8");
      return;
    }
  }

  // Append to .env
  const newLine = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(envPath, content + newLine + `COSTLY_API_KEY=${apiKey}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// API key verification
// ---------------------------------------------------------------------------

async function verifyApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return res.ok;
  } catch {
    // Network error — skip verification, trust the user
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cwd = process.cwd();

  log("");
  log(`  ${BOLD}costly${RESET} ${dim("v0.1.0")}`);
  log("");

  // Step 1: Get API key
  const apiKey = await ask(`  ${CYAN}?${RESET} Paste your API key ${dim("(from getcostly.dev/dashboard)")}: `);

  if (!apiKey || !apiKey.startsWith("ck_")) {
    log("");
    error("Invalid API key. It should start with ck_");
    log(`    Get yours at ${CYAN}https://getcostly.dev/dashboard${RESET}`);
    log("");
    process.exit(1);
  }

  // Verify the key
  const valid = await verifyApiKey(apiKey);
  if (!valid) {
    log("");
    error("API key not recognized. Check your key and try again.");
    log(`    Get yours at ${CYAN}https://getcostly.dev/dashboard${RESET}`);
    log("");
    process.exit(1);
  }

  success("API key verified");
  log("");

  // Step 2: Scan for Anthropic SDK usage
  log(`  Scanning for Anthropic SDK usage...`);
  log("");

  const found = scanDirectory(cwd, cwd);

  if (found.length === 0) {
    warn("No \`new Anthropic()\` calls found in your codebase.");
    log("");
    log(`  You can add Costly manually:`);
    log("");
    log(`  ${DIM}import { costly } from "costly";${RESET}`);
    log(`  ${DIM}const client = costly().wrap(new Anthropic());${RESET}`);
    log("");

    // Still offer to install and add env var
    const shouldContinue = await confirm(`  Install costly and add API key to .env anyway?`);
    if (shouldContinue) {
      const pm = detectPackageManager(cwd);
      log("");
      await installPackage(pm);
      addToEnvFile(cwd, apiKey);
      success("Added COSTLY_API_KEY to .env");
      log("");
      log(`  Add the wrapper to your code when you're ready.`);
    }
    log("");
    process.exit(0);
  }

  // Show what we found
  log(`  Found ${found.length} file${found.length === 1 ? "" : "s"} using the Anthropic SDK:`);
  log("");
  for (const f of found) {
    log(`    ${f.relativePath}:${f.line}`);
    log(`    ${dim(f.match)}`);
    log("");
  }

  // Step 3: Show the diff preview
  const shouldWrap = await confirm(`  Wrap ${found.length === 1 ? "this file" : "these files"} with Costly?`);
  if (!shouldWrap) {
    log("");
    log(`  No worries. You can add Costly manually:`);
    log(`  ${DIM}const client = costly().wrap(new Anthropic());${RESET}`);
    log("");
    process.exit(0);
  }

  log("");
  log(`  Here's what will change:`);
  log("");

  for (const f of found) {
    log(`  ${BOLD}${f.relativePath}${RESET}`);
    log(`  ${"─".repeat(40)}`);
    log(`  ${GREEN}+${RESET} import { costly } from "costly";`);
    log(`  ${RED}-${RESET} ${f.match}`);

    // Build the replacement line
    const wrappedInit = `costly().wrap(${f.fullInit})`;
    const newLine = f.match.replace(f.fullInit, wrappedInit);
    log(`  ${GREEN}+${RESET} ${newLine}`);
    log("");
  }

  const shouldApply = await confirm(`  Apply changes?`);
  if (!shouldApply) {
    log("");
    log(`  Cancelled. No files were modified.`);
    log("");
    process.exit(0);
  }

  log("");

  // Step 4: Install package
  const pm = detectPackageManager(cwd);
  await installPackage(pm);

  // Step 5: Apply code changes
  applyChanges(found);
  for (const f of found) {
    success(`Updated ${f.relativePath}`);
  }

  // Step 6: Add to .env
  addToEnvFile(cwd, apiKey);
  success("Added COSTLY_API_KEY to .env");

  log("");
  log(`  ${GREEN}${BOLD}You're all set.${RESET} Your dashboard will light up within 48 hours.`);
  log(`  ${dim("https://getcostly.dev/dashboard")}`);
  log("");
}

// ---------------------------------------------------------------------------
// Package installation
// ---------------------------------------------------------------------------

async function installPackage(pm: PackageManager): Promise<void> {
  const { execSync } = await import("child_process");
  const cmd = installCommand(pm);

  try {
    execSync(cmd, { stdio: "pipe", cwd: process.cwd() });
    success(`Installed costly ${dim(`via ${pm}`)}`);
  } catch {
    warn(`Could not auto-install. Run manually: ${cmd}`);
  }
}

function showHelp() {
  log("");
  log(`  ${BOLD}costly${RESET} ${dim("v0.1.0")}`);
  log("");
  log(`  ${BOLD}Usage:${RESET}`);
  log(`    costly init    Set up Costly in your project`);
  log("");
  log(`  ${BOLD}Learn more:${RESET}`);
  log(`    ${CYAN}https://getcostly.dev${RESET}`);
  log("");
}

const command = process.argv[2];

if (command === "init") {
  main().catch((err) => {
    error(err.message || "An unexpected error occurred");
    process.exit(1);
  });
} else {
  showHelp();
}
