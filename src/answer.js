const ADVERSARIAL_REVIEW_PROMPT = `<adversarial_review>
Treat the preceding assistant response as a draft. Before answering, perform a skeptical second-pass audit against the final request and all supplied context and evidence.

Check for incorrect or unsupported claims, contradictions with the evidence, citation mismatches, missed constraints, unjustified certainty, and important omissions. For code questions, verify named symbols, files, behavior, defaults, and historical claims against the supplied references. Do not invent support that is absent.

Silently fix every issue you find. Return only the final revised answer, with no review notes, preamble, score, or discussion of this audit. If the draft is already sound, return it unchanged.
</adversarial_review>`;

export function buildAdversarialReviewMessages(messages, draft) {
  return [
    ...messages,
    { role: "assistant", content: draft },
    { role: "user", content: ADVERSARIAL_REVIEW_PROMPT },
  ];
}

export async function completeAnswer({
  openRouter,
  apiKey,
  messages,
  sessionId,
  userId,
  adversarialReview = false,
  logger = console,
}) {
  const request = { apiKey, messages, sessionId, userId };
  const draft = await openRouter.complete(request);
  if (!adversarialReview) return draft;

  try {
    const reviewed = await openRouter.complete({
      ...request,
      messages: buildAdversarialReviewMessages(messages, draft.text),
    });
    return {
      ...reviewed,
      cost: (Number(draft.cost) || 0) + (Number(reviewed.cost) || 0),
      reviewed: true,
    };
  } catch (error) {
    logger.warn?.("Adversarial answer review failed; using the first-pass answer", {
      error: error?.message || String(error),
    });
    return {
      ...draft,
      cost: (Number(draft.cost) || 0) + (Number(error?.cost) || 0),
      reviewed: false,
    };
  }
}
