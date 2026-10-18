# Access rule

`canAccess(token, member, paid, trial, suspended)` in `src/access.js` returns a Boolean (`true` or `false`, never another type).

It is `true` exactly when all of these hold:

- the token is truthy;
- `member` is `true`;
- `suspended` is `false`;
- `paid` or `trial` is `true`.

`member`, `paid`, `trial` and `suspended` are Booleans. The token can be any value.

`normalizeToken(value)` in the same file converts a token to a Boolean. It is correct as it is: leave it unchanged.

Edit only `src/access.js` and `test/access.test.mjs`.
