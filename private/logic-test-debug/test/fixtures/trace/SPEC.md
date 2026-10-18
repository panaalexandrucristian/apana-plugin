# Parcel routing

`route({ weightKg, lengthCm, country, fragile, express, customs, insured, valueCents, dangerous, approved })` in `src/route.js` returns `{ allowed, method, fee }`. A flag or a number that is missing counts as false or 0.

**Zones.** `zoneOf(country)` in `src/zones.js` returns `"domestic"` for `"RO"`, `"eu"` for the other 26 member states of the European Union in 2024 (AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT SK SI ES SE) and `"world"` for every other code.

**Refusal.** A parcel is refused, and gets `{ allowed: false, method: "none", fee: 0 }`, when any of these holds:
- it goes to the `"world"` zone without a customs form (`customs` is false);
- it weighs more than 30 kg;
- its longest side `lengthCm` is more than 120;
- it is `dangerous` goods and it does not go to the domestic zone and it does not go to the `"eu"` zone with `approved` true. So dangerous goods to the world zone are always refused, and to the EU zone only without approval.

**Method.** Any other parcel is allowed, with `method` from `methodOf({ express })` in `src/route.js`: `"express"` or `"standard"`.

**Fee** of an allowed parcel, in whole cents: `baseFee(weightKg)` from `src/fees.js` plus supplements. `baseFee` is 500 up to and including 2 kg, 900 above 2 kg up to and including 10 kg, and 1500 above 10 kg. Supplements:
- 700 for the `"world"` zone;
- 300 for a fragile parcel unless it is sent express (express handling already includes the care);
- express: 40% of the base fee, rounded down; for a domestic parcel 20% of the base fee, rounded down;
- insured (`insured` is true): 1% of `valueCents`, rounded up, but at least 100.

The public API is `route`, `zoneOf`, `baseFee` and `methodOf`; keep these names and signatures. `methodOf` is correct as it is: leave it unchanged.

Edit only `src/route.js`, `src/rules.js`, `src/zones.js`, `src/fees.js` and `test/route.test.mjs`.
