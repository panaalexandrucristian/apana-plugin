export function normalizeToken(value) {
  return !!value;
}

export function canAccess(token, member, paid, trial, suspended) {
  return normalizeToken(token) && (member || paid) && !suspended && (paid || trial);
}
