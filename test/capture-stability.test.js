import test from "node:test";
import assert from "node:assert/strict";
import { captureStability } from "../src/capture-stability.js";

const frame = { width: 1080, height: 1920 };
const page = (dx = 0, extra = {}) => ({
  corners: [{ x: .2 + dx, y: .15 }, { x: .8 + dx, y: .15 }, { x: .8 + dx, y: .85 }, { x: .2 + dx, y: .85 }],
  confidence: .9, borderSides: 0, ...extra,
});
const feed = (tracker, time, result = page()) => tracker.update(result, time, frame);

test("a slow camera locks after three steady observations over half a second", () => {
  const tracker = captureStability();
  assert.equal(feed(tracker, 0).state, "settling");
  assert.equal(feed(tracker, 250).state, "settling");
  assert.equal(feed(tracker, 500).state, "ready");
});

test("one missed detection or confidence dip does not discard a steady hand", () => {
  for (const interruption of [{ corners: null, confidence: 0 }, page(0, { confidence: .5 })]) {
    const tracker = captureStability();
    feed(tracker, 0); feed(tracker, 100);
    assert.notEqual(feed(tracker, 200, interruption).state, "ready");
    feed(tracker, 300); feed(tracker, 400);
    assert.equal(feed(tracker, 500).state, "ready");
  }
});

test("small corner jitter is measured in pixels across the portrait frame", () => {
  const tracker = captureStability();
  const states = [0, 100, 200, 300, 400, 500].map((time, i) => feed(tracker, time, page(i % 2 ? .01 : -.01)));
  assert.equal(states.at(-1).state, "ready");
});

test("a moving page and slow continuous drift never trigger capture", () => {
  for (const motion of [i => i % 2 ? .07 : -.07, i => i * .007]) {
    const tracker = captureStability();
    for (let i = 0; i < 20; i++) assert.notEqual(feed(tracker, i * 100, page(motion(i))).state, "ready");
  }
});

test("a page at the border, too small, invalid or absent cannot capture", () => {
  for (const result of [
    page(0, { borderSides: 1 }),
    page(0, { corners: [{ x: .4, y: .4 }, { x: .6, y: .4 }, { x: .6, y: .6 }, { x: .4, y: .6 }] }),
    page(0, { confidence: .5 }),
    page(0, { corners: [{ x: NaN, y: 0 }, ...page().corners.slice(1)] }),
    { corners: null, confidence: 0 },
  ]) {
    const tracker = captureStability();
    feed(tracker, 0); feed(tracker, 250);
    assert.notEqual(feed(tracker, 500, result).state, "ready");
  }
});

test("an interruption or a reset requires fresh evidence before capture", () => {
  const tracker = captureStability();
  feed(tracker, 0); feed(tracker, 250);
  assert.equal(feed(tracker, 1200).state, "settling");
  feed(tracker, 1450); tracker.reset();
  assert.equal(feed(tracker, 1700).state, "settling");
});
