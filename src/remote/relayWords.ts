/**
 * Our relay's subscription, in words, as the desktop's settings and the
 * phone app both show it. Plain TypeScript with no imports, so the phone app
 * (mobile/app) reads this file rather than a copy.
 */

/** What the words need: whether the account is blocked, and its state. */
export interface SubscriptionFacts {
  blocked: boolean;
  /** Its paid-until time, as the API gives it; null when never subscribed. */
  paidUntil: string | null;
  /** `pending | active | past_due | canceled | expired`; null: never subscribed. */
  state: string | null;
}

function day(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString();
}

/** The subscription's state, in plain words. */
export function subscriptionWords(facts: SubscriptionFacts): string {
  if (facts.blocked) {
    return "Relay access is suspended for this account.";
  }
  switch (facts.state) {
    case null:
      return "No subscription yet.";
    case "pending":
      return "A first payment is waiting to be confirmed.";
    case "active":
      return `Active, renews automatically. Paid until ${day(facts.paidUntil)}.`;
    case "past_due":
      return "A renewal payment was declined. It is tried again for a few days.";
    case "canceled":
      return `Canceled. Paid time until ${day(facts.paidUntil)} still counts.`;
    case "expired":
      return "Expired: the renewal failed.";
    default:
      return "";
  }
}
