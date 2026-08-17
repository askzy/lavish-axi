import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  classifyUnreadableContrast,
  compositeSrgbOver,
  deriveLavishQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
  resolveTextBackdrop,
  srgbContrastRatio,
} from "../src/artifact-sdk.js";

function node(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelectorList(this, selector);
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  if (attrs.id) el.id = attrs.id;
  if (attrs.name) el.name = attrs.name;
  if (attrs.type) el.type = attrs.type;
  if (attrs.value) el.value = attrs.value;
  for (const child of children) append(el, child);
  return el;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function matchesSelectorList(el, selectorList) {
  return selectorList.split(",").some((selector) => matchesSelector(el, selector.trim()));
}

function matchesSelector(el, selector) {
  if (selector === "form" || selector === "fieldset") return el.tagName.toLowerCase() === selector;
  if (selector === "[data-lavish-question]") return el.getAttribute("data-lavish-question") !== null;
  if (selector === "[contenteditable]:not([contenteditable='false'])") {
    const value = el.getAttribute("contenteditable");
    return value !== null && value !== "false";
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

test("isNativeInteractiveControl leaves details body descendants annotatable", () => {
  const summaryChild = node("span");
  const summary = node("summary", {}, [summaryChild]);
  const bodyText = node("span");
  const bodyLink = node("a", { href: "#target" });
  const body = node("div", {}, [bodyText, bodyLink]);
  const details = node("details", { open: "" }, [summary, body]);

  assert.equal(isNativeInteractiveControl(summaryChild), true);
  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(bodyText), false);
  assert.equal(isNativeInteractiveControl(bodyLink), false);
});

test("isNativeInteractiveControl allows details as a text selection ancestor", () => {
  const firstParagraph = node("p");
  const secondParagraph = node("p");
  const details = node("details", { open: "" }, [node("summary", {}, [node("span")]), firstParagraph, secondParagraph]);

  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(firstParagraph), false);
  assert.equal(isNativeInteractiveControl(secondParagraph), false);
});

test("deriveLavishQueueKey uses explicit queueKey first", () => {
  const input = node("input", { type: "radio", name: "plan" });

  assert.equal(deriveLavishQueueKey(input, { queueKey: "deployment-plan" }), "deployment-plan");
});

test("deriveLavishQueueKey allows explicit empty queueKey to suppress derivation", () => {
  const button = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [button]);

  assert.equal(deriveLavishQueueKey(button, { queueKey: "" }), "");
});

test("deriveLavishQueueKey groups controls inside data-lavish-question", () => {
  const first = node("button");
  const second = node("button");
  node("section", { "data-lavish-question": "deployment-plan" }, [first, second]);

  assert.equal(deriveLavishQueueKey(first), "question:deployment-plan");
  assert.equal(deriveLavishQueueKey(second), "question:deployment-plan");
});

test("deriveLavishQueueKey groups radio options by scoped group name", () => {
  const planA = node("input", { id: "plan-a", type: "radio", name: "plan", value: "A" });
  const planB = node("input", { id: "plan-b", type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy" }, [planA, planB]);

  assert.equal(deriveLavishQueueKey(planA), "radio:form:deploy:plan");
  assert.equal(deriveLavishQueueKey(planB), "radio:form:deploy:plan");
});

test("deriveLavishQueueKey keeps same radio names independent across scopes", () => {
  const first = node("input", { type: "radio", name: "plan", value: "A" });
  const second = node("input", { type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy-one" }, [first]);
  node("form", { id: "deploy-two" }, [second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not infer plain button grouping without question metadata", () => {
  const button = node("button");

  assert.equal(deriveLavishQueueKey(button), "");
});

test("deriveLavishQueueKey keys checkbox toggles per checkbox, not per group", () => {
  const first = node("input", { type: "checkbox", name: "feature", value: "search" });
  const second = node("input", { type: "checkbox", name: "feature", value: "billing" });
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey does not collide checkbox default values", () => {
  const first = node("input", { id: "search", type: "checkbox", name: "feature" });
  const second = node("input", { id: "billing", type: "checkbox", name: "feature" });
  first.value = "on";
  second.value = "on";
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLavishQueueKey(first), deriveLavishQueueKey(second));
});

test("deriveLavishQueueKey keys named selects as fields", () => {
  const select = node("select", { name: "region" });
  node("form", { id: "deploy" }, [select]);

  assert.equal(deriveLavishQueueKey(select), "field:form:deploy:region");
});

test("classifySevereTextOverflow ignores font ink that stays within the rendered line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 400, top: 0, bottom: 68, width: 400, height: 68 }],
    box: { left: 0, right: 400, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores tiny text-box excursions", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 300, top: 0, bottom: 70, width: 300, height: 70 }],
    box: { left: 0, right: 300, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores centered display glyph ink outside a visible line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 600, top: -37, bottom: 203, width: 600, height: 240 }],
    box: { left: 0, right: 600, top: 0, bottom: 166 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores a partial vertical line excursion whose center remains visible", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 }],
    box: { left: 0, right: 300, top: 0, bottom: 14 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow reports a complete line clipped below a fixed box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 },
      { left: 0, right: 250, top: 24, bottom: 44, width: 250, height: 20 },
    ],
    box: { left: 0, right: 300, top: 0, bottom: 22 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 22 });
});

test("classifySevereTextOverflow reports a wrapped label spilling beyond its visible box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 4, right: 56, top: 2, bottom: 18, width: 52, height: 16 },
      { left: 4, right: 54, top: 20, bottom: 36, width: 50, height: 16 },
    ],
    box: { left: 0, right: 62, top: 0, bottom: 24 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 12 });
});

