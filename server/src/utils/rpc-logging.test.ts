import { describe, expect, test } from "bun:test";
import { isExpectedRpcError, rpcLogLevel } from "./rpc-logging";

describe("RPC log classification", () => {
  test("keeps successful summaries at debug", () => {
    expect(rpcLogLevel({ method: "workspace.list", status: "ok" })).toBe(
      "debug",
    );
  });

  test("classifies expected request-state errors as debug", () => {
    expect(
      isExpectedRpcError(
        "git.diff_summary",
        "workspace is not inside a git repository",
      ),
    ).toBe(true);
    expect(isExpectedRpcError("terminal.resize", "no terminal attached")).toBe(
      true,
    );
    expect(
      isExpectedRpcError("workspace.list", "connection changed during request"),
    ).toBe(true);
    expect(
      isExpectedRpcError(
        "workspace.list",
        "connection runtime generation is unavailable",
      ),
    ).toBe(true);
  });

  test("keeps unexpected request failures visible as warnings", () => {
    expect(
      rpcLogLevel({
        method: "git.diff_summary",
        status: "error",
        detail: "git process timed out",
      }),
    ).toBe("warn");
  });
});
