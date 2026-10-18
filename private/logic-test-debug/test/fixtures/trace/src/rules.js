import { zoneOf } from "./zones.js";

export function isRefused({ weightKg, lengthCm, country, customs, dangerous, approved }) {
  const zone = zoneOf(country);
  if (zone === "world" || !customs) return true;
  if (weightKg > 30) return true;
  if (lengthCm >= 120) return true;
  if (dangerous && zone === "world") return true;
  return false;
}
