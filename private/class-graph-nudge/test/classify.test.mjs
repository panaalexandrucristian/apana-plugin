import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analysePattern, classifyCommand, classifyGrepInput, isBareCommand, splitSegments } from "../classify.mjs";

const hit = (command) => classifyCommand(command);

describe("isBareCommand", () => {
  it("accepts the command alone, with or without the plugin prefix, and nothing after it", () => {
    for (const ok of ["/apana:class-graph", "  /class-graph  ", "/APANA:Class-Graph\n"]) assert.equal(isBareCommand(ok), true, ok);
    for (const no of ["/apana:class-graph Who uses Foo?", "/apana:class-graph-x", "class-graph", "", null, 7]) assert.equal(isBareCommand(no), false, String(no));
  });
});

describe("splitSegments", () => {
  it("keeps quoted words whole and marks the segment after a single pipe", () => {
    const segments = splitSegments(`cd /p && rg -n 'Foo Bar' a | grep -v "fun x" ; echo 'a|b'`);
    assert.deepEqual(segments.map((s) => s.words), [["cd", "/p"], ["rg", "-n", "Foo Bar", "a"], ["grep", "-v", "fun x"], ["echo", "a|b"]]);
    assert.deepEqual(segments.map((s) => s.piped), [false, false, true, false]);
  });
  it("treats || and && as separators that do not pipe", () => {
    assert.deepEqual(splitSegments("a || b && c").map((s) => s.piped), [false, false, false]);
  });
});

describe("analysePattern", () => {
  it("reads one to three class/member identifiers, with regex wrappers", () => {
    assert.deepEqual(analysePattern("OrderRewardsActivity"), { kind: "class", names: ["OrderRewardsActivity"] });
    assert.deepEqual(analysePattern("\\bRewardCardItemModel\\b"), { kind: "class", names: ["RewardCardItemModel"] });
    assert.deepEqual(analysePattern("statusLine\\("), { kind: "member", names: ["statusLine"] });
    assert.deepEqual(analysePattern("\\.currentStep|\\.totalSteps"), { kind: "member", names: ["currentStep", "totalSteps"] });
    assert.deepEqual(analysePattern("(?i)Continuity"), { kind: "class", names: ["Continuity"] });
    assert.deepEqual(analysePattern("class Continuity"), { kind: "decl", names: ["Continuity"] });
    assert.deepEqual(analysePattern("data\\s+class\\s+RewardCardItemModel"), { kind: "decl", names: ["RewardCardItemModel"] });
  });
  it("rejects resource ids, constants, text, short or library names and long alternations", () => {
    for (const no of ["rewards_purchased", "API_CALL", "TODO", "value passed", "\"API_CALL\"", "abc", "String", "Modifier", "fun getRewardState", "reward.?progress", "A|B|C|D", "(?i)purchases\\b|totalPurchases|PurchaseProgress|currentPurchases", "", null, "x".repeat(400)]) {
      assert.equal(analysePattern(no), null, String(no).slice(0, 40));
    }
  });
});

describe("analysePattern: a list of declared names", () => {
  const seven = ["ShoppingList", "ProductItem", "getProductStockStatus", "isOutOfStock", "InventoryStatus", "stockQty", "VaisParser"];
  it("reads a case-sensitive list of up to ten names, bare or in a regex wrapper", () => {
    assert.deepEqual(analysePattern(seven.join("|")).names, seven);
    assert.deepEqual(analysePattern(`\\b(${seven.join("|")})\\b`).names, seven);
    assert.deepEqual(analysePattern(`\\b(?:${seven.join("|")})\\b`).names, seven);
    assert.deepEqual(analysePattern("\\b(OrderRewardsActivity|RewardCardItemModel)\\b").names, ["OrderRewardsActivity", "RewardCardItemModel"]);
    assert.equal(analysePattern([...seven, "ExtraOne", "ExtraTwo", "ExtraThree", "ExtraFour"].join("|")), null, "eleven names are a sweep, not a lookup");
  });
  it("lets one or two flat words ride along in a list of four or more, and nothing else", () => {
    assert.deepEqual(analysePattern(`${seven.join("|")}|price|TAG`).names, seven);
    assert.equal(analysePattern(`${seven.join("|")}|price|status|TAG`), null, "three flat words");
    assert.equal(analysePattern("ShoppingList|price"), null, "a short list keeps the all-names rule");
    assert.equal(analysePattern(`${seven.join("|")}|rewards_purchased`), null, "a resource id in the list");
  });
  it("keeps the three-name limit for a case-insensitive search, whose variants are guessed names", () => {
    assert.equal(analysePattern(seven.join("|"), { ignoreCase: true }), null);
    assert.equal(analysePattern(`(?i)${seven.join("|")}`), null);
    assert.equal(analysePattern("ShoppingList|ProductItem|VaisParser", { ignoreCase: true }).names.length, 3);
  });
});

