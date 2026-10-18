# Quote

`quote({ units, tier, region, coupon, express, gift, taxExempt })` in `src/pricing.js` returns the total price in whole cents, an integer.

Inputs: `units` is an integer from 1 to 50; `tier` is `"basic"`, `"plus"` or `"pro"`; `region` is `"EU"`, `"US"` or `"OTHER"`; `coupon`, `express`, `gift` and `taxExempt` are Booleans.

Rules, applied in this order. A percentage is taken on a whole number of cents and rounded down.

1. Unit price: basic 1000, plus 1500, pro 2000. The subtotal is `units` times the unit price.
2. Bulk discount: 10% off the subtotal when `units` is 10 or more.
3. Coupon: when `coupon` is true and the tier is not `"basic"`, 500 off the subtotal from rule 2.
4. Shipping: 500 for standard delivery and 1500 when `express` is true. Standard delivery is free when the subtotal after rules 2 and 3 is 10000 or more. In region `"OTHER"`, express delivery costs 1000 more.
5. Gift wrap: when `gift` is true, add 200, except for tier `"pro"`, where it is free.
6. Tax: EU 20%, US 8%, OTHER 0%, on the subtotal after rules 2 and 3 plus the gift wrap. `taxExempt` makes the tax 0, but only in region `"US"`.
7. Total: subtotal + shipping + gift wrap + tax.

The implementation in `src/pricing.js` follows these rules. A faulty version of `quote` may be put in its place later.

Edit only `test/pricing.test.mjs`. Do not change `src/pricing.js`.
