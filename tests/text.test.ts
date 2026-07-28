import assert from "node:assert/strict";
import test from "node:test";

import { splitTelegramText, toPlainText } from "../lib/text";

test("toPlainText removes markup and preserves readable structure", () => {
  assert.equal(
    toPlainText(
      "<p><strong>Hello</strong> &amp; welcome</p><ul><li>One</li><li>Two</li></ul>",
    ),
    "Hello & welcome\nOne\nTwo",
  );
});

test("toPlainText safely discards invalid numeric entities", () => {
  assert.equal(toPlainText("before &#x110000; after"), "before  after");
});

test("splitTelegramText honors the character limit without splitting emoji", () => {
  const input = `${"🙂".repeat(12)} ${"word ".repeat(20)}`.trim();
  const chunks = splitTelegramText(input, 24);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 24));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), input);
});

test("splitTelegramText returns short text unchanged", () => {
  assert.deepEqual(splitTelegramText("hello"), ["hello"]);
});
