import { describe, test, expect } from "vitest";
import { Signal } from "../src/index.js";

describe("State signal basic functionality", () => {
  test("should create a state signal with initial value", () => {
    const signal = new Signal.State(42);
    expect(signal.get()).toBe(42);
  });

  test("should update state signal value", () => {
    const signal = new Signal.State(42);
    signal.set(43);
    expect(signal.get()).toBe(43);
  });
});
