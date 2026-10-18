import { baseFee, expressSurcharge, insuranceFee } from "./fees.js";
import { isRefused } from "./rules.js";
import { zoneOf } from "./zones.js";

export function methodOf({ express }) {
  return express ? "express" : "standard";
}

export function route(parcel) {
  if (isRefused(parcel)) return { allowed: false, method: "none", fee: 0 };
  const { weightKg, country, fragile, express, insured, valueCents } = parcel;
  const zone = zoneOf(country);
  const base = baseFee(weightKg);
  let fee = base;
  if (zone === "world") fee += 700;
  if (fragile) fee += 300;
  if (express) fee += expressSurcharge(base, zone);
  if (insured) fee += insuranceFee(valueCents);
  return { allowed: true, method: methodOf({ express }), fee };
}
