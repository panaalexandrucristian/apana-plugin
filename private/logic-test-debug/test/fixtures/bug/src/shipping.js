export function isApproved({ expedited, signed, insured }) {
  return signed && insured && !expedited;
}

export function schedule({ expedited }) {
  return expedited ? "next-day" : "standard";
}
