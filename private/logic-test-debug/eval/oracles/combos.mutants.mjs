// HIDDEN-ORACLE combos data: never copied into an agent workspace.
// Each mutant is the correct quote() with one textual change (`find` must occur exactly once). `order` is the number of
// input conditions that must hold together for the change to alter a result: 1 = a single value, 2 = a pair, 3 = a triple.
export const MUTANTS = [
  { id: "S1-bulk-threshold", order: 1, trigger: "units = 10", find: "if (units >= 10)", replace: "if (units > 10)" },
  { id: "S2-pro-price", order: 1, trigger: "tier = pro", find: "pro: 2000", replace: "pro: 1900" },
  { id: "P1-coupon-on-basic", order: 2, trigger: "coupon and basic", find: 'if (coupon && tier !== "basic")', replace: "if (coupon)" },
  { id: "P2-free-express", order: 2, trigger: "express and subtotal >= 10000", find: "if (!express && subtotal >= 10000) shipping = 0;", replace: "if (subtotal >= 10000) shipping = 0;" },
  { id: "P3-exempt-everywhere", order: 2, trigger: "taxExempt and EU", find: 'taxExempt && region === "US" ? 0', replace: "taxExempt ? 0" },
  { id: "P4-wrap-for-pro", order: 2, trigger: "gift and pro", find: 'gift && tier !== "pro" ? 200 : 0', replace: "gift ? 200 : 0" },
  { id: "P5-other-surcharge-always", order: 2, trigger: "OTHER and standard delivery", find: 'if (express && region === "OTHER") shipping += 1000;', replace: 'if (region === "OTHER") shipping += 1000;' },
  {
    id: "T1-coupon-before-bulk", order: 3, trigger: "units >= 10, coupon, not basic",
    find: 'if (units >= 10) subtotal -= Math.floor((subtotal * 10) / 100);\n  if (coupon && tier !== "basic") subtotal -= 500;',
    replace: 'if (coupon && tier !== "basic") subtotal -= 500;\n  if (units >= 10) subtotal -= Math.floor((subtotal * 10) / 100);',
  },
  { id: "T2-wrap-untaxed-in-eu", order: 3, trigger: "EU, gift, not pro", find: "Math.floor(((subtotal + wrap) * taxPercent) / 100)", replace: 'Math.floor(((region === "EU" ? subtotal : subtotal + wrap) * taxPercent) / 100)' },
  { id: "T3-no-free-shipping-other", order: 3, trigger: "OTHER, standard delivery, subtotal >= 10000", find: "if (!express && subtotal >= 10000) shipping = 0;", replace: 'if (!express && region !== "OTHER" && subtotal >= 10000) shipping = 0;' },
  { id: "T4-no-surcharge-with-gift", order: 3, trigger: "OTHER, express, gift", find: 'if (express && region === "OTHER") shipping += 1000;', replace: 'if (express && region === "OTHER" && !gift) shipping += 1000;' },
];

/** The correct source with one mutant applied; throws when `find` is not found exactly once. */
export function applyMutant(source, mutant) {
  const parts = source.split(mutant.find);
  if (parts.length !== 2) throw new Error(`${mutant.id}: the text to change occurs ${parts.length - 1} times`);
  return parts.join(mutant.replace);
}

/** A rewrite of quote() with the same behaviour for every valid input, written differently on purpose. */
export const EQUIVALENT = `const PRICE = new Map([["basic", 1000], ["plus", 1500], ["pro", 2000]]);
const RATE = { EU: 20, US: 8, OTHER: 0 };

export function quote(order) {
  const { units, tier, region, coupon, express, gift, taxExempt } = order;
  const gross = units * PRICE.get(tier);
  const afterBulk = units < 10 ? gross : gross - Math.floor(gross / 10);
  const net = coupon && tier !== "basic" ? afterBulk - 500 : afterBulk;
  const delivery = express ? (region === "OTHER" ? 2500 : 1500) : net >= 10000 ? 0 : 500;
  const wrap = gift ? (tier === "pro" ? 0 : 200) : 0;
  const percent = taxExempt && region === "US" ? 0 : RATE[region];
  return net + delivery + wrap + Math.floor(((net + wrap) * percent) / 100);
}
`;
