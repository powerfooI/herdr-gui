import { describe, expect, test } from "bun:test";
import { connectionHttpPath } from "./connectionHttp";

describe("connection-scoped HTTP paths", () => {
  test("encodes one valid nontrivial connection path segment", () => {
    expect(connectionHttpPath("alpha:remote-1", "/upload-image")).toBe(
      "/api/connections/alpha%3Aremote-1/upload-image",
    );
    expect(connectionHttpPath("beta", "upload-image")).toBe(
      "/api/connections/beta/upload-image",
    );
  });

  test("builds exact file, session, and server-info endpoints", () => {
    expect(connectionHttpPath("beta", "/file/upload")).toBe(
      "/api/connections/beta/file/upload",
    );
    expect(connectionHttpPath("beta", "/file/delete")).toBe(
      "/api/connections/beta/file/delete",
    );
    expect(connectionHttpPath("beta", "/file/download")).toBe(
      "/api/connections/beta/file/download",
    );
    expect(connectionHttpPath("beta", "/agent-session/download")).toBe(
      "/api/connections/beta/agent-session/download",
    );
    expect(connectionHttpPath("beta", "/agent-session/atif")).toBe(
      "/api/connections/beta/agent-session/atif",
    );
    expect(connectionHttpPath("beta", "/herdr-info")).toBe(
      "/api/connections/beta/herdr-info",
    );
  });

  test("binds resource URLs to the expected runtime generation", () => {
    expect(connectionHttpPath("beta", "/file/download", 17)).toBe(
      "/api/connections/beta/file/download?connection_generation=17",
    );
    expect(() => connectionHttpPath("beta", "/file/download", -1)).toThrow(
      "invalid connection_generation",
    );
  });

  test("rejects a missing connection identity", () => {
    expect(() => connectionHttpPath("", "/upload-image")).toThrow(
      "invalid connection_id",
    );
  });
});
