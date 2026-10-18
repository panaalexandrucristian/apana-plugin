const EU = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "SK", "SI", "ES"]);

export function zoneOf(country) {
  if (country === "RO") return "domestic";
  return EU.has(country) ? "eu" : "world";
}
