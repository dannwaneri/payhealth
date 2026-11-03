// Send a tracking number to PayPal (Orders v2 add-tracking) right after the sale.
// PayPal's docs: sending tracking numbers gives "faster access to funds, seller protection,
// and quicker resolution of payment holds". The order must be captured and COMPLETED.
import type { Env } from "./index";
import { audit } from "./disputes";
import { getAccessToken } from "./paypal";

// Carrier codes that exist in the Orders v2 carrier list (checked against PayPal's schema).
// Anything else is sent as OTHER with carrier_name_other.
const ORDERS_CARRIERS = new Set(["UPS", "USPS", "FEDEX", "DHL", "TNT", "ROYAL_MAIL", "PARCELFORCE"]);

export function trackerBody(captureId: string, carrier: string | null, trackingNumber: string) {
  const code = (carrier ?? "").toUpperCase().replace(/\s+/g, "_");
  return {
    capture_id: captureId,
    tracking_number: trackingNumber,
    ...(ORDERS_CARRIERS.has(code)
      ? { carrier: code }
      : { carrier: "OTHER", carrier_name_other: carrier || "Unknown carrier" }),
    notify_payer: false,
  };
}

type Result = { status: "sent" | "failed" | "skipped_demo"; message: string; http_status?: number };

async function record(env: Env, evidenceId: number, captureId: string, r: Result, actor: string) {
  await env.DB.prepare(`UPDATE evidence SET paypal_tracking = ?, paypal_tracking_detail = ? WHERE id = ?`)
    .bind(r.status, r.message, evidenceId).run();
  const action = r.status === "sent" ? "tracking_sent" : r.status === "failed" ? "tracking_send_failed" : "tracking_not_sent_demo";
  await audit(env, `payment:${captureId}`, null, action, actor, { evidence_id: evidenceId, ...r });
}

export async function sendTracking(env: Env, captureId: string, evidenceId: number, actor: string): Promise<Result> {
  const item = await env.DB.prepare(
    `SELECT carrier, tracking_number, is_demo FROM evidence WHERE id = ? AND transaction_id = ?`
  ).bind(evidenceId, captureId).first<{ carrier: string | null; tracking_number: string | null; is_demo: number }>();
  if (!item?.tracking_number) return { status: "failed", message: "This proof has no tracking number." };

  if (item.is_demo) {
    const r: Result = { status: "skipped_demo", message: "Demo sale: nothing was sent to PayPal." };
    await record(env, evidenceId, captureId, r, "PayHealth");
    return r;
  }

  const ev = await env.DB.prepare(
    `SELECT json_extract(payload, '$.resource.supplementary_data.related_ids.order_id') AS order_id
       FROM events WHERE resource_id = ? AND event_type LIKE 'PAYMENT.CAPTURE.%' ORDER BY received_at DESC LIMIT 1`
  ).bind(captureId).first<{ order_id: string | null }>();
  if (!ev?.order_id) {
    const r: Result = { status: "failed", message: "PayPal did not say which order this payment belongs to." };
    await record(env, evidenceId, captureId, r, "PayHealth");
    return r;
  }

  let r: Result;
  try {
    const token = await getAccessToken(env);
    const res = await fetch(`${env.PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(ev.order_id)}/track`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // Same proof item, same request id: a retry cannot add the tracker twice.
        "paypal-request-id": `payhealth-track-${captureId}-${evidenceId}`,
      },
      body: JSON.stringify(trackerBody(captureId, item.carrier, item.tracking_number)),
    });
    const text = await res.text();
    r = res.ok
      ? { status: "sent", message: "PayPal saved the tracking number on this order.", http_status: res.status }
      : { status: "failed", message: `PayPal refused the tracking number: ${text.slice(0, 300)}`, http_status: res.status };
  } catch (err) {
    r = { status: "failed", message: `Could not reach PayPal: ${(err as Error).message}` };
  }
  await record(env, evidenceId, captureId, r, "PayHealth");
  return r;
}
