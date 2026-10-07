import assert from "node:assert/strict";
import test from "node:test";
import { assessAnswer } from "../src/knowledge/answer-evaluation.js";
const knowledge = { packs: [{ id: "qssm" }], results: [
  { packId: "qssm", sourceId: "engine", locator: "Quake/host.c", startLine: 80, endLine: 85, heading: "", kind: "source", revision: "abc1234", body: 'host_maxfps default "250"' },
] };
const evaluation = { id: "default", required: ["host_maxfps", "\\b250\\b"], forbidden: ["\\b72\\b"], requireCitation: true };

test("answer checks reject wrong defaults and invented console recommendations", () => {
  assert.equal(typeof assessAnswer, "function");
  const wrong = assessAnswer({ answer: "host_maxfps defaults to 72. [Quake/host.c:80]", evaluation, knowledge });
  assert.equal(wrong.passed, false);
  assert.ok(wrong.failures.some((f) => f.includes("250")));
  assert.ok(wrong.failures.some((f) => f.includes("72")));
  const invented = assessAnswer({ answer: "Use r_invented_fov 110. [Quake/host.c:80]", evaluation: { required: ["\\bfov\\b"], forbidden: ["r_invented_fov"], requireCitation: true }, knowledge });
  assert.equal(invented.passed, false);
});

test("answer checks accept supplied line citations but reject fabricated files and line numbers", () => {
  assert.equal(typeof assessAnswer, "function");
  for (const citation of ["Quake/host.c:80", "Quake/host.c:80-85 (source, abc1234)", "qssm:1"]) {
    assert.equal(assessAnswer({ answer: `host_maxfps defaults to 250. [${citation}]`, evaluation, knowledge }).passed, true);
  }
  for (const citation of ["Quake/madeup.c:80", "Quake/host.c:800", "Quake/host.c:79-85", "qssm:2", "Quake/host.c:80 (source, different)"]) {
    assert.equal(assessAnswer({ answer: `host_maxfps defaults to 250. [${citation}]`, evaluation, knowledge }).passed, false, citation);
  }
  assert.equal(assessAnswer({ answer: "host_maxfps defaults to 250.", evaluation, knowledge }).passed, false);
});

test("answer checks distinguish review reference IDs and ignore brackets inside code examples", () => {
  assert.equal(typeof assessAnswer, "function");
  const reviewEvidence = { packs: [{ id: "qssm" }], results: [{ ...knowledge.results[0], locator: "Quake/snd_dma.c", startLine: 399, endLine: 401 }] };
  const answer = 'host_maxfps defaults to 250. `array[9]` [qssm:review:1]';
  assert.equal(assessAnswer({ answer, evaluation, knowledge, reviewEvidence }).passed, true);
  assert.equal(assessAnswer({ answer, evaluation, knowledge }).passed, false);
  assert.equal(assessAnswer({ answer: '```c\narray[9]\n```\nhost_maxfps defaults to 250. [Quake/host.c:80]', evaluation, knowledge }).passed, true);
});

test("the correction evaluation reviews a supplied bad draft with extra evidence and counts actual cost", async () => {
  const { runAnswerCases } = await import("../src/knowledge/answer-evaluation.js");
  assert.equal(typeof runAnswerCases, "function");
  const requests = [];
  const reports = await runAnswerCases({ cases: [{ ...evaluation, question: "QSS-M host_maxfps default?", draft: "host_maxfps defaults to 72. [fake.c:1]" }],
    corrections: true, apiKey: "test", model: "draft-model", reviewModel: "review-model",
    knowledgeManager: {
      async retrieve() { return knowledge; },
      async reviewHints() { return []; },
      async reviewEvidence() { return null; },
    },
    openRouter: { async complete(options) { requests.push(options); return { text: "host_maxfps defaults to 250. [Quake/host.c:80]", cost: 0.01 }; } },
  });
  assert.equal(requests.length, 1, "a deliberately bad draft does not need a paid draft call");
  assert.equal(requests[0].model, "review-model");
  assert.match(requests[0].messages.at(-2).content, /defaults to 72/);
  assert.equal(reports[0].passed, true);
  assert.equal(reports[0].cost, 0.01);
  assert.equal(reports[0].reviewed, true);
});

test("the answer evaluation fails if evidence is unavailable and never calls the provider", async () => {
  const { runAnswerCases } = await import("../src/knowledge/answer-evaluation.js");
  assert.equal(typeof runAnswerCases, "function");
  const reports = await runAnswerCases({ cases: [{ ...evaluation, question: "QSS-M host_maxfps default?" }],
    apiKey: "test", model: "draft", reviewModel: "review",
    knowledgeManager: { async retrieve() { return null; } },
    openRouter: { async complete() { assert.fail("no paid request without evidence"); } },
  });
  assert.equal(reports[0].passed, false);
  assert.equal(reports[0].cost, 0);
  assert.match(reports[0].failures.join(" "), /evidence/);
});

test("exact supplied citation labels remain valid when written in bold instead of brackets", () => {
  const answer = 'host_maxfps defaults to 250 — **Quake/host.c:80-85 (source, abc1234)**.';
  assert.equal(assessAnswer({ answer, evaluation, knowledge }).passed, true);
  assert.equal(assessAnswer({ answer: 'host_maxfps defaults to 250 — **Quake/host.c:800-850 (source, abc1234)**.', evaluation, knowledge }).passed, false);
});

test("citation provenance checks preserve formatting inside citation brackets", () => {
  assert.equal(assessAnswer({ answer: 'host_maxfps defaults to 250. [`Quake/host.c:80`]', evaluation, knowledge }).passed, true);
  assert.equal(assessAnswer({ answer: 'host_maxfps defaults to 250. [Quake/host.c:80] More evidence: [`Quake/nonexistent_settings.c:9000`].', evaluation, knowledge }).passed, false);
  assert.equal(assessAnswer({ answer: 'host_maxfps defaults to 250. [**Quake/host.c:80**]', evaluation, knowledge }).passed, true);
});

test("citation checks reject fabricated revisions in bold even beside a valid citation", () => {
  const answer = 'host_maxfps defaults to 250. [Quake/host.c:80] Also **Quake/host.c:80-85 (source, madeup)**.';
  assert.equal(assessAnswer({ answer, evaluation, knowledge }).passed, false);
});

test("citation checks validate Markdown destinations when links have titles", () => {
  const linkedKnowledge = { ...knowledge, results: [{ ...knowledge.results[0], url: "https://github.com/timbergeron/QSS-M/blob/abc1234/Quake/host.c#L80" }] };
  const correct = 'host_maxfps defaults to 250. [Quake/host.c:80](https://github.com/timbergeron/QSS-M/blob/abc1234/Quake/host.c#L80 "Source")';
  assert.equal(assessAnswer({ answer: correct, evaluation, knowledge: linkedKnowledge }).passed, true);
  const wrong = correct.replace("https://github.com/timbergeron/QSS-M/blob/abc1234/Quake/host.c#L80", "https://madeup.example");
  assert.equal(assessAnswer({ answer: wrong, evaluation, knowledge: linkedKnowledge }).passed, false);
});
