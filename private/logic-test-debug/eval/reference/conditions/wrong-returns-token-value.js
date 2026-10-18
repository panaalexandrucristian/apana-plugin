export function normalizeToken(value) {
  return !!value;
}

export function canAccess(token, member, paid, trial, suspended) {
  return token && member && !suspended && (paid || trial);
}
