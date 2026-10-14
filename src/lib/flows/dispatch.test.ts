import { describe, expect, it } from "vitest";

import { entryTriggerTexts } from "./engine";

describe("entryTriggerTexts", () => {
  it("offers the typed text for a text message", () => {
    expect(
      entryTriggerTexts({
        kind: "text",
        text: "order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["order status"]);
  });

  it("offers both the button title and its reply id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "Order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["Order status", "btn_1"]);
  });

  it("drops blanks and collapses a title identical to the id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "btn_1",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "   ",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
  });
});
