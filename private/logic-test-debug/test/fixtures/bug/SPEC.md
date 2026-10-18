# Shipment approval

`isApproved({ expedited, signed, insured })` in `src/shipping.js` returns `true` when the shipment is signed and insured, and `false` otherwise. `expedited` affects scheduling only, never approval.

`schedule({ expedited })` returns `"next-day"` for an expedited shipment and `"standard"` for any other. It is correct as it is.

The public API is `isApproved` and `schedule`; keep both names and signatures.

Edit only `src/shipping.js` and `test/shipping.test.mjs`.
