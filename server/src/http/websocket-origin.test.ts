import { describe, expect, test } from "bun:test";
import { isAllowedWebSocketOrigin } from "./websocket-origin";

function request(origin?: string) {
  return new Request("http://127.0.0.1:8787/ws", {
    headers: origin === undefined ? undefined : { origin },
  });
}

describe("WebSocket browser origin boundary", () => {
  test("accepts same-authority browser origins and non-browser clients", () => {
    expect(isAllowedWebSocketOrigin(request())).toBeTrue();
    expect(
      isAllowedWebSocketOrigin(request("http://127.0.0.1:8787")),
    ).toBeTrue();
    expect(
      isAllowedWebSocketOrigin(request("https://127.0.0.1:8787")),
    ).toBeTrue();
  });

  test("rejects cross-origin, opaque, malformed, and port-mismatched browsers", () => {
    for (const origin of [
      "https://attacker.example",
      "http://127.0.0.1:5173",
      "null",
      "not a URL",
      "http://127.0.0.1:8787/path",
    ]) {
      expect(isAllowedWebSocketOrigin(request(origin))).toBeFalse();
    }
  });
});
