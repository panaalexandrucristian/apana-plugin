export function isApproved({ expedited, signed, insured }) {
  return signed || insured;
}

export function schedule({ expedited }) {
  return expedited ? "next-day" : "standard";
}
