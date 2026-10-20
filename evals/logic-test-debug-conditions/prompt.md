---
name: logic-test-debug-conditions
runs: 2
model: haiku
max_turns: 4
timeout_seconds: 120
allowed_tools: [Skill]
---

We need tests for this condition:

```js
const allowed = isMember && !isBanned && hasPayment;
```

List concrete tests that cover interactions between the three inputs. State the selected interaction strength and why. Do not claim to have run tests.
