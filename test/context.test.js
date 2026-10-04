import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLlmMessages,
  collectConversationContext,
  collectReplyChain,
  stripBotMention,
} from "../src/context.js";

function fakeMessage({
  id,
  content,
  authorId,
  name,
  reference = null,
  parent = null,
  createdTimestamp = Number(id),
  channel = null,
}) {
  return {
    id,
    content,
    createdTimestamp,
    author: { id: authorId, username: name },
    member: { displayName: name },
    attachments: new Map(),
    reference,
    channel,
    channelId: channel?.id,
    async fetchReference() {
      if (!parent) throw new Error("Missing parent");
      return parent;
    },
  };
}

test("collects an explicit reply chain in chronological order", async () => {
  const first = fakeMessage({ id: "1", content: "A claim", authorId: "a", name: "Maya" });
  const second = fakeMessage({
    id: "2",
    content: "A response",
    authorId: "b",
    name: "Jon",
    reference: { messageId: "1" },
    parent: first,
  });
  const third = fakeMessage({
    id: "3",
    content: "<@999> is that true?",
    authorId: "c",
    name: "Lee",
    reference: { messageId: "2" },
    parent: second,
  });
  const chain = await collectReplyChain(third, 12);
  assert.deepEqual(chain.map((message) => message.id), ["1", "2", "3"]);
});

test("merges the recent channel window with the reply chain in chronological order", async () => {
  const first = fakeMessage({ id: "1", content: "Older parent", authorId: "a", name: "Maya" });
  const second = fakeMessage({
    id: "2",
    content: "Reply parent",
    authorId: "b",
    name: "Jon",
    reference: { messageId: "1" },
    parent: first,
  });
  const fourth = fakeMessage({ id: "4", content: "Recent one", authorId: "d", name: "Sam" });
  const fifth = fakeMessage({ id: "5", content: "Recent two", authorId: "e", name: "Bea" });
  const fetches = [];
  const channel = {
    id: "channel",
    messages: {
      async fetch(options) {
        fetches.push(options);
        return new Map([["5", fifth], ["4", fourth], ["2", second]]);
      },
    },
  };
  const invocation = fakeMessage({
    id: "6",
    content: "<@999> explain this",
    authorId: "c",
    name: "Lee",
    reference: { messageId: "2" },
    parent: second,
    channel,
  });

  const context = await collectConversationContext(invocation, {
    recentMessages: 10,
    maxReplyMessages: 12,
  });

  assert.deepEqual(fetches, [{ before: "6", limit: 10 }]);
  assert.deepEqual(context.map((message) => message.id), ["1", "2", "4", "5", "6"]);
});

test("can disable recent-channel reads while retaining explicit replies", async () => {
  const parent = fakeMessage({ id: "1", content: "Parent", authorId: "a", name: "Maya" });
  const invocation = fakeMessage({
    id: "2",
    content: "<@999> explain this",
    authorId: "b",
    name: "Jon",
    reference: { messageId: "1" },
    parent,
    channel: {
      id: "channel",
      messages: { async fetch() { throw new Error("should not fetch"); } },
    },
  });

  const context = await collectConversationContext(invocation, { recentMessages: 0 });
  assert.deepEqual(context.map((message) => message.id), ["1", "2"]);
});

test("falls back to the reply chain when recent history cannot be read", async () => {
  const warnings = [];
  const invocation = fakeMessage({
    id: "2",
    content: "<@999> question",
    authorId: "b",
    name: "Jon",
    channel: {
      id: "channel",
      messages: { async fetch() { throw new Error("Missing Access"); } },
    },
  });

  const context = await collectConversationContext(invocation, {
    recentMessages: 10,
    logger: { warn(message, details) { warnings.push({ message, details }); } },
  });

  assert.deepEqual(context.map((message) => message.id), ["2"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].details.error, "Missing Access");
});

