import assert from "node:assert/strict";
import test from "node:test";
import { Embed } from "discord.js";
import { messageMedia, selectConversationMedia, prepareConversationMedia } from "../src/media.js";

function message(id, content = "", images = [], extra = {}) {
  return {
    id, content, createdTimestamp: Number(id) * 1000,
    author: { id: "user", username: "Maya" },
    attachments: new Map(images.map((name, index) => [String(index), {
      name, contentType: "image/png", size: 20,
      url: `https://cdn.discordapp.com/attachments/channel/${id}/${name}`,
    }])),
    ...extra,
  };
}

test("prefers request images, then the nearest image in an explicit reply chain", () => {
  const old = message("1", "old", ["old.png"]);
  const parent = message("500", "parent", ["parent.png"], { reference: { messageId: "1" } });
  const request = message("501", "<@999> thoughts?", ["new.png"], { reference: { messageId: "500" } });
  assert.deepEqual(selectConversationMedia([old, parent, request]).candidates.map((image) => image.name), ["new.png"]);
  request.attachments.clear();
  assert.equal(selectConversationMedia([old, parent, request]).source, "reply");
  assert.equal(selectConversationMedia([old, parent, request]).candidates[0].name, "parent.png");
  parent.attachments.clear();
  assert.equal(selectConversationMedia([old, parent, request]).candidates[0].name, "old.png");
});

test("considers recent images only for contextual questions and bounds their age", () => {
  const old = message("1", "", ["old.png"]);
  const first = message("499", "Rendering bug", ["first.png"]);
  const second = message("500", "Another angle", ["second.png"]);
  const request = message("501", "<@999> why does this look broken?");
  const result = selectConversationMedia([old, first, second, request]);
  assert.equal(result.source, "recent");
  assert.deepEqual(result.candidates.map((image) => image.name), ["first.png", "second.png"]);
  assert.equal(result.candidates[0].messageId, "499");
  assert.equal(result.candidates[0].author, "Maya");
  request.content = "<@999> what is the capital of France?";
  assert.equal(selectConversationMedia([first, second, request]).candidates.length, 0);
  request.content = "<@999> explain that screenshot";
  assert.equal(selectConversationMedia([old, request]).candidates.length, 0);
});

test("collects image embeds through Discord proxies, deduplicates, and ignores link thumbnails", () => {
  const request = message("1", "", ["file.png"]);
  request.embeds = [
    { type: "image", image: { url: "https://example.com/photo.png", proxyURL: "https://images-ext-1.discordapp.net/external/hash/photo.png" } },
    { type: "image", image: { url: request.attachments.get("0").url } },
    { type: "link", thumbnail: { url: "https://example.com/logo.png" } },
  ];
  assert.equal(messageMedia(request).length, 2);
  assert.match(messageMedia(request)[1].url, /images-ext-1/);
});

test("accepts full images in rich bot embeds while excluding unrelated thumbnails", () => {
  const request = message("1", "");
  request.embeds = [
    { type: "rich", image: { url: "https://cdn.discordapp.com/attachments/channel/1/chart.png" } },
    { type: "rich", thumbnail: { url: "https://cdn.discordapp.com/attachments/channel/1/logo.png" } },
    { type: "video", thumbnail: { url: "https://cdn.discordapp.com/attachments/channel/1/preview.png" } },
  ];
  assert.equal(messageMedia(request).length, 1);
  assert.match(messageMedia(request)[0].url, /chart.png$/);
});

test("distinguishes bare contextual opinions from questions about a separate text topic", () => {
  const recent = message("1", "", ["photo.png"]);
  const request = message("2", "<@999> what do you think about switching our database to Postgres?");
  assert.equal(selectConversationMedia([recent, request]).candidates.length, 0);
  request.content = "<@999> thoughts on upgrading Node?";
  assert.equal(selectConversationMedia([recent, request]).candidates.length, 0);
  request.content = "<@999> any thoughts?";
  assert.equal(selectConversationMedia([recent, request]).candidates.length, 1);
  request.content = "<@999> what do you think?";
  assert.equal(selectConversationMedia([recent, request]).candidates.length, 1);
});

test("limits candidate counts and prioritizes the newest image messages", () => {
  const context = [message("1", "", ["1.png", "2.png"]), message("2", "", ["3.png", "4.png", "5.png"]), message("3", "compare these images")];
  const selected = selectConversationMedia(context, { maxItems: 4 });
  assert.equal(selected.candidates.length, 4);
  assert.equal(selected.truncated, true);
  assert.ok(selected.candidates.some((image) => image.name === "5.png"));
});

