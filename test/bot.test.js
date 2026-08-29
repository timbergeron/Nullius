import assert from "node:assert/strict";
import test from "node:test";
import { splitDiscordMessage } from "../src/bot.js";

test("splits long Discord answers at readable boundaries", () => {
  const text = `${"First paragraph. ".repeat(20)}\n\n${"Second paragraph. ".repeat(20)}`;
  const parts = splitDiscordMessage(text, 180);

  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 180));
  assert.match(parts[0], /First paragraph/);
  assert.match(parts.at(-1), /Second paragraph/);
});

test("closes and reopens fenced code across Discord messages", () => {
  const sourceLines = Array.from(
    { length: 40 },
    (_, index) => `  const value${index} = ${index};`,
  );
  const text = `Here is the implementation:\n\n\`\`\`js\n${sourceLines.join("\n")}\n\`\`\`\n\nDone.`;
  const parts = splitDiscordMessage(text, 220);

  assert.ok(parts.length > 2);
  assert.ok(parts.every((part) => part.length <= 220));
  assert.ok(parts.every((part) => (part.match(/```/g) || []).length % 2 === 0));
  assert.ok(parts.slice(1, -1).some((part) => part.startsWith("```js\n")));
  assert.match(parts.join("\n"), /  const value20 = 20;/);
  assert.match(parts.at(-1), /Done\.$/);
});
