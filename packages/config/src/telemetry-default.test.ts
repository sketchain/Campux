import { describe, expect, test } from "bun:test";
import { telemetryDisabled } from "./index";

describe("telemetryDisabled", () => {
  test("telemetry is off unless explicitly opted in", () => {
    expect(telemetryDisabled(undefined)).toBe(true);
    expect(telemetryDisabled("")).toBe(true);
    expect(telemetryDisabled("true")).toBe(true);
    expect(telemetryDisabled("1")).toBe(true);
    expect(telemetryDisabled("false")).toBe(false);
    expect(telemetryDisabled(" FALSE ")).toBe(false);
    expect(telemetryDisabled("0")).toBe(false);
  });
});
