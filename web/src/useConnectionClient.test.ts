import { describe, expect, test } from "bun:test";
import { connectionClientScopeKey } from "./useConnectionClient";

describe("connection client scope keys", () => {
  test("isolates identical resources by connection and generation", () => {
    const alpha = { connectionId: "alpha", generation: 1 };
    const beta = { connectionId: "beta", generation: 1 };
    expect(connectionClientScopeKey(alpha, "same", "same")).not.toBe(
      connectionClientScopeKey(beta, "same", "same"),
    );
    expect(connectionClientScopeKey(alpha, "same", "same")).not.toBe(
      connectionClientScopeKey(
        { connectionId: "alpha", generation: 2 },
        "same",
        "same",
      ),
    );
  });
});
