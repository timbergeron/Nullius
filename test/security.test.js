import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  parseCookies,
  sealSession,
  serializeCookie,
  unsealSession,
} from "../src/security.js";

const secret = "this-is-a-test-secret-with-more-than-32-characters";

test("encrypts and decrypts secrets without exposing plaintext", () => {
  const encrypted = encryptSecret("sk-or-secret", secret);
  assert.equal(decryptSecret(encrypted, secret), "sk-or-secret");
  assert.doesNotMatch(JSON.stringify(encrypted), /sk-or-secret/);
});

test("seals sessions and rejects tampering or expiration", () => {
  const value = { userId: "1", guildId: "2", expiresAt: Date.now() + 10_000 };
  const sealed = sealSession(value, secret);
  assert.deepEqual(unsealSession(sealed, secret), value);
  assert.equal(unsealSession(`${sealed}x`, secret), null);

  const expired = sealSession({ ...value, expiresAt: Date.now() - 1 }, secret);
  assert.equal(unsealSession(expired, secret), null);
});

test("serializes and parses cookies", () => {
  const cookie = serializeCookie("hello", "a value", {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
  });
  assert.match(cookie, /^hello=a%20value;/);
  assert.equal(parseCookies("hello=a%20value; another=yes").hello, "a value");
  assert.deepEqual(parseCookies("broken=%E0%A4%A; valid=yes"), {
    broken: "%E0%A4%A",
    valid: "yes",
  });
});
