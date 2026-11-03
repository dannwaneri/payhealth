// Prepared demo case. All names, numbers and messages here are fictional sample data.
// The demo button stores this as a normal event (is_demo = 1) and runs the real pipeline.
import type { Env } from "./index";

const DEMO_TXN = "DEMO-TXN-7731";

const DEMO_EVIDENCE = [
  {
    kind: "tracking",
    title: "Shipment to buyer",
    body: "Shipped 2026-10-08 from Lagos to Austin, TX. Courier status: Delivered 2026-10-21, signed by M. Ortiz.",
    carrier: "Sample Courier",
    tracking_number: "SC123456789NG",
    transaction_id: DEMO_TXN,
  },
  {
    kind: "receipt",
    title: "Order receipt #1042",
    body: "2 yards hand-dyed adire fabric. Total USD 84.00. Ship to: Austin, TX.",
    carrier: null,
    tracking_number: null,
    transaction_id: DEMO_TXN,
  },
  {
    kind: "communication",
    title: "Email to buyer, 2026-10-09",
    body: "Seller emailed the buyer the tracking number SC123456789NG one day after shipping.",
    carrier: null,
    tracking_number: null,
    transaction_id: DEMO_TXN,
  },
  {
    kind: "policy",
    title: "Shipping policy",
    body: "International orders ship within 3 business days. Delivery takes 10 to 20 business days.",
    carrier: null,
    tracking_number: null,
    transaction_id: null,
  },
];

async function seedDemoVault(env: Env): Promise<void> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE is_demo = 1`).first<{ n: number }>();
  if (row && row.n > 0) return;
  await env.DB.batch(
    DEMO_EVIDENCE.map((e) =>
      env.DB.prepare(
        `INSERT INTO evidence (kind, title, body, carrier, tracking_number, transaction_id, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(e.kind, e.title, e.body, e.carrier, e.tracking_number, e.transaction_id)
    )
  );
}

// Two demo cases. "proof": the seller saved tracking, a receipt and an email (is_demo = 1).
// "no-proof": the seller saved nothing. is_demo = 2 has no vault rows at all, so the draft
// is always "Needs evidence".
export type DemoCase = "proof" | "no-proof";
const CASES = {
  proof: {
    marker: 1, txn: DEMO_TXN, amount: "84.00", item: "2 yards hand-dyed adire fabric", soldAt: "2026-10-07T14:02:00Z",
    message: "It has been 3 weeks and my package has not arrived.",
  },
  "no-proof": {
    marker: 2, txn: "DEMO-TXN-5108", amount: "56.00", item: "Handmade leather sandals, size 42", soldAt: "2026-10-12T09:30:00Z",
    message: "I paid two weeks ago and nothing has come. Please refund me.",
  },
} as const;

function demoEvent(kind: DemoCase) {
  const c = CASES[kind];
  const now = new Date();
  const short = crypto.randomUUID().slice(0, 8).toUpperCase();
  const due = new Date(now.getTime() + 10 * 864e5);
  return {
    id: `WH-DEMO-${short}`,
    event_version: "1.0",
    create_time: now.toISOString(),
    resource_type: "dispute",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    summary: `A new dispute opened with Case # PP-D-DEMO-${short} (demo case)`,
    resource: {
      dispute_id: `PP-D-DEMO-${short}`,
      create_time: now.toISOString(),
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "OPEN",
      dispute_amount: { currency_code: "USD", value: c.amount },
      dispute_life_cycle_stage: "INQUIRY",
      dispute_channel: "INTERNAL",
      seller_response_due_date: due.toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: c.txn,
          create_time: c.soldAt,
          items: [{ item_description: c.item }],
        },
      ],
      messages: [
        { posted_by: "BUYER", time_posted: now.toISOString(), content: c.message },
      ],
    },
  };
}

// Stores a fresh demo dispute event. The caller runs the normal pipeline.
export async function createDemoEvent(env: Env, kind: DemoCase = "proof"): Promise<{ eventId: string; disputeId: string }> {
  await seedDemoVault(env);
  const ev = demoEvent(kind);
  await env.DB.prepare(
    `INSERT INTO events (id, event_type, resource_type, resource_id, summary, payload, verified, verify_status, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'DEMO', ?)`
  )
    .bind(ev.id, ev.event_type, ev.resource_type, ev.resource.dispute_id, ev.summary, JSON.stringify(ev), CASES[kind].marker)
    .run();
  return { eventId: ev.id, disputeId: ev.resource.dispute_id };
}