test("downloads image bytes as data URLs without following redirects", async () => {
  const calls = [];
  const result = await prepareConversationMedia([message("1", "what is this?", ["file.png"])], {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(Buffer.from("image bytes"), { headers: { "content-type": "image/png" } });
    },
  });
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("rejects unsafe URLs, oversize attachments, and unsupported responses without breaking context", async () => {
  let fetches = 0;
  const request = message("1", "inspect", ["unsafe.png", "large.png", "bad.png"]);
  request.attachments.get("0").url = "https://127.0.0.1/private.png";
  request.attachments.get("1").size = 999;
  const result = await prepareConversationMedia([request], {
    maxItemBytes: 100,
    fetchImpl: async () => { fetches += 1; return new Response("html", { headers: { "content-type": "text/html" } }); },
  });
  assert.equal(fetches, 1);
  assert.equal(result.items.length, 0);
  assert.equal(result.omitted.length, 3);
});

test("enforces streamed and total byte limits even without content-length", async () => {
  let fetches = 0;
  const result = await prepareConversationMedia([message("1", "inspect", ["1.png", "2.png", "3.png"])], {
    maxItemBytes: 30, maxTotalBytes: 35,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.close();
      } }), { headers: { "content-type": "image/png" } });
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.omitted.length, 2);
  assert.equal(fetches, 1, "known sizes exceeding the remaining total should not be fetched");
  const unknownSize = message("1", "inspect", ["1.png"]);
  unknownSize.attachments.get("0").size = 0;
  let cancelled = false;
  const overflow = await prepareConversationMedia([unknownSize], {
    maxItemBytes: 10,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/png" } }),
  });
  assert.equal(overflow.items.length, 0);
  assert.equal(cancelled, true, "oversize streams must be cancelled immediately");
});

test("rejects deceptive image hosts and HTTP URLs before any network request", async () => {
  for (const url of [
    "http://cdn.discordapp.com/image.png",
    "https://cdn.discordapp.com.attacker.test/image.png",
    "https://user:password@cdn.discordapp.com/image.png",
    "https://cdn.discordapp.com:8443/image.png",
  ]) {
    const request = message("1", "inspect", ["1.png"]);
    request.attachments.get("0").url = url;
    const result = await prepareConversationMedia([request], { fetchImpl: () => { throw new Error("must not fetch"); } });
    assert.equal(result.items.length, 0);
    assert.match(result.omitted[0].reason, /Discord's media service/);
  }
});

test("handles expired attachments and timeouts as omitted images", async () => {
  const result = await prepareConversationMedia([message("1", "inspect", ["1.png"])], {
    fetchImpl: async () => { throw new Error("expired signed URL containing secret"); },
  });
  assert.equal(result.omitted.length, 1);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("recognizes real Discord.js GIF previews whose type lives in embed.data", () => {
  const request = message("1", "");
  request.embeds = [new Embed({ type: "gifv", thumbnail: {
    url: "https://example.com/gif.png", proxy_url: "https://images-ext-1.discordapp.net/external/hash/gif.png",
  } })];
  assert.equal(messageMedia(request).length, 1);
  assert.match(messageMedia(request)[0].url, /images-ext-1/);
});

test("selects MP4 attachments in reply chains and recent video references", () => {
  const video = message("1", "Throne", ["throne.mp4"]);
  video.attachments.get("0").contentType = "video/mp4";
  const request = message("2", "<@999> what happens in that clip?");
  assert.equal(selectConversationMedia([video, request]).candidates[0]?.kind, "video");
  request.reference = { messageId: "1" };
  request.content = "<@999> explain";
  assert.equal(selectConversationMedia([video, request]).source, "reply");
});

function videoFixture(seconds = 2) {
  function box(type, data) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length + 8);
    header.write(type, 4);
    return Buffer.concat([header, data]);
  }
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom0000isom")), box("moov", box("mvhd", mvhd))]);
}

test("downloads MP4 clips as video data with verified durations", async () => {
  const request = message("1", "inspect", ["throne.mp4"]);
  request.attachments.get("0").contentType = "video/mp4";
  const result = await prepareConversationMedia([request], {
    fetchImpl: async () => new Response(videoFixture(), { headers: { "content-type": "video/mp4" } }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "video");
  assert.equal(result.items[0].durationSeconds, 2);
  assert.match(result.items[0].dataUrl, /^data:video\/mp4;base64,/);
});

test("omits corrupt videos or videos exceeding the two-minute limit", async () => {
  const request = message("1", "inspect", ["throne.mp4"]);
  request.attachments.get("0").contentType = "video/mp4";
  for (const bytes of [videoFixture(121), Buffer.from("corrupt")]) {
    const result = await prepareConversationMedia([request], {
      fetchImpl: async () => new Response(bytes, { headers: { "content-type": "video/mp4" } }),
    });
    assert.equal(result.items.length, 0);
    assert.match(result.omitted[0].reason, /duration limit|MP4/);
    assert.equal(result.omitted[0].kind, "video");
  }
});

test("selects iPhone MOV replies and normalizes QuickTime MIME for the provider", async () => {
  const post = message("1", "", ["iphone.mov"]);
  post.attachments.get("0").contentType = "video/quicktime";
  const request = message("500", "what is in this video", [], { reference: { messageId: "1" } });
  const result = await prepareConversationMedia([post, request], {
    fetchImpl: async () => new Response(videoFixture(), { headers: { "content-type": "video/quicktime" } }),
  });
  assert.equal(result.source, "reply");
  assert.equal(result.items[0]?.kind, "video");
  assert.match(result.items[0]?.dataUrl || "", /^data:video\/mov;base64,/);
});

test("records unsupported video formats with a useful reason without downloading them", async () => {
  const request = message("1", "what is in this video", ["capture.webm"]);
  request.attachments.get("0").contentType = "video/webm";
  const result = await prepareConversationMedia([request], {
    fetchImpl: () => { throw new Error("must not fetch unsupported formats"); },
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.omitted[0]?.name, "capture.webm");
  assert.match(result.omitted[0]?.reason || "", /unsupported video format.*MP4 or MOV/);
});
