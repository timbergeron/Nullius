const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const RECENT_IMAGE_AGE_MS = 5 * 60 * 1000;

function discordImageUrl(value) {
  try {
    const url = new URL(value);
    const allowedHost = ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
      || /^images-ext-\d+\.discordapp\.net$/.test(url.hostname);
    return url.protocol === "https:" && allowedHost && !url.username && !url.password
      && (!url.port || url.port === "443") ? url.href : "";
  } catch {
    return "";
  }
}

export function messageImages(message) {
  const images = [];
  const seen = new Set();
  function add(image, aliases = []) {
    if (!image.url || seen.has(image.url)) return;
    for (const url of [image.url, ...aliases]) seen.add(url);
    images.push({
      ...image,
      messageId: message.id,
      author: String(message.member?.displayName || message.author?.globalName || message.author?.username || "Someone").slice(0, 100),
      createdTimestamp: Number(message.createdTimestamp) || 0,
      caption: (message.content || "").slice(0, 500),
    });
  }
  for (const attachment of message.attachments?.values?.() || []) {
    const type = attachment.contentType?.split(";")[0]?.toLowerCase();
    if (type ? !IMAGE_TYPES.has(type) : !/\.(png|jpe?g|webp|gif)$/i.test(attachment.name || "")) continue;
    add({ url: attachment.url, name: (attachment.name || "image").slice(0, 200), size: Number(attachment.size) || 0 }, [attachment.proxyURL]);
  }
  for (const embed of message.embeds || []) {
    // Site logos and video thumbnails are unrelated to image questions.
    const image = embed.image || (["image", "gifv"].includes(embed.type) ? embed.thumbnail : null);
    if (!image) continue;
    add({ url: image.proxyURL || image.url, name: "embedded image", size: 0 }, [image.url]);
  }
  return images;
}

function refersToRecentImage(content) {
  const question = content.replace(/<@!?\d+>/g, "").trim();
  return /\b(images?|pictures?|photos?|screenshots?|drawings?|diagrams?|memes?|renders?|these|those|above)\b/i.test(question)
    || /\b(this|that|it)\b/i.test(question) && /\b(what|why|how|explain|describe|look|looks|see|think|wrong|broken|read|identify|thoughts)\b/i.test(question)
    || /^(?:(?:any|your)\s+)?thoughts[?!.]*$/i.test(question)
    || /^what do you think[?!.]*$/i.test(question);
}

export function selectConversationImages(context, { maxImages = MAX_IMAGES } = {}) {
  const limit = Math.min(MAX_IMAGES, Math.max(1, Math.floor(maxImages) || MAX_IMAGES));
  const invocation = context.at(-1);
  const empty = { candidates: [], source: "", truncated: false };
  if (!invocation) return empty;
  function selection(images, source) {
    return { candidates: images.slice(0, limit), source, truncated: images.length > limit };
  }
  const own = messageImages(invocation);
  if (own.length) return selection(own, "request");

  const byId = new Map(context.map((message) => [message.id, message]));
  const visited = new Set([invocation.id]);
  let parentId = invocation.reference?.messageId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const images = messageImages(parent);
    if (images.length) return selection(images, "reply");
    parentId = parent.reference?.messageId;
  }

  if (!refersToRecentImage(invocation.content || "")) return empty;
  const recent = context.slice(0, -1).filter((message) => {
    const age = Number(invocation.createdTimestamp) - Number(message.createdTimestamp);
    return Number.isFinite(age) && age >= 0 && age <= RECENT_IMAGE_AGE_MS;
  });
  // Keep newest candidates within the cap, then restore chronological ordering.
  const groups = recent.reverse().map(messageImages).filter((images) => images.length);
  const newest = groups.flat();
  const kept = newest.slice(0, limit);
  const order = new Map(context.map((message, index) => [message.id, index]));
  kept.sort((left, right) => order.get(left.messageId) - order.get(right.messageId));
  return { candidates: kept, source: kept.length ? "recent" : "", truncated: newest.length > limit };
}

async function downloadImage(image, { fetchImpl, byteLimit, signal, onBytes }) {
  const url = discordImageUrl(image.url);
  if (!url) throw new Error("image is not available through Discord's image service");
  if (image.size > byteLimit) throw new Error("image exceeds size limit");
  const response = await fetchImpl(url, { redirect: "error", signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("image could not be downloaded");
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type) || !response.body) {
    await response.body?.cancel();
    throw new Error("unsupported image format");
  }
  if (Number(response.headers.get("content-length")) > byteLimit) {
    await response.body.cancel();
    throw new Error("image exceeds size limit");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(value.byteLength);
      if (bytes > byteLimit) throw new Error("image exceeds size limit");
      chunks.push(value);
    }
    if (!bytes) throw new Error("empty image");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return `data:${type};base64,${Buffer.concat(chunks, bytes).toString("base64")}`;
}

export async function prepareConversationImages(context, {
  fetchImpl = fetch,
  maxImages = MAX_IMAGES,
  maxImageBytes = MAX_IMAGE_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  const { candidates, source, truncated } = selectConversationImages(context, { maxImages });
  const images = [];
  const omitted = [];
  if (!candidates.length) return { images, omitted, source, truncated };
  let downloadedBytes = 0;
  const totalTimeout = AbortSignal.timeout(15_000);
  for (const candidate of candidates) {
    const { url, size, ...metadata } = candidate;
    try {
      if (totalTimeout.aborted) throw new Error("image download timed out");
      const byteLimit = Math.min(maxImageBytes, maxTotalBytes - downloadedBytes);
      if (byteLimit <= 0) throw new Error("image exceeds size limit");
      const dataUrl = await downloadImage(candidate, {
        fetchImpl, byteLimit,
        signal: AbortSignal.any([totalTimeout, AbortSignal.timeout(8_000)]),
        onBytes: (bytes) => { downloadedBytes += bytes; },
      });
      images.push({ ...metadata, dataUrl });
    } catch (error) {
      // Never return fetch errors: they can contain signed URLs or credentials.
      const safeReasons = ["image exceeds size limit", "unsupported image format", "empty image", "image download timed out", "image is not available through Discord's image service"];
      omitted.push({ ...metadata, reason: safeReasons.includes(error.message) ? error.message : "image could not be downloaded; ask the user to upload it again" });
    }
  }
  return { images, omitted, source, truncated };
}
