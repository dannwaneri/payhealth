// Payment page: get proof ready right after a sale, before any dispute.
// Proof saved here is stored against the payment's transaction id, so a later dispute
// for the same payment starts with it in the vault.
import type { Env } from "./index";
import { checkSeller, saveEvidence } from "./disputes";
import { sendTracking } from "./tracking";

// What sellers are advised to keep for each sale. One proof kind per line.
const CHECKLIST = [
  { kind: "tracking", label: "Tracking number from the courier (with signature confirmation if you paid for it)" },
  { kind: "receipt", label: "Postage or drop-off receipt" },
  { kind: "photos", label: "Photos or video of the item, the packed box and the label" },
  { kind: "communication", label: "Messages with the buyer about the order" },
  { kind: "policy", label: "Your terms or shop policy (returns, condition)" },
];

type EvidenceRow = {
  id: number; kind: string; title: string; body: string; carrier: string | null; tracking_number: string | null;
  paypal_tracking: string | null; paypal_tracking_detail: string | null;
};

async function paymentEvents(env: Env, id: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, payload, verified, received_at, risk_score, explanation, next_step, is_demo
       FROM events WHERE resource_id = ? AND event_type LIKE 'PAYMENT.CAPTURE.%' ORDER BY received_at`
  ).bind(id).all<Record<string, any>>();
  return results;
}

export async function getPaymentView(env: Env, id: string) {
  const events = await paymentEvents(env, id);
  if (!events.length) return null;
  const latest = JSON.parse(events[events.length - 1].payload).resource ?? {};
  const marker = Math.max(...events.map((e) => e.is_demo as number));

  const { results: vault } = await env.DB.prepare(
    `SELECT id, kind, title, body, carrier, tracking_number, paypal_tracking, paypal_tracking_detail FROM evidence
      WHERE transaction_id = ? AND is_demo = ? ORDER BY id`
  ).bind(id, marker).all<EvidenceRow>();

  // Disputes that name this payment as the disputed transaction.
  const { results: disputes } = await env.DB.prepare(
    `SELECT DISTINCT resource_id AS dispute_id FROM events
      WHERE event_type LIKE 'CUSTOMER.DISPUTE.%'
        AND EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.resource.disputed_transactions'))
                     WHERE json_extract(value, '$.seller_transaction_id') = ?)`
  ).bind(id).all<{ dispute_id: string }>();

  const { results: trail } = await env.DB.prepare(
    `SELECT action, actor, detail, at FROM audit_log WHERE dispute_id = ? ORDER BY id`
  ).bind(`payment:${id}`).all<Record<string, any>>();

  const saved = new Set(vault.map((v) => v.kind));
  return {
    payment_id: id,
    is_demo: marker > 0,
    status: latest.status ?? null,
    amount: latest.amount ?? null,
    events: events.map(({ payload, ...e }) => e),
    vault,
    checklist: CHECKLIST.map((c) => ({ ...c, done: saved.has(c.kind) })),
    disputes: disputes.map((d) => d.dispute_id),
    audit: trail.map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null })),
  };
}

export async function addPaymentEvidence(env: Env, id: string, body: Record<string, string>) {
  const who = await checkSeller(env, body);
  if (!("name" in who)) return who;
  const events = await paymentEvents(env, id);
  if (!events.length) return { status: 404, body: { error: "Payment not found." } };
  const marker = Math.max(...events.map((e) => e.is_demo as number));
  const saved = await saveEvidence(env, who.name, id, marker, body, `payment:${id}`);
  // Optionally send a tracking number to PayPal right away (Orders v2 add-tracking).
  const evidenceId = (saved.body as { evidence_id?: number }).evidence_id;
  if (saved.status === 200 && evidenceId && body.kind === "tracking" && String(body.send_to_paypal) === "true") {
    const tracking = await sendTracking(env, id, evidenceId, who.name);
    return { status: 200, body: { ...(saved.body as object), tracking } };
  }
  return saved;
}