test("classifySevereTextOverflow suppresses explicit truncation and visually hidden accessibility text", () => {
  const base = {
    fragments: [{ left: 0, right: 300, top: 0, bottom: 20, width: 300, height: 20 }],
    box: { left: 0, right: 120, top: 0, bottom: 20 },
    overflowX: "hidden",
    overflowY: "hidden",
  };

  assert.equal(classifySevereTextOverflow({ ...base, isTruncated: true }), null);
  assert.equal(classifySevereTextOverflow({ ...base, isVisuallyHidden: true }), null);
});

test("classifyMaterialRectEscape detects both clipped starts and ends", () => {
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: -30, right: 70, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "start", overflowPx: 30 },
  );
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: 350, right: 430, top: 0, bottom: 40, width: 80, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "end", overflowPx: 40 },
  );
});

test("classifyMaterialRectEscape suppresses tiny boundary excursions", () => {
  assert.equal(
    classifyMaterialRectEscape({
      rect: { left: -2, right: 98, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
    }),
    null,
  );
});

test("isMaterialPageOverflow requires a material escape containing meaningful content", () => {
  assert.equal(isMaterialPageOverflow({ overflowPx: 5, viewportWidth: 390, hasEscapedContent: true }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: false }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: true }), true);
});

test("findStableLayoutFindings keeps only severe roots present in both samples", () => {
  const first = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".moving", kind: "clipped-text", axis: "horizontal", severity: "error" },
  ];
  const second = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".late", kind: "clipped-text", axis: "vertical", severity: "error" },
  ];

  assert.deepEqual(findStableLayoutFindings(first, second), [second[0]]);
});

test("isNearTotalOcclusion requires enough samples and at least ninety percent coverage", () => {
  assert.equal(isNearTotalOcclusion({ occludedSamples: 9, totalSamples: 10 }), true);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 8, totalSamples: 10 }), false);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 4, totalSamples: 4 }), false);
});

test("isModeToggleHotkeyEvent matches Cmd/Ctrl+I regardless of case", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "I", ctrlKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, ctrlKey: true }), true);
});

test("isModeToggleHotkeyEvent requires a modifier so plain typing is unaffected", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i" }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", shiftKey: true }), false);
});

test("isModeToggleHotkeyEvent rejects extra shift or alt modifiers", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, altKey: true }), false);
});

test("isModeToggleHotkeyEvent ignores other keys even with a modifier held", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "e", metaKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "Enter", metaKey: true }), false);
});

// DaisyUI `dim`, converted from the theme's own oklch() tokens to sRGB. Real values matter here:
// the whole question for this rule is whether its threshold separates the failures from the
// deliberately-muted choices a themed artifact makes on purpose.
const dim = {
  base100: [24, 28, 36],
  base200: [36, 41, 51],
  base300: [49, 55, 66],
  baseContent: [178, 204, 214],
  warning: [239, 208, 87],
  warningContent: [20, 16, 3],
  primaryContent: [0, 15, 12],
};

function fade(color, alpha) {
  return [...color, Math.round(alpha * 255)];
}

test("srgbContrastRatio matches the WCAG reference values at both extremes", () => {
  assert.equal(Math.round(srgbContrastRatio([255, 255, 255], [0, 0, 0]) * 100) / 100, 21);
  assert.equal(srgbContrastRatio([120, 120, 120], [120, 120, 120]), 1);
  // Order does not matter: the ratio puts the lighter color on top either way.
  assert.equal(srgbContrastRatio(dim.baseContent, dim.base200), srgbContrastRatio(dim.base200, dim.baseContent));
});

test("srgbContrastRatio reports NaN rather than a number for an unusable color", () => {
  assert.ok(Number.isNaN(srgbContrastRatio(null, dim.base200)));
  assert.ok(Number.isNaN(srgbContrastRatio(["x", 0, 0], dim.base200)));
});

test("compositeSrgbOver paints a translucent color onto its backdrop", () => {
  assert.deepEqual(compositeSrgbOver([255, 255, 255, 0], [10, 20, 30]), [10, 20, 30]);
  assert.deepEqual(compositeSrgbOver([255, 255, 255, 255], [10, 20, 30]), [255, 255, 255]);
  assert.deepEqual(compositeSrgbOver([200, 100, 0, 128], [0, 0, 100]), [
    200 * (128 / 255),
    100 * (128 / 255),
    100 * (1 - 128 / 255),
  ]);
});

