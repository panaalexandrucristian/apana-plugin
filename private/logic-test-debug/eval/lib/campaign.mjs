// The pre-registered order of the live sessions. For every scenario with two arms, run k is a pair; odd pairs start
// with ON and even pairs with OFF (the first arm alternates), so a drift in time or load cannot favour one arm.
// The non-code prompts run once each, ON only.
export const ARMS = { activation: ["ON", "OFF"], conditions: ["ON", "OFF"], bug: ["ON", "OFF"], combos: ["ON", "OFF"], trace: ["ON", "OFF"], nocode: ["ON"] };

/** Every planned session as {scenario, arm, run}, in the order they must start. `plan` is budget.plan.planned. */
export function campaignOrder(plan) {
  const order = [];
  for (const scenario of Object.keys(ARMS)) {
    if (plan[scenario] === undefined) continue; // a campaign plans only some scenarios
    const arms = ARMS[scenario];
    const pairs = plan[scenario] / arms.length;
    for (let run = 1; run <= pairs; run += 1) {
      const sequence = arms.length === 2 && run % 2 === 0 ? [...arms].reverse() : arms;
      for (const arm of sequence) order.push({ scenario, arm, run });
    }
  }
  return order;
}

/** The sessions not yet started, given the ledger's start rows. A planned session is matched by scenario, arm and run. */
export function remaining(order, startedRows) {
  const done = new Set(startedRows.filter((row) => row.kind === "planned").map((row) => `${row.scenario}/${row.arm}/${row.run}`));
  return order.filter((entry) => !done.has(`${entry.scenario}/${entry.arm}/${entry.run}`));
}