describe("classifyCommand: lookups of the users of a class or member", () => {
  it("fires on plain searches for a project name in Kotlin/Java code", () => {
    assert.deepEqual(hit("rg -n 'OrderRewardsActivity' app/src/main -g '*.kt' | head").names, ["OrderRewardsActivity"]);
    assert.equal(hit(`grep -rn "StepsProgressItems(" app/src --include=*.kt | grep -v "fun "`).kind, "class");
    assert.deepEqual(hit(`rg -n "\\.currentStep|\\.totalSteps" --type kotlin app/src/main | grep -v "/test/"`).names, ["currentStep", "totalSteps"]);
    assert.equal(hit("rg -l 'class Continuity' app/src/main -g '*.kt' -g '*.java'").kind, "decl");
    assert.equal(hit("git grep -n \"getTextByState\" -- '*.kt'").kind, "member");
    assert.equal(hit("rg -n -e 'sortCouponsBy' -e getFilteredDealsCount app/src/main").names.length, 2);
    assert.equal(hit("cd /work/app && rg -n statusLine app/src/main").cd, "/work/app");
    assert.equal(hit("echo start; rg -n 'Foo' | wc -l"), null, "a name too short is not a lookup");
    assert.equal(hit("grep -rn RewardsActivityMapper app/src").kind, "class");
  });
  it("does not fire on literal text, resource ids, constants or guessed-name alternations", () => {
    for (const command of [
      "rg -n 'rewards_purchased' app/src/main -g '*.kt' -g '*.xml'",
      "rg -n '\"API_CALL\"|API_CALL' app/src/main -g '*.kt'",
      "rg -n 'TODO|FIXME' app/src",
      "rg -n -i 'purchaseCount|purchasesCount|purchases\\b|totalPurchases|PurchaseProgress|currentPurchases' app/src/main -g '*.kt'",
      "rg -n -i 'DGReward|reward.?progress.?alert|value passed' app/src -g '*.kt' -g '*.xml' -g '*.json'",
      "grep -n 'fun getRewardState' -r app/src",
      "rg -n 'getRewardState' app/src/main -g '*.xml'",
    ]) assert.equal(hit(command), null, command);
  });
  it("fires on a case-sensitive list of declared names in the forms rg and grep are written in", () => {
    const names = "ShoppingList|ProductItem|getProductStockStatus|isOutOfStock|InventoryStatus|stockQty|VaisParser";
    for (const command of [
      `rg -l '${names}' app/src`,
      `rg -l -w "${names}" app/src`,
      `rg -l '\\b(${names})\\b' app/src`,
      `rg -l '\\b(?:${names})\\b' app/src`,
      `cd /p/dgapp2-android && rg -l "${names}" --glob '*.kt' | wc -l`,
      `grep -rlE '${names}' app/src --include='*.kt'`,
      `grep -rIl -E "${names}" --include=*.kt --include=*.xml --include=*.java . | grep -v /build/`,
    ]) assert.equal(hit(command)?.names.length, 7, command);
    assert.equal(hit("rg -l -e ShoppingList -e ProductItem -e getProductStockStatus -e isOutOfStock -e InventoryStatus -e VaisParser app/src").names.length, 6);
    assert.equal(hit(`rg -l '${names}|price|TAG' app/src`).names.length, 7, "two flat words ride along");
  });
  it("does not fire on a long list when the search is case-insensitive, or on a list of web sources", () => {
    const names = "ShoppingList|ProductItem|getProductStockStatus|isOutOfStock|InventoryStatus|stockQty|VaisParser";
    for (const command of [
      `rg -n -i '${names}' app/src -g '*.kt'`,
      `grep -rniE '${names}' app/src`,
      `rg --ignore-case -l '${names}' app/src`,
      `rg -l '(?i)${names}' app/src`,
      `rg -n '${names}' components/rewardDetails/index.tsx`,
      `grep -n -E '${names}' utilities/API/rewards.ts`,
    ]) assert.equal(hit(command), null, command);
  });
  it("does not fire on a filter over another command's output, a git revision, one known file or non-code files", () => {
    for (const command of [
      "adb shell dumpsys package x | grep -E 'versionName|lastUpdateTime'",
      "git log --oneline | grep RewardCardItemModel",
      "git grep -n routeToVais origin/release/16.2 -- app/src/main",
      "grep -n 'isPhase2' app/src/main/java/x/RewardCardDetailsBodyViewHolder.kt",
      "rg -n 'productFlavors|flavorDimensions' app/build.gradle*",
      "rg -n 'toolbarProductDescription' app/src/main/res/layout",
      "rg -n 'OrderRewardsActivity' ~/.claude/projects",
      "rg --files -g 'OrderRewardsActivity*.kt'",
    ]) assert.equal(hit(command), null, command);
  });
  it("is bounded and total: heredocs, huge or non-string input give null", () => {
    assert.equal(hit("python3 - <<'EOF'\nimport os\nEOF"), null);
    assert.equal(hit(`rg -n OrderRewardsActivity ${"a ".repeat(3000)}`), null);
    for (const input of [undefined, null, 42, "", "   ", "echo hi", "ls -la"]) assert.equal(classifyCommand(input), null);
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) classifyCommand(`cd /x && rg -n 'OrderRewardsActivity' ${"app/src ".repeat(100)}| head`);
    assert.ok(performance.now() - started < 2000, "200 calls in under 2 s");
  });
});

