import { describe, expect, test } from "bun:test";
import { reloadApplicationPage } from "./ConfigMenu";

describe("application menu actions", () => {
  test("reloads the current page", () => {
    let reloadCount = 0;

    reloadApplicationPage({
      reload() {
        reloadCount += 1;
      },
    });

    expect(reloadCount).toBe(1);
  });
});
