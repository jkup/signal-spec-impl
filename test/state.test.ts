import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Signal } from "../index.js";
import type { TestContext } from "node:test";

test("State signal basic functionality", async (t: TestContext) => {
  await t.test("should create a state signal with initial value", () => {
    const signal = new Signal.State(42);
    assert.equal(signal.get(), 42);
  });

  await t.test("should update state signal value", () => {
    const signal = new Signal.State(42);
    signal.set(43);
    assert.equal(signal.get(), 43);
  });
});
