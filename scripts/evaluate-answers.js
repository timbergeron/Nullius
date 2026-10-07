#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeManager } from "../src/knowledge/manager.js";
import { runAnswerCases } from "../src/knowledge/answer-evaluation.js";
import { OpenRouterClient } from "../src/openrouter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = "Usage: npm run knowledge:test-answers -- --live [--corrections] [--case ID]\nThis makes paid OpenRouter calls: two per normal case, one per correction case. It does not post to Discord or consume its daily premium quota.";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(help); return; }
  let live = false;
  let corrections = false;
  let selected = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live") live = true;
    else if (arg === "--corrections") corrections = true;
    else if (arg === "--case" && args[index + 1] && !args[index + 1].startsWith("--")) selected = args[++index];
    else throw new Error(`Unknown or incomplete option: ${arg}\n${help}`);
  }
  if (!live) throw new Error(`Explicit --live is required.\n${help}`);
  const { cases: allCases } = JSON.parse(await readFile(path.join(root, "knowledge-packs/qssm/answer-evaluations.json"), "utf8"));
  const cases = allCases.filter((item) => !selected || item.id === selected);
  if (!cases.length) throw new Error(`Unknown answer case: ${selected}`);
  // Validate committed assertions before spending anything.
  for (const item of cases) {
    if (!item.id || !item.question || (corrections && !item.draft)) throw new Error("Invalid answer evaluation case");
    for (const pattern of [...(item.required || []), ...(item.forbidden || [])]) new RegExp(pattern, "i");
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for live answer evaluation");
  const model = process.env.QSSM_OPENROUTER_MODEL?.trim() || "openai/gpt-6.1-sol";
  const reviewModel = process.env.QSSM_PREMIUM_OPENROUTER_MODEL?.trim() || model;
  console.log(JSON.stringify({ mode: corrections ? "correction" : "answer", cases: cases.length, model, reviewModel }));
  const manager = await new KnowledgeManager({ packsDirectory: path.join(root, "knowledge-packs"), indexDirectory: path.join(root, "data/knowledge") }).init();
  try {
    const openRouter = new OpenRouterClient({ model, maxOutputTokens: 3000, retryOutputTokens: 6000, publicUrl: process.env.PUBLIC_URL || "http://localhost:3000" });
    const reports = await runAnswerCases({ cases, knowledgeManager: manager, openRouter, apiKey, model, reviewModel, corrections,
      onResult: (report) => console.log(JSON.stringify(report)),
    });
    const passed = reports.filter((report) => report.passed).length;
    console.log(JSON.stringify({ passed, total: reports.length, cost: reports.reduce((sum, report) => sum + report.cost, 0) }));
    if (passed !== reports.length) process.exitCode = 1;
  } finally { manager.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