describe("classifyGrepInput: the Grep tool", () => {
  it("fires on a class or member name searched in code, with the same exclusions as the Bash search", () => {
    assert.deepEqual(classifyGrepInput({ pattern: "OrderRewardsActivity", glob: "*.kt", path: "/p/app/src/main" }).names, ["OrderRewardsActivity"]);
    assert.equal(classifyGrepInput({ pattern: "accumulatedBalance", type: "kotlin" }).kind, "member");
    assert.equal(classifyGrepInput({ pattern: "\\.currentStep|\\.totalSteps", path: "/p/app/src" }).names.length, 2);
    const names = "ShoppingList|ProductItem|getProductStockStatus|isOutOfStock|InventoryStatus|stockQty|VaisParser";
    assert.equal(classifyGrepInput({ pattern: names, glob: "*.kt" }).names.length, 7);
    assert.equal(classifyGrepInput({ pattern: names, glob: "*.kt", "-i": true }), null, "case-insensitive list");
    for (const input of [
      { pattern: "rewards_purchased", glob: "*.kt" },
      { pattern: "TODO", path: "/p" },
      { pattern: "OrderRewardsActivity", glob: "*.xml" },
      { pattern: "OrderRewardsActivity", path: "/p/app/src/main/res/layout" },
      { pattern: "OrderRewardsActivity", path: "/p/app/src/main/java/x/Foo.kt" },
      { pattern: "fun getRewardState" },
      { pattern: 7 },
      {},
      null,
    ]) assert.equal(classifyGrepInput(input), null, JSON.stringify(input));
  });
});
