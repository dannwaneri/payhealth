// Prepared demo case. All names, numbers and messages here are fictional sample data.
// The demo button stores this as a normal event (is_demo = 1) and runs the real pipeline.
import type { Env } from "./index";

const DEMO_TXN = "DEMO-TXN-7731";

const DEMO_EVIDENCE = [
  {
    kind: "tracking",
    title: "Shipment to buyer",
    body: "Shipped 2026-10-08 from Lagos to Austin, TX. Courier status: Delivered 2026-10-21, signed by M. Ortiz.",
    carrier: "OTHER",
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

function demoEvent() {
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
      dispute_amount: { currency_code: "USD", value: "84.00" },
      dispute_life_cycle_stage: "INQUIRY",
      dispute_channel: "INTERNAL",
      seller_response_due_date: due.toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: DEMO_TXN,
          create_time: "2026-10-07T14:02:00Z",
          items: [{ item_description: "2 yards hand-dyed adire fabric" }],
        },
      ],
      messages: [
        { posted_by: "BUYER", time_posted: now.toISOString(), content: "It has been 3 weeks and my package has not arrived." },
      ],
    },
  };
}

// Stores a fresh demo dispute event and returns its id. The caller runs the normal pipeline.
export async function createDemoEvent(env: Env): Promise<string> {
  await seedDemoVault(env);
  const ev = demoEvent();
  await env.DB.prepare(
    `INSERT INTO events (id, event_type, resource_type, resource_id, summary, payload, verified, verify_status, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'DEMO', 1)`
  )
    .bind(ev.id, ev.event_type, ev.resource_type, ev.resource.dispute_id, ev.summary, JSON.stringify(ev))
    .run();
  return ev.id;
}
