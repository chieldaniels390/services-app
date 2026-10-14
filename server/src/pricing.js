export const JOB_SIZES = {
  small: { label: 'Quick fix', hours: 1 },
  medium: { label: 'Standard job', hours: 2 },
  large: { label: 'Big job', hours: 4 },
};

const MAX_SURGE = 2;

/**
 * Demand-based multiplier: once open requests outnumber available pros nearby,
 * each extra request per pro adds 25%, capped at 2x. Rounded to 0.1 so quotes read cleanly.
 */
export function surgeMultiplier(openRequests, onlineProviders) {
  if (onlineProviders === 0 || openRequests <= onlineProviders) return 1;
  const raw = 1 + ((openRequests - onlineProviders) / onlineProviders) * 0.25;
  return Math.min(MAX_SURGE, Math.round(raw * 10) / 10);
}

export function quote(category, size, surge = 1) {
  const { hours } = JOB_SIZES[size];
  const labourCents = category.hourly_cents * hours;
  const subtotalCents = category.callout_cents + labourCents;
  return {
    calloutCents: category.callout_cents,
    labourCents,
    hours,
    surge,
    totalCents: Math.round(subtotalCents * surge),
  };
}

/** Split the final bill: the platform fee applies to the quoted work, materials go straight to the pro. */
export function settle(estimatedCents, materialsCents, feeRate) {
  const platformFeeCents = Math.round(estimatedCents * feeRate);
  const finalCents = estimatedCents + materialsCents;
  return { finalCents, platformFeeCents, payoutCents: finalCents - platformFeeCents };
}
