import { describe, expect, test } from "bun:test";
import {
  decideSelfChat,
  isSelfChat,
  normalizeForEcho,
  SelfChatDeduper,
} from "./selfchat.js";
import {
  CURSY_MARKER,
  CURSY_PREFIX,
  hasOwnMarker,
  stripMarker,
  type IncomingMessage,
} from "./imessage.js";

const SELF = "46700821951";
const WHITELIST = [SELF];

let rowid = 1;
function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  rowid += 1;
  return {
    rowid,
    guid: `guid-${rowid}`,
    text: "hello",
    handle: `+${SELF}`,
    service: "iMessage",
    chatGuid: `iMessage;-;+${SELF}`,
    isFromMe: false,
    isGroup: false,
    ...over,
  };
}

describe("isSelfChat", () => {
  test("true for a 1:1 chat with the whitelisted self handle", () => {
    expect(isSelfChat(msg(), WHITELIST)).toBe(true);
  });

  test("false when the chat peer differs from the sender", () => {
    const m = msg({ chatGuid: "iMessage;-;+15559999999" });
    expect(isSelfChat(m, WHITELIST)).toBe(false);
  });

  test("false for non-whitelisted handle", () => {
    const m = msg({ handle: "+15550000000", chatGuid: "iMessage;-;+15550000000" });
    expect(isSelfChat(m, WHITELIST)).toBe(false);
  });
});

describe("decideSelfChat", () => {
  test("REGRESSION (#47830): genuine self-chat user message is processed, not dropped", () => {
    const d = new SelfChatDeduper();
    // In self-chat the user's own typed message arrives as is_from_me=1.
    const m = msg({ isFromMe: true, text: "build me a feature" });
    expect(decideSelfChat(m, WHITELIST, d, "build me a feature").action).toBe(
      "process",
    );
  });

  test("a normal inbound from a whitelisted sender is processed", () => {
    const d = new SelfChatDeduper();
    const m = msg({ isFromMe: false });
    expect(decideSelfChat(m, WHITELIST, d, "hello").action).toBe("process");
  });

  test("our own reply (carrying the invisible marker) is skipped", () => {
    const d = new SelfChatDeduper();
    const text = "here is your answer" + CURSY_MARKER;
    const m = msg({ isFromMe: false, text });
    const decision = decideSelfChat(m, WHITELIST, d, text);
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("own marker");
  });

  test("marker-stripped outbound echo is still caught by content match", () => {
    const d = new SelfChatDeduper();
    d.recordOutbound(`+${SELF}`, "the answer is 42");
    // Echo comes back without the marker (Messages stripped it).
    const m = msg({ isFromMe: false, text: "the answer is 42" });
    const decision = decideSelfChat(m, WHITELIST, d, "the answer is 42");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("outbound echo");
  });

  test("our own reply via the visible robot prefix (no invisible marker) is skipped", () => {
    const d = new SelfChatDeduper();
    // SMS/RCS strips the invisible marker, but the robot prefix survives.
    const text = `${CURSY_PREFIX}here is your answer`;
    const m = msg({ isFromMe: false, text });
    const decision = decideSelfChat(m, WHITELIST, d, text);
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("own marker");
  });

  test("echo match survives whitespace/normalization differences", () => {
    const d = new SelfChatDeduper();
    d.recordOutbound(`+${SELF}`, "the   answer\nis 42");
    const echo = "the answer is 42"; // collapsed whitespace on the way back
    const m = msg({ isFromMe: false, text: echo });
    const decision = decideSelfChat(m, WHITELIST, d, echo);
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("outbound echo");
  });

  test("an SMS-split segment of a long reply is caught as an echo", () => {
    const d = new SelfChatDeduper();
    const long =
      "Here is the detailed explanation you asked for about the parser changes and the new tests";
    d.recordOutbound(`+${SELF}`, long);
    const segment = long.slice(0, 70); // a marker-less leading SMS segment
    const m = msg({ isFromMe: false, text: segment });
    const decision = decideSelfChat(m, WHITELIST, d, segment);
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("outbound echo");
  });

  test("a tiny human reply is not mistaken for an echo segment", () => {
    const d = new SelfChatDeduper();
    d.recordOutbound(`+${SELF}`, "Here is the detailed explanation about the parser");
    const m = msg({ isFromMe: false, text: "yes" }); // below the segment floor
    const decision = decideSelfChat(m, WHITELIST, d, "yes");
    expect(decision.action).toBe("process");
  });

  test("duplicate GUID is skipped", () => {
    const d = new SelfChatDeduper();
    const m = msg();
    d.markSeen(m.guid);
    const decision = decideSelfChat(m, WHITELIST, d, "hello");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("duplicate guid");
  });

  test("is_from_me twin pair is processed once, the twin skipped", () => {
    const d = new SelfChatDeduper();
    // First the is_from_me=1 row is processed and recorded.
    d.recordTwin(`+${SELF}`, "ping", true);
    // Then the reflected is_from_me=0 twin with identical text is dropped.
    const twin = msg({ isFromMe: false, text: "ping" });
    const decision = decideSelfChat(twin, WHITELIST, d, "ping");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("self-chat twin");
  });

  test("empty is_from_me send receipt is skipped", () => {
    const d = new SelfChatDeduper();
    const m = msg({ isFromMe: true, text: "" });
    const decision = decideSelfChat(m, WHITELIST, d, "");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip")
      expect(decision.reason).toBe("empty sent receipt");
  });

  test("our own send in a NON-self chat is ignored", () => {
    const d = new SelfChatDeduper();
    const m = msg({
      isFromMe: true,
      handle: "+15559999999",
      chatGuid: "iMessage;-;+15559999999",
      text: "internal",
    });
    const decision = decideSelfChat(m, WHITELIST, d, "internal");
    expect(decision.action).toBe("skip");
    if (decision.action === "skip") expect(decision.reason).toBe("is_from_me");
  });
});

describe("SelfChatDeduper bounds", () => {
  test("processedGuids is pruned and stays bounded", () => {
    const d = new SelfChatDeduper();
    for (let i = 0; i < 600; i++) d.markSeen(`g-${i}`);
    // Most recent should still be remembered; very old ones pruned.
    expect(d.hasSeen("g-599")).toBe(true);
  });
});

describe("markers", () => {
  test("hasOwnMarker detects the invisible marker anywhere", () => {
    expect(hasOwnMarker(`done${CURSY_MARKER}`)).toBe(true);
  });

  test("hasOwnMarker detects the robot only at the start", () => {
    expect(hasOwnMarker(`${CURSY_PREFIX}hello`)).toBe(true);
    // A robot in the middle is the user's content, not our marker.
    expect(hasOwnMarker("look at this 🤖 bot")).toBe(false);
  });

  test("stripMarker removes both the robot prefix and invisible marker", () => {
    expect(stripMarker(`${CURSY_PREFIX}hello${CURSY_MARKER}`)).toBe("hello");
  });

  test("normalizeForEcho strips markers and collapses whitespace", () => {
    expect(normalizeForEcho(`${CURSY_PREFIX}the   answer\nis 42${CURSY_MARKER}`)).toBe(
      "the answer is 42",
    );
  });
});