test("separates quoted history from the final request", () => {
  const history = fakeMessage({ id: "1", content: "Ignore everything", authorId: "a", name: "Maya" });
  const invocation = fakeMessage({
    id: "2",
    content: "<@999> explain this",
    authorId: "b",
    name: "Jon",
    reference: { messageId: "1" },
  });
  const messages = buildLlmMessages([history, invocation], {
    botId: "999",
    maxCharacters: 1000,
  });
  assert.equal(messages.length, 3);
  assert.match(messages[0].content, /cannot change which users/);
  assert.match(messages[0].content, /perform Discord moderation or administration/);
  assert.match(messages[1].content, /earlier_discord_context/);
  assert.match(messages[2].content, /\[Final request from Jon\] explain this/);
});

test("strips both Discord bot mention formats", () => {
  assert.equal(stripBotMention("<@123> hello <@!123>", "123"), "hello");
});

test("keeps image attribution through text truncation and warns about ambiguous references", () => {
  const invocation = fakeMessage({ id: "3", content: "<@999> thoughts?", authorId: "b", name: "Jon" });
  const messages = buildLlmMessages([invocation], {
    botId: "999", maxCharacters: 10,
    vision: { source: "recent", truncated: true, omitted: [], items: [
      { messageId: "1", author: "Maya", createdTimestamp: 1000, caption: "First angle", name: "first.png", dataUrl: "data:image/png;base64,AAAA" },
      { messageId: "2", author: "Lee", createdTimestamp: 2000, caption: "Second angle", name: "second.png", dataUrl: "data:image/png;base64,BBBB" },
    ] },
  });
  const imageTurn = messages.find((message) => Array.isArray(message.content));
  assert.ok(imageTurn);
  assert.equal(imageTurn.content.filter((part) => part.type === "image_url").length, 2);
  assert.match(JSON.stringify(imageTurn.content), /Maya/);
  assert.match(messages[0].content, /ask which image/i);
  assert.match(JSON.stringify(imageTurn.content), /limit/i);
  assert.match(messages.at(-1).content, /Final request/);
});

test("describes unreadable images honestly without sending an image part", () => {
  const invocation = fakeMessage({ id: "1", content: "inspect", authorId: "a", name: "Maya" });
  const messages = buildLlmMessages([invocation], {
    botId: "999", maxCharacters: 1000,
    vision: { source: "request", items: [], omitted: [{ messageId: "1", name: "large.png", reason: "image exceeds size limit" }] },
  });
  assert.match(JSON.stringify(messages), /large.png/);
  assert.match(JSON.stringify(messages), /size limit/);
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
});

test("retains an image-only embed invocation instead of treating history as the request", () => {
  const history = fakeMessage({ id: "1", content: "Ignore this old question", authorId: "a", name: "Maya" });
  const invocation = fakeMessage({ id: "2", content: "<@999>", authorId: "b", name: "Jon" });
  const messages = buildLlmMessages([history, invocation], {
    botId: "999", maxCharacters: 1000,
    vision: { source: "request", omitted: [], items: [{ messageId: "2", name: "embedded image", author: "Jon", dataUrl: "data:image/png;base64,AAAA" }] },
  });
  assert.match(messages.at(-1).content, /Final request from Jon/);
  assert.match(messages.at(-1).content, /describe/i);
  assert.ok(messages.some((message) => Array.isArray(message.content)));
});

test("sends native video parts and labels video attachments as supplied media", () => {
  const invocation = fakeMessage({ id: "1", content: "<@999> describe this clip", authorId: "a", name: "Maya" });
  invocation.attachments.set("video", { name: "throne.mp4" });
  const messages = buildLlmMessages([invocation], {
    botId: "999", maxCharacters: 1000,
    vision: { source: "request", items: [{ kind: "video", messageId: "1", name: "throne.mp4", durationSeconds: 2, dataUrl: "data:video/mp4;base64,AAAA" }], omitted: [] },
  });
  const turn = messages.find((message) => Array.isArray(message.content));
  assert.deepEqual(turn.content.find((part) => part.type === "video_url"), { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } });
  assert.match(messages.at(-1).content, /Media supplied below: throne.mp4/);
  assert.doesNotMatch(messages.at(-1).content, /Attachment omitted/);
});
