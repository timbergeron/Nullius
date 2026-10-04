import { movieDurationSeconds } from "./video.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Map([
  ["video/mp4", "video/mp4"],
  ["video/mov", "video/mov"],
  ["video/quicktime", "video/mov"],
]);
const UNSUPPORTED_VIDEO = "unsupported video format; send an MP4 or MOV clip, or a still image";
const MAX_VIDEO_SECONDS = 120;
const MAX_MEDIA = 4;
const MAX_ITEM_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const RECENT_MEDIA_AGE_MS = 5 * 60 * 1000;

function discordMediaUrl(value) {
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

export function messageMedia(message) {
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
    const unknownType = !type || type === "application/octet-stream";
    const videoExtension = attachment.name?.match(/\.(mp4|mov|webm|avi|mkv|m4v|mpeg|mpg|wmv)$/i)?.[1]?.toLowerCase();
    const isVideo = type?.startsWith("video/") || unknownType && Boolean(videoExtension);
    const isImage = IMAGE_TYPES.has(type) || unknownType && /\.(png|jpe?g|webp|gif)$/i.test(attachment.name || "");
    if (!isImage && !isVideo) continue;
    const videoMime = VIDEO_TYPES.get(type) || (unknownType && videoExtension ? `video/${videoExtension}` : type);
    add({ url: attachment.url, name: (attachment.name || "media").slice(0, 200), size: Number(attachment.size) || 0, kind: isVideo ? "video" : "image", ...(isVideo && { mimeType: videoMime }) }, [attachment.proxyURL]);
  }
  for (const embed of message.embeds || []) {
    // Site logos and video thumbnails are unrelated to image questions.
    const type = embed.data?.type || embed.type;
    const image = embed.image || (["image", "gifv"].includes(type) ? embed.thumbnail : null);
    if (!image) continue;
    add({ url: image.proxyURL || image.url, name: "embedded image", size: 0, kind: "image" }, [image.url]);
  }
  return images;
}

function refersToRecentMedia(content) {
  const question = content.replace(/<@!?\d+>/g, "").trim();
  return /\b(images?|pictures?|photos?|screenshots?|drawings?|diagrams?|memes?|renders?|videos?|clips?|animations?|these|those|above)\b/i.test(question)
    || /\b(this|that|it)\b/i.test(question) && /\b(what|why|how|explain|describe|look|looks|see|think|wrong|broken|read|identify|thoughts)\b/i.test(question)
    || /^(?:(?:any|your)\s+)?thoughts[?!.]*$/i.test(question)
    || /^what do you think[?!.]*$/i.test(question);
}

export function selectConversationMedia(context, { maxItems = MAX_MEDIA } = {}) {
  const limit = Math.min(MAX_MEDIA, Math.max(1, Math.floor(maxItems) || MAX_MEDIA));
  const invocation = context.at(-1);
  const empty = { candidates: [], source: "", truncated: false };
  if (!invocation) return empty;
  function selection(images, source) {
    return { candidates: images.slice(0, limit), source, truncated: images.length > limit };
  }
  const own = messageMedia(invocation);
  if (own.length) return selection(own, "request");

  const byId = new Map(context.map((message) => [message.id, message]));
  const visited = new Set([invocation.id]);
  let parentId = invocation.reference?.messageId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const images = messageMedia(parent);
    if (images.length) return selection(images, "reply");
    parentId = parent.reference?.messageId;
  }

  if (!refersToRecentMedia(invocation.content || "")) return empty;
  const recent = context.slice(0, -1).filter((message) => {
    const age = Number(invocation.createdTimestamp) - Number(message.createdTimestamp);
    return Number.isFinite(age) && age >= 0 && age <= RECENT_MEDIA_AGE_MS;
  });
  // Keep newest candidates within the cap, then restore chronological ordering.
  const groups = recent.reverse().map(messageMedia).filter((images) => images.length);
  const newest = groups.flat();
  const kept = newest.slice(0, limit);
  const order = new Map(context.map((message, index) => [message.id, index]));
  kept.sort((left, right) => order.get(left.messageId) - order.get(right.messageId));
  return { candidates: kept, source: kept.length ? "recent" : "", truncated: newest.length > limit };
}

async function downloadMedia(image, { fetchImpl, byteLimit, signal, onBytes }) {
  if (image.kind === "video" && !VIDEO_TYPES.has(image.mimeType)) throw new Error(UNSUPPORTED_VIDEO);
  const url = discordMediaUrl(image.url);
  if (!url) throw new Error("media is not available through Discord's media service");
  if (image.size > byteLimit) throw new Error("media exceeds size limit");
  const response = await fetchImpl(url, { redirect: "error", signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("media could not be downloaded");
  }
  let type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (image.kind === "video") type = type === "application/octet-stream" ? image.mimeType : VIDEO_TYPES.get(type);
  if ((image.kind === "video" ? !VIDEO_TYPES.has(type) : !IMAGE_TYPES.has(type)) || !response.body) {
    await response.body?.cancel();
    throw new Error("unsupported media format");
  }
  if (Number(response.headers.get("content-length")) > byteLimit) {
    await response.body.cancel();
    throw new Error("media exceeds size limit");
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
      if (bytes > byteLimit) throw new Error("media exceeds size limit");
      chunks.push(value);
    }
    if (!bytes) throw new Error("empty media");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, bytes);
  let durationSeconds;
  if (image.kind === "video") {
    durationSeconds = movieDurationSeconds(buffer, { quickTime: type === "video/mov" });
    if (durationSeconds > MAX_VIDEO_SECONDS) throw new Error("video exceeds the two-minute duration limit; upload a shorter clip");
  }
  return { dataUrl: `data:${type};base64,${buffer.toString("base64")}`, ...(durationSeconds && { durationSeconds }) };
}

export async function prepareConversationMedia(context, {
  fetchImpl = fetch,
  maxItems = MAX_MEDIA,
  maxItemBytes = MAX_ITEM_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  const { candidates, source, truncated } = selectConversationMedia(context, { maxItems });
  const items = [];
  const omitted = [];
  if (!candidates.length) return { items, omitted, source, truncated };
  let downloadedBytes = 0;
  const totalTimeout = AbortSignal.timeout(15_000);
  for (const candidate of candidates) {
    const { url, size, ...metadata } = candidate;
    try {
      if (totalTimeout.aborted) throw new Error("media download timed out");
      const byteLimit = Math.min(maxItemBytes, maxTotalBytes - downloadedBytes);
      if (byteLimit <= 0) throw new Error("media exceeds size limit");
      const downloaded = await downloadMedia(candidate, {
        fetchImpl, byteLimit,
        signal: AbortSignal.any([totalTimeout, AbortSignal.timeout(8_000)]),
        onBytes: (bytes) => { downloadedBytes += bytes; },
      });
      items.push({ ...metadata, ...downloaded });
    } catch (error) {
      // Never return fetch errors: they can contain signed URLs or credentials.
      const safeReasons = ["media exceeds size limit", "unsupported media format", "empty media", "media download timed out", "media is not available through Discord's media service", "invalid MP4/MOV container", "video duration could not be verified", "video exceeds the two-minute duration limit; upload a shorter clip", UNSUPPORTED_VIDEO];
      omitted.push({ ...metadata, reason: safeReasons.includes(error.message) ? error.message : "media could not be downloaded; ask the user to upload it again" });
    }
  }
  return { items, omitted, source, truncated };
}
