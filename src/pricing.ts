/**
 * Prices stated in the unit the user actually pays with.
 * A Studio API key debits prepaid credits: mentioning USDC there confuses A&R users (they never
 * touch crypto), so tool descriptions, reports and prompts only use the configured unit.
 */

export type PaymentMode = 'studio_credits' | 'x402_usdc' | 'unconfigured';

export const CREDITS_PER_TRACK = 1;
export const CREDITS_PER_TRACK_WITH_LYRICS = 2;
export const USDC_PER_TRACK = 0.15;
export const USDC_PER_TRACK_WITH_LYRICS = 0.25;

export function paymentModeFor(authType: 'API_KEY' | 'PRIVATE_KEY' | 'NONE'): PaymentMode {
  if (authType === 'API_KEY') return 'studio_credits';
  if (authType === 'PRIVATE_KEY') return 'x402_usdc';
  return 'unconfigured';
}

export interface CostEstimate {
  /** Ready-to-display cost, in the configured unit only (e.g. "8 studio credits") */
  label: string;
  studioCredits?: number;
  usdc?: number;
}

const credits = (n: number) => `${n} studio credit${n > 1 ? 's' : ''}`;
const usdc = (n: number) => `${Math.round(n * 100) / 100} USDC`;

export function estimateCost(mode: PaymentMode, tracks: number, lyrics: boolean): CostEstimate {
  const c = tracks * (lyrics ? CREDITS_PER_TRACK_WITH_LYRICS : CREDITS_PER_TRACK);
  const u = Math.round(tracks * (lyrics ? USDC_PER_TRACK_WITH_LYRICS : USDC_PER_TRACK) * 100) / 100;
  if (mode === 'studio_credits') return { label: credits(c), studioCredits: c };
  if (mode === 'x402_usdc') return { label: usdc(u), usdc: u };
  return { label: `${credits(c)} with a Studio API key, or ${usdc(u)} with a wallet`, studioCredits: c, usdc: u };
}

/** Price of one track, e.g. "1 studio credit" / "0.25 USDC" */
export function trackPrice(mode: PaymentMode, lyrics: boolean): string {
  return estimateCost(mode, 1, lyrics).label;
}

/** Sentence appended to paid tool descriptions */
export function pricingNote(mode: PaymentMode): string {
  if (mode === 'studio_credits') {
    return `Cost: ${credits(CREDITS_PER_TRACK)} per track, ${credits(CREDITS_PER_TRACK_WITH_LYRICS)} with lyrics, debited from the prepaid Studio balance. Always state costs in studio credits.`;
  }
  if (mode === 'x402_usdc') {
    return `Cost: ${usdc(USDC_PER_TRACK)} per track, ${usdc(USDC_PER_TRACK_WITH_LYRICS)} with lyrics, paid per request with an x402 micro-payment on Base.`;
  }
  return `Cost: ${credits(CREDITS_PER_TRACK)} per track (${credits(CREDITS_PER_TRACK_WITH_LYRICS)} with lyrics) with a Studio API key (TAG_PER_TRACK_API_KEY), or ${usdc(USDC_PER_TRACK)} (${usdc(USDC_PER_TRACK_WITH_LYRICS)} with lyrics) with a Base wallet (WALLET_PRIVATE_KEY, x402).`;
}
