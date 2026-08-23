const ADVERSARIAL_REVIEW_PROMPT = `<adversarial_review>
Treat the preceding assistant response as a draft. Independently derive the best answer from the final request and supplied evidence before comparing it with the draft, then perform a skeptical second-pass audit.

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

export function knowledgeModelOverride(knowledge, packModels = {}) {
  for (const pack of knowledge?.packs || []) {
    const model = packModels[pack.id]?.trim();
    if (model) return model;
  }
  return "";
}

export function knowledgeUsesPack(knowledge, packId) {
  return Boolean(knowledge?.packs?.some((pack) => pack.id === packId));
}

export function availablePremiumReviewModel(knowledge, packId, premium, usage) {
  if (!knowledgeUsesPack(knowledge, packId)) return "";
  const model = premium?.model?.trim();
  const dailyLimit = Math.max(0, Math.floor(Number(premium?.dailyLimit) || 0));
  return model && usage?.used < dailyLimit ? model : "";
}

export async function completeAnswer({
  openRouter,
  apiKey,
  messages,
  sessionId,
  userId,
  model = "",
  reviewModel = "",
  adversarialReview = false,
  logger = console,
}) {
  const request = { apiKey, messages, sessionId, userId, model };
  const draft = await openRouter.complete(request);
  if (!adversarialReview) return draft;

  try {
    const reviewed = await openRouter.complete({
      ...request,
      model: reviewModel.trim() || model,
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
