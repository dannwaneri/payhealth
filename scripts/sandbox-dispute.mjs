// Sandbox helper: see a dispute and move it forward from the seller side.
// Uses PayPal's Customer Disputes API on the SANDBOX only.
//
// Usage (PowerShell), from the payhealth folder, with the seller app's keys set:
//   $env:PP_ID="<sandbox client id>"
//   $env:PP_SECRET="<sandbox secret>"
//   node scripts/sandbox-dispute.mjs list
//   node scripts/sandbox-dispute.mjs show <dispute-id>
//   node scripts/sandbox-dispute.mjs escalate <dispute-id>         INQUIRY -> claim (UNDER_REVIEW)
//   node scripts/sandbox-dispute.mjs seller-evidence <dispute-id>  UNDER_REVIEW -> WAITING_FOR_SELLER_RESPONSE (sandbox only)
//   node scripts/sandbox-dispute.mjs settle <dispute-id> seller|buyer  (sandbox only)

const BASE = "https://api-m.sandbox.paypal.com";
const [cmd, disputeId, extra] = process.argv.slice(2);
const id = process.env.PP_ID;
const secret = process.env.PP_SECRET;
if (!id || !secret) {
  console.error("Set PP_ID and PP_SECRET first.");
  process.exit(1);
}

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

async function show(dId) {
  const r = await api(`/v1/customer/disputes/${encodeURIComponent(dId)}`, { headers: auth });
  if (!r.ok) {
    console.error("Could not read the dispute. HTTP", r.status, JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  const d = r.body;
  console.log(`Dispute ${d.dispute_id}`);
  console.log(`  Reason: ${d.reason}`);
  console.log(`  Stage:  ${d.dispute_life_cycle_stage}`);
  console.log(`  Status: ${d.status}`);
  console.log(`  Amount: ${d.dispute_amount?.currency_code} ${d.dispute_amount?.value}`);
  console.log(`  Transaction: ${d.disputed_transactions?.[0]?.seller_transaction_id ?? "?"}`);
  console.log(`  Actions PayPal allows now: ${(d.links ?? []).map((l) => l.rel).filter((x) => x !== "self").join(", ") || "none"}`);
  return d;
}

async function post(dId, action, body) {
  const r = await api(`/v1/customer/disputes/${encodeURIComponent(dId)}/${action}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  console.log(`${action}: HTTP ${r.status}${r.ok ? " (accepted)" : ""}`);
  if (!r.ok) console.log(JSON.stringify(r.body).slice(0, 500));
  return r.ok;
}

switch (cmd) {
  case "list": {
    const r = await api("/v1/customer/disputes?page_size=10", { headers: auth });
    if (!r.ok) {
      console.error("Could not list disputes. HTTP", r.status, JSON.stringify(r.body).slice(0, 300));
      process.exit(1);
    }
    const items = r.body.items ?? [];
    if (!items.length) console.log("No disputes for this seller yet. PayPal can take a few minutes to show a new one.");
    for (const d of items) {
      console.log(`${d.dispute_id}  ${d.status}  ${d.dispute_life_cycle_stage ?? ""}  ${d.reason}  ${d.dispute_amount?.value ?? ""}  ${d.create_time}`);
    }
    break;
  }
  case "show":
    await show(disputeId);
    break;
  case "escalate":
    await post(disputeId, "escalate", { note: "Sandbox test: escalate to a claim so the seller can submit evidence." });
    await show(disputeId);
    break;
  case "seller-evidence":
    await post(disputeId, "require-evidence", { action: "SELLER_EVIDENCE" });
    await show(disputeId);
    break;
  case "settle": {
    const outcome = extra === "buyer" ? "BUYER_FAVOR" : extra === "seller" ? "SELLER_FAVOR" : null;
    if (!outcome) {
      console.error('Say who wins: "seller" or "buyer".');
      process.exit(1);
    }
    await post(disputeId, "adjudicate", { adjudication_outcome: outcome });
    await show(disputeId);
    break;
  }
  default:
    console.log("Commands: list | show <id> | escalate <id> | seller-evidence <id> | settle <id> seller|buyer");
    process.exit(cmd ? 1 : 0);
}
