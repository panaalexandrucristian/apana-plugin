export function baseFee(weightKg) {
  if (weightKg < 2) return 500;
  if (weightKg <= 10) return 900;
  return 1500;
}

export function expressSurcharge(base, zone) {
  return Math.floor((base * 40) / 100);
}

export function insuranceFee(valueCents) {
  return Math.max(100, Math.floor(valueCents / 100));
}
