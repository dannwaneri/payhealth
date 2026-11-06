import { createExecutionContext, env as testEnv, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { draftDecision, keepKnownIds, takeCall } from "../src/agent";
import { addEvidence, blockReason, buildEvidence, deadlineChange, decideDraft, getDisputeView, redraft } from "../src/disputes";
import { createDemoDisputeForSale, createDemoEvent, createDemoSale } from "../src/demo";
import { trackerBody } from "../src/tracking";
import { addPaymentEvidence, getPaymentView } from "../src/payments";

const env = testEnv as unknown as Env;
const PASS = "test-password";

// ---------- helpers ----------
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function addEvent(opts: {
  id?: string; type?: string; disputeId: string; status?: string; stage?: string; txn?: string; isDemo?: number;
}) {
  const id = opts.id ?? uid("WH");
  const payload = {
    id, event_type: opts.type ?? "CUSTOMER.DISPUTE.CREATED",
    resource: {
      dispute_id: opts.disputeId, status: opts.status ?? "OPEN", dispute_life_cycle_stage: opts.stage ?? "INQUIRY",
      disputed_transactions: opts.txn ? [{ seller_transaction_id: opts.txn }] : [],
    },
  };
  await env.DB.prepare(
    `INSERT INTO events (id, event_type, resource_type, resource_id, payload, verified, verify_status, is_demo)
     VALUES (?, ?, 'dispute', ?, ?, 1, 'SUCCESS', ?)`
  ).bind(id, payload.event_type, opts.disputeId, JSON.stringify(payload), opts.isDemo ?? 0).run();
  return id;
}

async function addDraft(opts: {
  disputeId: string; eventId?: string | null; status?: string; source?: string; evidenceIds?: number[]; stage?: string;
}) {
  const draft = {
    evidence_type: "PROOF_OF_FULFILLMENT", evidence_ids: opts.evidenceIds ?? [], notes: "Shipped and delivered.",
    missing: [], evidence_strength: "strong", ...(opts.stage ? { stage: opts.stage } : {}),
  };
  const row = await env.DB.prepare(
    `INSERT INTO drafts (dispute_id, event_id, draft_json, status, source) VALUES (?, ?, ?, ?, ?) RETURNING id`
  ).bind(opts.disputeId, opts.eventId ?? null, JSON.stringify(draft), opts.status ?? "pending", opts.source ?? "model")
    .first<{ id: number }>();
  return row!.id;
}

async function addVaultItem(txn: string, isDemo = 0, carrier: string | null = "Sample Courier", tracking: string | null = "SC1") {
  const row = await env.DB.prepare(
    `INSERT INTO evidence (kind, title, body, carrier, tracking_number, transaction_id, is_demo)
     VALUES ('tracking', 'Courier record', 'Delivered.', ?, ?, ?, ?) RETURNING id`
  ).bind(carrier, tracking, txn, isDemo).first<{ id: number }>();
  return row!.id;
}

async function auditActions(disputeId: string) {
  const { results } = await env.DB.prepare(`SELECT action FROM audit_log WHERE dispute_id = ? ORDER BY id`)
    .bind(disputeId).all<{ action: string }>();
  return results.map((r) => r.action);
}

const draftStatus = async (id: number) =>
  (await env.DB.prepare(`SELECT status FROM drafts WHERE id = ?`).bind(id).first<{ status: string }>())!.status;

// ---------- webhook ----------
describe("webhook", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await SELF.fetch("https://x/webhook", { method: "POST", body: "nope" });
    expect(res.status).toBe(400);
  });

  it("rejects JSON that is not a PayPal event", async () => {
    const res = await SELF.fetch("https://x/webhook", { method: "POST", body: JSON.stringify({ hello: 1 }) });
    expect(res.status).toBe(400);
  });

  it("stores an unsigned simulator event as unverified, and ignores a duplicate", async () => {
    const id = uid("WH-SIM");
    const body = JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } });
    const first = await (await SELF.fetch("https://x/webhook", { method: "POST", body })).json<any>();
    const again = await (await SELF.fetch("https://x/webhook", { method: "POST", body })).json<any>();
    expect(first).toMatchObject({ stored: true, verified: false, verify_status: "ERROR:missing_headers" });
    expect(again).toMatchObject({ stored: false, duplicate: true });
    const row = await env.DB.prepare(`SELECT verified FROM events WHERE id = ?`).bind(id).first<{ verified: number }>();
    expect(row!.verified).toBe(0);
  });

  it("refuses unsigned events when the simulator switch is off", async () => {
    const ctx = createExecutionContext();
    const req = new Request("https://x/webhook", {
      method: "POST", body: JSON.stringify({ id: uid("WH-STRICT"), event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }),
    });
    const res = await worker.fetch(req as any, { ...env, ALLOW_UNVERIFIED_SIMULATOR: "false" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

// ---------- rules in plain code ----------
describe("evidence id filter", () => {
  it("drops ids that are not in the vault", () => {
    const out = keepKnownIds({ evidence_ids: [1, 2, 99], evidence_strength: "strong" }, [{ id: 1 }, { id: 2 }]);
    expect(out).toEqual({ evidence_ids: [1, 2], evidence_strength: "strong" });
  });

  it("rates a draft that cites nothing as weak, whatever the model said", () => {
    const out = keepKnownIds({ evidence_ids: [99], evidence_strength: "strong" }, [{ id: 1 }]);
    expect(out).toEqual({ evidence_ids: [], evidence_strength: "weak" });
  });
});

describe("approval block reasons", () => {
  it("allows a pending model draft that cites proof", () => {
    expect(blockReason({ status: "pending", source: "model" }, { evidence_ids: [1] })).toBeNull();
  });
  it("blocks a draft with no proof (Needs evidence)", () => {
    expect(blockReason({ status: "pending", source: "model" }, { evidence_ids: [] })).toMatch(/^Needs evidence/);
  });
  it("blocks a saved draft (it may carry another case's facts)", () => {
    expect(blockReason({ status: "pending", source: "saved" }, { evidence_ids: [1] })).toMatch(/saved draft/);
  });
  it("blocks a draft that is already decided", () => {
    expect(blockReason({ status: "submitted", source: "model" }, { evidence_ids: [1] })).toMatch(/already decided/);
  });
});

describe("PayPal evidence payload", () => {
  it("sends a known carrier by its PayPal code", () => {
    const p = buildEvidence({ evidence_type: "PROOF_OF_FULFILLMENT" }, [{ carrier: "ups", tracking_number: "1Z9" }], "n");
    expect(p.evidences[0]).toEqual({
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z9" }] },
      notes: "n",
    });
  });
  it("sends an unknown carrier as OTHER with carrier_name_other", () => {
    const p = buildEvidence({ evidence_type: "PROOF_OF_FULFILLMENT" }, [{ carrier: "Sample Courier", tracking_number: "SC1" }], "n");
    expect(p.evidences[0].evidence_info!.tracking_info[0]).toEqual({
      carrier_name: "OTHER", carrier_name_other: "Sample Courier", tracking_number: "SC1",
    });
  });
  it("falls back to OTHER when proof of fulfillment has no tracking number", () => {
    const p = buildEvidence({ evidence_type: "PROOF_OF_FULFILLMENT" }, [{ carrier: null, tracking_number: null }], "n");
    expect(p.evidences[0]).toEqual({ evidence_type: "OTHER", notes: "n" });
  });
});

// ---------- daily AI cap ----------
describe("daily AI cap", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM ai_usage`).run();
  });
  it("allows calls up to the cap, then refuses", async () => {
    const capped = { ...env, AI_DAILY_CAP: "2" };
    expect([await takeCall(capped), await takeCall(capped), await takeCall(capped)]).toEqual([true, true, false]);
  });
  it("refuses every call when the cap is 0", async () => {
    expect(await takeCall({ ...env, AI_DAILY_CAP: "0" })).toBe(false);
  });
});

// ---------- one draft per dispute stage ----------
describe("draft decision", () => {
  it("drafts a new dispute once", async () => {
    const d = uid("PP-D");
    const resource = { dispute_id: d, status: "OPEN", dispute_life_cycle_stage: "INQUIRY" };
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.CREATED", resource)).needsDraft).toBe(true);
    await addDraft({ disputeId: d });
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.CREATED", resource)).needsDraft).toBe(false);
  });

  it("drafts again when PayPal asks at a new stage (inquiry to claim)", async () => {
    const d = uid("PP-D");
    const ev = await addEvent({ disputeId: d, stage: "INQUIRY" });
    await addDraft({ disputeId: d, eventId: ev, status: "submitted" });
    const claim = { dispute_id: d, status: "WAITING_FOR_SELLER_RESPONSE", dispute_life_cycle_stage: "CHARGEBACK" };
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.UPDATED", claim)).needsDraft).toBe(true);
  });

  it("does not draft twice for the same stage", async () => {
    const d = uid("PP-D");
    const ev = await addEvent({ disputeId: d, stage: "INQUIRY" });
    await addDraft({ disputeId: d, eventId: ev, status: "submitted" });
    const same = { dispute_id: d, status: "WAITING_FOR_SELLER_RESPONSE", dispute_life_cycle_stage: "INQUIRY" };
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.UPDATED", same)).needsDraft).toBe(false);
  });

  it("does not draft while another draft is pending", async () => {
    const d = uid("PP-D");
    await addDraft({ disputeId: d, status: "pending", stage: "INQUIRY" });
    const claim = { dispute_id: d, status: "WAITING_FOR_SELLER_RESPONSE", dispute_life_cycle_stage: "CHARGEBACK" };
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.UPDATED", claim)).needsDraft).toBe(false);
  });

  it("does not draft when PayPal is not waiting for the seller", async () => {
    const d = uid("PP-D");
    const r = { dispute_id: d, status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK" };
    expect((await draftDecision(env, "CUSTOMER.DISPUTE.UPDATED", r)).needsDraft).toBe(false);
  });
});

// ---------- approval ----------
describe("approval", () => {
  it("needs the password and a name", async () => {
    const id = await addDraft({ disputeId: uid("PP-D"), evidenceIds: [1] });
    expect((await decideDraft(env, id, "approve", { password: "wrong", name: "A" })).status).toBe(401);
    expect((await decideDraft(env, id, "approve", { password: PASS, name: " " })).status).toBe(400);
  });

  it("refuses a draft with no proof, and leaves it waiting", async () => {
    const id = await addDraft({ disputeId: uid("PP-D"), evidenceIds: [] });
    const r = await decideDraft(env, id, "approve", { password: PASS, name: "A" });
    expect(r.status).toBe(409);
    expect(await draftStatus(id)).toBe("pending");
  });

  it("refuses a saved draft", async () => {
    const id = await addDraft({ disputeId: uid("PP-D"), evidenceIds: [1], source: "saved" });
    expect((await decideDraft(env, id, "approve", { password: PASS, name: "A" })).status).toBe(409);
  });

  it("approves a demo draft without sending, logs it, and cannot be approved twice", async () => {
    const d = uid("PP-D-DEMO");
    const txn = uid("TXN");
    const ev = await addEvent({ disputeId: d, txn, isDemo: 1 });
    const item = await addVaultItem(txn, 1);
    const id = await addDraft({ disputeId: d, eventId: ev, evidenceIds: [item] });

    const r = await decideDraft(env, id, "approve", { password: PASS, name: "Ada", notes: "Edited reply." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "approved", sent: false });
    expect(JSON.stringify((r.body as any).payload)).toContain('"carrier_name_other":"Sample Courier"');
    expect(await auditActions(d)).toEqual(["approved", "not_sent_demo"]);

    const twice = await decideDraft(env, id, "approve", { password: PASS, name: "Ada" });
    expect(twice.status).toBe(409);
  });

  it("rejects a draft and logs the reason", async () => {
    const d = uid("PP-D");
    const id = await addDraft({ disputeId: d, evidenceIds: [1] });
    const r = await decideDraft(env, id, "reject", { password: PASS, name: "Ada", reason: "Wrong order" });
    expect(r.body).toEqual({ status: "rejected" });
    expect(await draftStatus(id)).toBe("rejected");
    expect(await auditActions(d)).toEqual(["rejected"]);
  });
});

// ---------- submission to PayPal (fetch is stubbed; no network) ----------
describe("submission to PayPal", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubPayPal(links: string[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok" });
      if (String(url).endsWith("/provide-evidence")) return Response.json({ links: [] });
      return Response.json({ status: "WAITING_FOR_SELLER_RESPONSE", links: links.map((rel) => ({ rel })) });
    }));
    return calls;
  }

  async function realCase() {
    const d = uid("PP-R");
    const txn = uid("TXN");
    const ev = await addEvent({ disputeId: d, txn });
    const item = await addVaultItem(txn);
    const id = await addDraft({ disputeId: d, eventId: ev, evidenceIds: [item] });
    return { d, id };
  }

  it("sends nothing when PayPal is not asking for evidence, and keeps the draft waiting", async () => {
    const calls = stubPayPal(["send_message"]);
    const { d, id } = await realCase();
    const r = await decideDraft(env, id, "approve", { password: PASS, name: "Ada" });
    expect(r.body).toMatchObject({ status: "not_ready", sent: false });
    expect(calls.some((c) => c.url.endsWith("/provide-evidence"))).toBe(false);
    expect(await draftStatus(id)).toBe("pending");
    expect(await auditActions(d)).toEqual(["approved", "not_sent_not_ready"]);
  });

  it("submits the evidence as the multipart 'input' part when PayPal asks for it", async () => {
    const calls = stubPayPal(["provide_evidence"]);
    const { d, id } = await realCase();
    const r = await decideDraft(env, id, "approve", { password: PASS, name: "Ada" });
    expect(r.body).toMatchObject({ status: "submitted", sent: true });

    const post = calls.find((c) => c.url.endsWith("/provide-evidence"))!;
    const input = JSON.parse(await ((post.init!.body as FormData).get("input") as Blob).text());
    expect(input.evidences[0].evidence_type).toBe("PROOF_OF_FULFILLMENT");
    expect(input.evidences[0].evidence_info.tracking_info[0].tracking_number).toBe("SC1");
    expect(await draftStatus(id)).toBe("submitted");
    expect(await auditActions(d)).toEqual(["approved", "sent"]);
  });
});

// ---------- seller actions and demo isolation ----------
describe("seller actions", () => {
  it("validates new proof", async () => {
    const { disputeId } = await createDemoEvent(env, "no-proof");
    const base = { password: PASS, name: "Ada", title: "T", details: "D" };
    expect((await addEvidence(env, disputeId, { ...base, kind: "nonsense" })).status).toBe(400);
    expect((await addEvidence(env, disputeId, { ...base, kind: "tracking" })).status).toBe(400);
    expect((await addEvidence(env, disputeId, { ...base, kind: "receipt", password: "wrong" })).status).toBe(401);
  });

  it("keeps proof inside one demo case", async () => {
    const a = await createDemoEvent(env, "no-proof");
    const b = await createDemoEvent(env, "no-proof");
    const r = await addEvidence(env, a.disputeId, {
      password: PASS, name: "Ada", kind: "tracking", title: "Courier record", details: "Delivered.",
      carrier: "Sample Courier", tracking_number: "SC2",
    });
    expect(r.status).toBe(200);
    expect((await getDisputeView(env, a.disputeId))!.vault.map((v) => v.title)).toEqual(["Courier record"]);
    expect((await getDisputeView(env, b.disputeId))!.vault).toEqual([]);
    expect(await auditActions(a.disputeId)).toEqual(["proof_added"]);
  });

  it("gives each 'with proof' demo its own copy of the order proof", async () => {
    const a = await createDemoEvent(env, "proof");
    const b = await createDemoEvent(env, "proof");
    const va = (await getDisputeView(env, a.disputeId))!.vault;
    const vb = (await getDisputeView(env, b.disputeId))!.vault;
    const own = (v: typeof va) => v.filter((x) => x.transaction_id);
    expect(own(va)).toHaveLength(3);
    expect(own(vb)).toHaveLength(3);
    expect(own(va)[0].transaction_id).not.toBe(own(vb)[0].transaction_id);
  });

  it("refuses a new draft once the reply for this stage was sent", async () => {
    const d = uid("PP-R");
    await addEvent({ disputeId: d });
    await addDraft({ disputeId: d, status: "submitted" });
    expect((await redraft(env, d, { password: PASS, name: "Ada" })).status).toBe(409);
  });

  it("logs the request and reports a clear error when the AI is unavailable", async () => {
    const { disputeId } = await createDemoEvent(env, "no-proof");
    const r = await redraft(env, disputeId, { password: PASS, name: "Ada" });
    expect(r.status).toBe(502);
    expect(await auditActions(disputeId)).toEqual(["redraft_requested"]);
  });
});

// ---------- proof ready before a dispute ----------
describe("payment proof", () => {
  async function addPayment(captureId: string) {
    const payload = {
      id: uid("WH-PAY"), event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "24.00" } },
    };
    await env.DB.prepare(
      `INSERT INTO events (id, event_type, resource_type, resource_id, payload, verified, verify_status)
       VALUES (?, ?, 'capture', ?, ?, 1, 'SUCCESS')`
    ).bind(payload.id, payload.event_type, captureId, JSON.stringify(payload)).run();
  }

  it("shows a checklist and marks items saved", async () => {
    const cap = uid("CAP");
    await addPayment(cap);
    const before = (await getPaymentView(env, cap))!;
    expect(before.checklist.every((c) => !c.done)).toBe(true);
    const r = await addPaymentEvidence(env, cap, {
      password: PASS, name: "Ada", kind: "receipt", title: "Drop-off receipt", details: "Posted at the counter.",
    });
    expect(r.status).toBe(200);
    const after = (await getPaymentView(env, cap))!;
    expect(after.checklist.find((c) => c.kind === "receipt")!.done).toBe(true);
    expect(after.audit.map((a) => a.action)).toEqual(["proof_added"]);
  });

  it("puts proof saved after the sale into the vault of a later dispute", async () => {
    const cap = uid("CAP");
    await addPayment(cap);
    await addPaymentEvidence(env, cap, {
      password: PASS, name: "Ada", kind: "tracking", title: "Courier record", details: "Delivered, signed.",
      carrier: "UPS", tracking_number: "1Z999",
    });
    const d = uid("PP-R");
    await addEvent({ disputeId: d, txn: cap });
    const view = (await getDisputeView(env, d))!;
    expect(view.vault.map((v) => v.tracking_number)).toEqual(["1Z999"]);
    expect((await getPaymentView(env, cap))!.disputes).toEqual([d]);
  });

  it("refuses unknown payments and wrong passwords", async () => {
    const cap = uid("CAP");
    await addPayment(cap);
    expect((await addPaymentEvidence(env, uid("NOPE"), { password: PASS, name: "A", kind: "other", title: "t", details: "d" })).status).toBe(404);
    expect((await addPaymentEvidence(env, cap, { password: "wrong", name: "A", kind: "other", title: "t", details: "d" })).status).toBe(401);
  });
});

// ---------- tracking to PayPal and the demo sale ----------
describe("send tracking to PayPal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds the Orders v2 tracker body: known carriers by code, others as OTHER", () => {
    expect(trackerBody("CAP1", "dhl", "JD01")).toEqual({ capture_id: "CAP1", tracking_number: "JD01", carrier: "DHL", notify_payer: false });
    expect(trackerBody("CAP1", "Sample Courier", "SC1")).toEqual({
      capture_id: "CAP1", tracking_number: "SC1", carrier: "OTHER", carrier_name_other: "Sample Courier", notify_payer: false,
    });
  });

  async function realSale() {
    const cap = uid("CAP").replace(/-/g, "");
    const payload = {
      id: uid("WH-PAY"), event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: cap, status: "COMPLETED", supplementary_data: { related_ids: { order_id: "ORDER123" } } },
    };
    await env.DB.prepare(
      `INSERT INTO events (id, event_type, resource_type, resource_id, payload, verified, verify_status) VALUES (?, ?, 'capture', ?, ?, 1, 'SUCCESS')`
    ).bind(payload.id, payload.event_type, cap, JSON.stringify(payload)).run();
    return cap;
  }
  const trackingProof = (extra: Record<string, string> = {}) => ({
    password: PASS, name: "Ada", kind: "tracking", title: "Courier record", details: "Dropped off.",
    carrier: "UPS", tracking_number: "1Z1", send_to_paypal: "true", ...extra,
  });

  it("sends the tracking number to the right order, once per proof item, and records PayPal's answer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok" });
      return Response.json({ id: "ORDER123" }, { status: 201 });
    }));
    const cap = await realSale();
    const r = await addPaymentEvidence(env, cap, trackingProof());
    expect((r.body as any).tracking.status).toBe("sent");

    const post = calls.find((c) => c.url.endsWith("/v2/checkout/orders/ORDER123/track"))!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ capture_id: cap, tracking_number: "1Z1", carrier: "UPS", notify_payer: false });
    const reqId = (post.init!.headers as Record<string, string>)["paypal-request-id"];
    expect(reqId.startsWith(`payhealth-track-${cap}-`)).toBe(true);
    expect(Number(reqId.split("-").pop())).toBeGreaterThan(0);

    const view = (await getPaymentView(env, cap))!;
    expect(view.vault[0].paypal_tracking).toBe("sent");
    expect(view.audit.map((a) => a.action)).toEqual(["proof_added", "tracking_sent"]);
  });

  it("records a refusal from PayPal without losing the saved proof", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/v1/oauth2/token") ? Response.json({ access_token: "tok" }) : new Response("UNPROCESSABLE", { status: 422 })));
    const cap = await realSale();
    const r = await addPaymentEvidence(env, cap, trackingProof());
    expect((r.body as any).tracking.status).toBe("failed");
    const view = (await getPaymentView(env, cap))!;
    expect(view.vault).toHaveLength(1);
    expect(view.vault[0].paypal_tracking).toBe("failed");
  });

  it("does not send when the box is not ticked", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cap = await realSale();
    const r = await addPaymentEvidence(env, cap, trackingProof({ send_to_paypal: "false" }));
    expect((r.body as any).tracking).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("demo sale", () => {
  it("never sends a demo sale's tracking to PayPal", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { captureId } = await createDemoSale(env);
    const r = await addPaymentEvidence(env, captureId, {
      password: PASS, name: "Ada", kind: "tracking", title: "Courier record", details: "Delivered.",
      carrier: "Sample Courier", tracking_number: "SC9", send_to_paypal: "true",
    });
    expect((r.body as any).tracking.status).toBe("skipped_demo");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("opens a demo dispute for the sale, and the dispute starts with the sale's proof", async () => {
    const { captureId } = await createDemoSale(env);
    await addPaymentEvidence(env, captureId, {
      password: PASS, name: "Ada", kind: "receipt", title: "Drop-off receipt", details: "Posted at the counter.",
    });
    const created = (await createDemoDisputeForSale(env, captureId))!;
    const again = (await createDemoDisputeForSale(env, captureId))!;
    expect(again.disputeId).toBe(created.disputeId);
    const view = (await getDisputeView(env, created.disputeId))!;
    expect(view.is_demo).toBe(true);
    expect(view.vault.map((v) => v.title)).toEqual(["Drop-off receipt"]);
  });

  it("refuses a demo dispute for a real payment", async () => {
    const cap = uid("CAP");
    await env.DB.prepare(
      `INSERT INTO events (id, event_type, resource_type, resource_id, payload, verified, verify_status) VALUES (?, 'PAYMENT.CAPTURE.COMPLETED', 'capture', ?, '{}', 1, 'SUCCESS')`
    ).bind(uid("WH"), cap).run();
    expect(await createDemoDisputeForSale(env, cap)).toBeNull();
  });
});

// ---------- PayPal moves the reply-by date ----------
describe("deadline change", () => {
  const nov23 = "2026-11-23T04:22:09.695Z";
  const nov13 = "2026-11-13T04:00:00.000Z";

  it("reports the move when an inquiry becomes a claim", () => {
    expect(deadlineChange([nov23, nov23, nov13])).toEqual({ from: nov23, to: nov13 });
  });
  it("stays quiet when the date never moved or only differs by seconds", () => {
    expect(deadlineChange([nov23, nov23])).toBeNull();
    expect(deadlineChange([nov23, "2026-11-23T04:22:30.000Z"])).toBeNull();
    expect(deadlineChange([nov23])).toBeNull();
  });
  it("ignores events with no date, but stays quiet while the newest event has none", () => {
    expect(deadlineChange([nov23, null, nov13])).toEqual({ from: nov23, to: nov13 });
    expect(deadlineChange([nov23, nov13, undefined])).toBeNull();
    expect(deadlineChange([])).toBeNull();
  });
  it("shows the move on the dispute view", async () => {
    const d = uid("PP-R");
    for (const due of [nov23, nov13]) {
      const id = uid("WH");
      const payload = { id, event_type: "CUSTOMER.DISPUTE.UPDATED", resource: { dispute_id: d, seller_response_due_date: due } };
      await env.DB.prepare(
        `INSERT INTO events (id, event_type, resource_type, resource_id, payload, verified, verify_status) VALUES (?, ?, 'dispute', ?, ?, 1, 'SUCCESS')`
      ).bind(id, payload.event_type, d, JSON.stringify(payload)).run();
    }
    expect((await getDisputeView(env, d))!.deadline_change).toEqual({ from: nov23, to: nov13 });
  });
});
