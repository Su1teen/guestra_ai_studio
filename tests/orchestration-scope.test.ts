import { describe, expect, it } from "vitest";
import { orchestrationAllowed } from "../server/config";

describe("orchestration scope", () => {
  const scope = (
    sandbox: boolean,
    environment: "test" | "sandbox" | "production",
    liveOrchestration?: boolean,
  ) => orchestrationAllowed({ sandbox, environment, liveOrchestration });

  it("allows attested isolated environments", () => {
    expect(scope(true, "sandbox")).toBe(true);
    expect(scope(true, "test")).toBe(true);
  });
  it("never treats the sandbox flag alone as permission in production", () => {
    expect(scope(true, "production")).toBe(false);
    expect(scope(false, "production")).toBe(false);
  });
  it("requires the explicit live opt-in, and only in production", () => {
    expect(scope(false, "production", true)).toBe(true);
    expect(scope(false, "sandbox", true)).toBe(false);
    expect(scope(false, "test", true)).toBe(false);
  });
});
