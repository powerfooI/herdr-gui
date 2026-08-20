import { describe, expect, test } from "bun:test";
import {
  isAllowedWebSocketOrigin,
  parseAllowedOrigins,
} from "./websocket-origin";

function request(origin?: string, url = "http://127.0.0.1:8787/ws") {
  return new Request(url, {
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

  test("accepts allowlisted origins when a proxy rewrites the Host header", () => {
    const allowed = parseAllowedOrigins("https://gui.example.com");
    // The proxy forwarded the request with an internal Host.
    const req = request("https://gui.example.com", "http://192.0.2.8:8787/ws");
    expect(isAllowedWebSocketOrigin(req, allowed)).toBeTrue();
    expect(isAllowedWebSocketOrigin(req)).toBeFalse();
    // Unlisted origins stay rejected even with an allowlist configured.
    expect(
      isAllowedWebSocketOrigin(
        request("https://attacker.example", "http://192.0.2.8:8787/ws"),
        allowed,
      ),
    ).toBeFalse();
  });

  test("parseAllowedOrigins normalizes schemes, ports, and bare hosts", () => {
    expect(
      parseAllowedOrigins(
        "https://gui.example.com, gui2.example.com:8443, http://plain.example/path",
      ),
    ).toEqual(
      new Set([
        "https://gui.example.com",
        "https://gui2.example.com:8443",
        "http://gui2.example.com:8443",
        "http://plain.example",
      ]),
    );
    expect(parseAllowedOrigins(undefined)).toEqual(new Set());
    expect(parseAllowedOrigins(" , not a url ")).toEqual(new Set());
  });
});
