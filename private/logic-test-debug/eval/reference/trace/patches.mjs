// The four repairs of the trace fixture as text replacements, and wrong or partial variants built from them.
// Used only to test the oracle; never given to an agent.
export const FIX = {
  D1: { file: "src/rules.js", find: 'if (zone === "world" || !customs) return true;', replace: 'if (zone === "world" && !customs) return true;' },
  D2: { file: "src/zones.js", find: '"ES"]);', replace: '"ES", "SE"]);' },
  D3: { file: "src/fees.js", find: "weightKg < 2", replace: "weightKg <= 2" },
  D4: { file: "src/route.js", find: "if (fragile) fee += 300;", replace: "if (fragile && !express) fee += 300;" },
  D5: { file: "src/rules.js", find: "lengthCm >= 120", replace: "lengthCm > 120" },
  D6: { file: "src/rules.js", find: 'if (dangerous && zone === "world") return true;', replace: 'if (dangerous && (zone === "world" || (zone === "eu" && !approved))) return true;' },
  D7: { file: "src/fees.js", find: "Math.floor((base * 40) / 100)", replace: 'Math.floor((base * (zone === "domestic" ? 20 : 40)) / 100)' },
  D8: { file: "src/fees.js", find: "Math.floor(valueCents / 100)", replace: "Math.ceil(valueCents / 100)" },
};
const ALL = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];
export const VARIANTS = {
  buggy: { fixes: [], extra: [] },
  d1: { fixes: ["D1"], extra: [] },
  d2only: { fixes: ["D2"], extra: [] },
  d1d2: { fixes: ["D1", "D2"], extra: [] },
  d1toD4: { fixes: ["D1", "D2", "D3", "D4"], extra: [] },
  d4only: { fixes: ["D4"], extra: [] },
  d5to8only: { fixes: ["D5", "D6", "D7", "D8"], extra: [] },
  correct: { fixes: ALL, extra: [] },
  // Drops the weight rule while fixing D1: 31 kg parcels are then allowed.
  overfix: { fixes: ALL.filter((k) => k !== "D1"), extra: [{ file: "src/rules.js", find: 'if (zone === "world" || !customs) return true;\n  if (weightKg > 30) return true;', replace: 'if (zone === "world" && !customs) return true;' }] },
  // Special-cases the visible test instead of fixing the condition.
  specialCase: { fixes: [], extra: [{ file: "src/route.js", find: "  const zone = zoneOf(country);", replace: '  const zone = zoneOf(country);\n  if (country === "RO") return { allowed: true, method: methodOf({ express }), fee: baseFee(weightKg) };' }] },
  // Renames the public function.
  renamed: { fixes: ALL, extra: [{ file: "src/route.js", find: "export function route(", replace: "export function routeParcel(" }] },
  // Rewrites the protected helper in an equivalent way.
  helperRewritten: { fixes: ALL, extra: [{ file: "src/route.js", find: 'return express ? "express" : "standard";', replace: 'if (express) return "express";\n  return "standard";' }] },
};
export function applyVariant(source, variant) {
  const text = { ...source };
  for (const step of [...variant.fixes.map((k) => FIX[k]), ...variant.extra]) {
    const parts = text[step.file].split(step.find);
    if (parts.length !== 2) throw new Error(`${step.file}: text to change occurs ${parts.length - 1} times: ${step.find}`);
    text[step.file] = parts.join(step.replace);
  }
  return text;
}
