export function normalizeToken(value) {
  return !!value;
}

export function canAccess(token, member, paid, trial, suspended) {
  throw new Error("canAccess is not implemented yet");
}
