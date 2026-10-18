const UNIT_PRICE = { basic: 1000, plus: 1500, pro: 2000 };
const TAX_PERCENT = { EU: 20, US: 8, OTHER: 0 };

export function quote({ units, tier, region, coupon, express, gift, taxExempt }) {
  let subtotal = units * UNIT_PRICE[tier];
  if (units >= 10) subtotal -= Math.floor((subtotal * 10) / 100);
  if (coupon && tier !== "basic") subtotal -= 500;

  let shipping = express ? 1500 : 500;
  if (!express && subtotal >= 10000) shipping = 0;
  if (express && region === "OTHER") shipping += 1000;

  const wrap = gift && tier !== "pro" ? 200 : 0;
  const taxPercent = taxExempt && region === "US" ? 0 : TAX_PERCENT[region];
  const tax = Math.floor(((subtotal + wrap) * taxPercent) / 100);

  return subtotal + shipping + wrap + tax;
}
