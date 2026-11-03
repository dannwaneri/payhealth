// Sandbox checkout for testing PayHealth with a real dispute.
// Creates an order, waits for the buyer to approve it in the browser, then captures it.
//
// Usage (PowerShell), from the payhealth folder:
//   $env:PP_ID="<sandbox client id>"
//   $env:PP_SECRET="<sandbox secret>"
//   node scripts/sandbox-checkout.mjs
//
// Sandbox only. Never prints your secret.

import readline from "node:readline/promises";

const BASE = "https://api-m.sandbox.paypal.com";
const RETURN_URL = process.env.RETURN_URL || "https://payhealth.fpl-test.workers.dev/checkout-return";
const id = process.env.PP_ID;
const secret = process.env.PP_SECRET;
if (!id || !secret) {
  console.error("Set PP_ID and PP_SECRET first.");
  process.exit(1);
}

// Retries network errors (for example a DNS failure) up to 3 times. Order and capture calls
// carry a PayPal-Request-Id, so a retry cannot create a second order or a second charge.
async function fetchWithRetry(url, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`Network error (${err.cause?.code || err.message}). Trying again in 3 seconds...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function api(path, options = {}) {
  const res = await fetchWithRetry(BASE + path, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

const tokenRes = await api("/v1/oauth2/token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.error("No token. HTTP", tokenRes.status, "- check PP_ID and PP_SECRET.");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${tokenRes.body.access_token}`, "Content-Type": "application/json" };

// Physical goods with shipping, so the buyer can open an "item not received" dispute.
const order = await api("/v2/checkout/orders", {
  method: "POST",
  headers: { ...auth, "PayPal-Request-Id": `order-${Date.now()}` },
  body: JSON.stringify({
    intent: "CAPTURE",
    purchase_units: [{
      description: "Hand-dyed fabric, 2 yards (sandbox test)",
      amount: { currency_code: "USD", value: "24.00" },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: RETURN_URL,
          cancel_url: RETURN_URL + "?cancelled=1",
          user_action: "PAY_NOW",
          shipping_preference: "GET_FROM_FILE",
        },
      },
    },
  }),
});
if (!order.ok) {
  console.error("Create order failed. HTTP", order.status, JSON.stringify(order.body).slice(0, 400));
  process.exit(1);
}
const link = order.body.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
console.log("\nOrder ID:", order.body.id);
console.log("Open this link in your browser and pay with the PERSONAL sandbox account:\n");
console.log("   " + link.href + "\n");

// Wait for approval. Up to 3 checks, no endless loop.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let status = order.body.status;
for (let i = 1; i <= 3 && status !== "APPROVED"; i++) {
  await rl.question(`Press Enter after the page says "approved" (check ${i} of 3)... `);
  const check = await api(`/v2/checkout/orders/${order.body.id}`, { headers: auth });
  status = check.body.status;
  console.log("Order status:", status);
}
rl.close();
if (status !== "APPROVED") {
  console.error("The order is not approved. Run the script again and finish the payment page.");
  process.exit(1);
}

const cap = await api(`/v2/checkout/orders/${order.body.id}/capture`, {
  method: "POST",
  headers: { ...auth, "PayPal-Request-Id": `cap-${order.body.id}` },
  body: "{}",
});
if (!cap.ok) {
  console.error("Capture failed. HTTP", cap.status, JSON.stringify(cap.body).slice(0, 400));
  process.exit(1);
}
const capture = cap.body.purchase_units?.[0]?.payments?.captures?.[0];
console.log("\nCapture status:", capture?.status);
if (capture?.status_details?.reason) console.log("Reason:", capture.status_details.reason);
console.log("Capture ID (transaction ID):", capture?.id);
if (capture?.status === "COMPLETED") {
  console.log("\nDone. The buyer can now open a dispute for this payment.");
} else {
  console.log("\nThe payment is not completed. Tell Claude the status and reason above.");
}