test("compositeSrgbOver treats a color with no alpha channel as opaque", () => {
  assert.deepEqual(compositeSrgbOver([200, 100, 50], [0, 0, 0]), [200, 100, 50]);
});

test("resolveTextBackdrop returns the first opaque layer of an ancestor walk", () => {
  const backdrop = resolveTextBackdrop([
    { color: [0, 0, 0, 0] },
    { color: fade(dim.base300, 0) },
    { color: [...dim.base200, 255] },
    { color: [...dim.base100, 255] },
  ]);
  assert.deepEqual(backdrop, dim.base200);
});

test("resolveTextBackdrop paints translucent layers back down onto the opaque one", () => {
  // A 50% white scrim inside an opaque black surface resolves to the midpoint, innermost last.
  assert.deepEqual(resolveTextBackdrop([{ color: [255, 255, 255, 128] }, { color: [0, 0, 0, 255] }]), [
    255 * (128 / 255),
    255 * (128 / 255),
    255 * (128 / 255),
  ]);
});

test("resolveTextBackdrop stays silent when the real backdrop cannot be known", () => {
  assert.equal(resolveTextBackdrop([]), null);
  assert.equal(resolveTextBackdrop(null), null);
  // A gradient, image, blend mode or group opacity anywhere in the walk.
  assert.equal(resolveTextBackdrop([{ color: [0, 0, 0, 0] }, { unknown: true }, { color: [1, 2, 3, 255] }]), null);
  // A color the canvas could not parse.
  assert.equal(resolveTextBackdrop([{ color: null }, { color: [1, 2, 3, 255] }]), null);
  // Transparent all the way to the root: what shows through is the viewer's canvas, not the page.
  assert.equal(resolveTextBackdrop([{ color: [0, 0, 0, 0] }, { color: [9, 9, 9, 0] }]), null);
});

test("classifyUnreadableContrast catches a content color inherited onto a base surface", () => {
  // The reported bug: a `bg-base-200` table nested inside an `alert-warning` keeps
  // `warning-content`, which `dim` picked to sit on amber.
  const failure = classifyUnreadableContrast({ textColor: dim.warningContent, backdrop: dim.base200 });
  assert.equal(failure.kind, "unreadable-contrast");
  assert.ok(failure.contrastRatio < 1.5, `expected an unreadable ratio, got ${failure?.contrastRatio}`);
  // Same shape for the other semantic colors.
  assert.ok(classifyUnreadableContrast({ textColor: dim.primaryContent, backdrop: dim.base100 }));
});

test("classifyUnreadableContrast stays silent on the pairings the theme intends", () => {
  assert.equal(classifyUnreadableContrast({ textColor: dim.warningContent, backdrop: dim.warning }), null);
  assert.equal(classifyUnreadableContrast({ textColor: dim.baseContent, backdrop: dim.base200 }), null);
  assert.equal(classifyUnreadableContrast({ textColor: dim.baseContent, backdrop: dim.base100 }), null);
});

test("classifyUnreadableContrast splits faded text at the calibration gap, not at WCAG AA", () => {
  // Measured on `dim`: /40 lands at 2.74 and /50 at 3.53, so a 3:1 bar separates the case the
  // guidance already rules out from the muted-but-deliberate choices that must stay silent. An
  // AA bar (4.5) would have swept /50 and /60 in with them.
  const on100 = (alpha) =>
    classifyUnreadableContrast({ textColor: fade(dim.baseContent, alpha), backdrop: dim.base100 });
  assert.ok(on100(0.3));
  assert.ok(on100(0.4));
  assert.equal(on100(0.5), null);
  assert.equal(on100(0.6), null);
  assert.equal(on100(0.7), null);
});

test("classifyUnreadableContrast reports the ratio it measured, rounded for display", () => {
  const failure = classifyUnreadableContrast({ textColor: dim.warningContent, backdrop: dim.base200 });
  assert.equal(failure.contrastRatio, Math.round(failure.contrastRatio * 100) / 100);
  assert.ok(failure.contrastRatio > 1);
});

test("classifyUnreadableContrast honours an explicit threshold", () => {
  const pair = { textColor: dim.baseContent, backdrop: dim.base200 };
  assert.equal(classifyUnreadableContrast(pair), null);
  assert.ok(classifyUnreadableContrast({ ...pair, minRatio: 21 }));
});

test("classifyUnreadableContrast stays silent when either color is unusable", () => {
  assert.equal(classifyUnreadableContrast({ textColor: null, backdrop: dim.base200 }), null);
  assert.equal(classifyUnreadableContrast({ textColor: dim.warningContent, backdrop: null }), null);
  assert.equal(classifyUnreadableContrast({ textColor: ["x"], backdrop: dim.base200 }), null);
});
