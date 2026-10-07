import { citationLabel } from "./prompt.js";
import { buildLlmMessages } from "../context.js";
import { completeAnswer } from "../answer.js";

function referenceIds(knowledge, prefix = "") {
  return (knowledge?.packs || []).flatMap((pack) => (knowledge.results || [])
    .filter((result) => result.packId === pack.id)
    .map((result, index) => ({ id: `${pack.id}:${prefix}${index + 1}`, result })));
}

function matchesLabel(label, result) {
  if (label === citationLabel(result)) return true;
  const escaped = result.locator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:([0-9]+)(?:-([0-9]+))?(.*)$`).exec(label);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (start < result.startLine || end > result.endLine || end < start) return false;
  const metadata = [result.kind, result.revision].filter(Boolean).join(", ");
  const heading = result.heading && !result.locator.includes(result.heading) ? ` — ${result.heading}` : "";
  return new Set(["", heading, metadata ? ` (${metadata})` : "", metadata ? `${heading} (${metadata})` : heading]).has(match[3]);
}

// This checks explicit case assertions and citation provenance, not whether every
// natural-language claim is entailed by its source. Live cases still need review.
export function assessAnswer({ answer, evaluation, knowledge, reviewEvidence = null }) {
  const text = String(answer || "");
  const failures = [];
  if (!text.trim()) failures.push("empty answer");
  for (const pattern of evaluation.required || []) {
    if (!new RegExp(pattern, "i").test(text)) failures.push(`missing required claim: ${pattern}`);
  }
  for (const pattern of evaluation.forbidden || []) {
    if (new RegExp(pattern, "i").test(text)) failures.push(`forbidden claim: ${pattern}`);
  }
  const references = [...referenceIds(knowledge), ...referenceIds(reviewEvidence, "review:")];
  // Preserve citation brackets before removing ordinary inline code, so a
  // fabricated label cannot hide inside backticks within a citation.
  const prose = text.replace(/```[\s\S]*?```/g, "")
    .replace(/\[[^\]\n]{1,600}\](?:\([^)\n]*\))?|`[^`\n]*`/g,
      (part) => part.startsWith("[") ? part.replaceAll("`", "").replaceAll("**", "") : "");
  const citationPattern = /\[([^\]\n]{1,600})\](?:\(([^)\n]*)\))?/g;
  const citations = [...prose.matchAll(citationPattern)];
  let supported = 0;
  for (const [, labels, link] of citations) {
    const destination = link === undefined ? null : /^\s*<?([^\s<>]+?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/.exec(link);
    if (link !== undefined && !destination) { failures.push("malformed citation link"); continue; }
    const url = destination?.[1];
    for (const label of labels.split(";").map((part) => part.trim())) {
      const found = references.find(({ id, result }) =>
        (label === id || matchesLabel(label, result)) && (!url || url === result.url));
      if (found) supported += 1;
      else failures.push(`unsupported citation: ${label}`);
    }
  }
  const plain = prose.replace(citationPattern, "").replaceAll("**", "");
  // A complete supplied label is also a usable citation when written in prose
  // or bold. Keep checking source file/line references outside brackets too.
  for (const { result } of references) {
    if (plain.includes(citationLabel(result))) supported += 1;
  }
  const labels = new Map();
  const collect = (pattern) => {
    for (const match of plain.matchAll(pattern)) {
      const metadata = /^(?: — [^\n()]{1,160}?)? \([^()\n]{1,200}\)/.exec(plain.slice(match.index + match[0].length));
      labels.set(match.index, match[0] + (metadata?.[0] || ""));
    }
  };
  collect(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:c|h|m|cpp|md|txt):[0-9]+(?:-[0-9]+)?/g);
  for (const { result } of references) {
    const locator = result.locator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    collect(new RegExp(`${locator}:[0-9]+(?:-[0-9]+)?`, "g"));
  }
  for (const label of labels.values()) {
    if (!references.some(({ result }) => matchesLabel(label, result))) failures.push(`unsupported citation: ${label}`);
  }
  if (evaluation.requireCitation && !supported) failures.push("missing supplied citation");
  return { passed: !failures.length, failures };
}

export async function runAnswerCases({ cases, knowledgeManager, openRouter, apiKey, model, reviewModel, corrections = false, logger = console, onResult = null }) {
  const reports = [];
  for (const evaluation of cases) {
    const report = { id: evaluation.id, mode: corrections ? "correction" : "answer", question: evaluation.question, cost: 0, reviewed: false };
    try {
      const knowledge = await knowledgeManager.retrieve({ packIds: ["qssm"], question: evaluation.question });
      if (!knowledge?.results?.length) throw new Error("no retrieved QSS-M evidence");
      let reviewEvidence = null;
      const messages = buildLlmMessages([{ id: evaluation.id, content: evaluation.question, author: { username: "Answer evaluation" } }], {
        botId: "evaluation", maxCharacters: 16_000, knowledge,
      });
      let first = true;
      const client = corrections ? { async complete(options) {
        if (first) { first = false; return { text: evaluation.draft, cost: 0 }; }
        return openRouter.complete(options);
      } } : openRouter;
      const answer = await completeAnswer({ openRouter: client, apiKey, messages, model, reviewModel, adversarialReview: true,
        sessionId: `qssm-evaluation:${evaluation.id}`, userId: "operator-evaluation", logger,
        reviewHints: (draft) => knowledgeManager.reviewHints({ packIds: ["qssm"], draft }),
        reviewEvidence: async (draft) => {
          reviewEvidence = await knowledgeManager.reviewEvidence({ packIds: ["qssm"], draft, knowledge });
          return reviewEvidence;
        },
      });
      Object.assign(report, { text: answer.text, cost: answer.cost, reviewed: answer.reviewed,
        supplementaryPassages: reviewEvidence?.results?.length || 0,
        ...assessAnswer({ answer: answer.text, evaluation, knowledge, reviewEvidence }) });
      if (!answer.reviewed) { report.passed = false; report.failures.push("review did not complete"); }
    } catch (error) {
      Object.assign(report, { passed: false, failures: [error.message], cost: Number(error.cost) || 0 });
    }
    reports.push(report);
    await onResult?.(report);
  }
  return reports;
}
