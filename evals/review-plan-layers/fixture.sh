#!/bin/sh
set -eu
mkdir -p src/transport src/service src/view test
cat > AGENTS.md <<'EOT'
# Working here

- Use `node --test` for tests under `test/`.
EOT
cat > src/transport/offer.mjs <<'EOT'
export class OfferDto {
  constructor({ offer_id, amount_cents }) {
    this.offer_id = offer_id;
    this.amount_cents = amount_cents;
  }
}

export async function fetchOffer(fetchJson) {
  return new OfferDto(await fetchJson('/offer'));
}
EOT
cat > src/service/offer.mjs <<'EOT'
import { fetchOffer } from '../transport/offer.mjs';

export class Offer {
  constructor(id, amountCents) {
    this.id = id;
    this.amountCents = amountCents;
  }
}

export function toOffer(dto) {
  return new Offer(dto.offer_id, dto.amount_cents);
}

export async function getOffer(fetchJson) {
  return toOffer(await fetchOffer(fetchJson));
}
EOT
cat > src/view/offer.mjs <<'EOT'
import { getOffer } from '../service/offer.mjs';

export class OfferViewModel {
  constructor(id, displayPrice) {
    this.id = id;
    this.displayPrice = displayPrice;
  }
}

export function toOfferViewModel(offer) {
  return new OfferViewModel(offer.id, (offer.amountCents / 100).toFixed(2));
}

export async function showOffer(fetchJson) {
  return toOfferViewModel(await getOffer(fetchJson));
}
EOT
cat > test/offer.test.mjs <<'EOT'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showOffer } from '../src/view/offer.mjs';

test('maps an offer to its display price', async () => {
  const current = await showOffer(async () => ({ offer_id: 'one', amount_cents: 250 }));
  assert.equal(current.id, 'one');
  assert.equal(current.displayPrice, '2.50');
});
EOT
cat > PLAN.md <<'EOT'
# Plan: show the offer campaign label

## Requirement
The existing HTTP response may include `campaign_label` as a string. Expose it as `campaignLabel` on the view result, or `null` when absent. Keep the response format, displayed price and offer ID unchanged.

## Steps
1. In `src/transport/offer.mjs`, extend `OfferDto` to retain the optional wire field `campaign_label`.
2. In `src/view/offer.mjs`, import `fetchOffer` and call it directly from `showOffer` instead of `getOffer`. Pass the raw `OfferDto` to view code that reads `campaign_label` and the existing wire fields and builds the view model. Skip `toOffer` and `toOfferViewModel`; do not change the service.
3. Extend `test/offer.test.mjs` to verify both label outcomes through `showOffer`.

## Acceptance criteria
- Criterion — campaign label / steps 1–3: when the HTTP fixture includes `campaign_label: 'Summer'`, `showOffer` exposes `campaignLabel: 'Summer'`; when absent, it exposes `campaignLabel: null`. Passes if both cases preserve ID `one` and price `2.50`. Check: `node --test test/offer.test.mjs`. Evidence: test output. Status: planned, not run.
EOT
git init -q
git add -- AGENTS.md PLAN.md src test
git -c user.name='Review Plan Fixture' -c user.email=fixture@example.test -c commit.gpgSign=false -c core.hooksPath=/dev/null commit -qm 'Seed offer layers fixture'
