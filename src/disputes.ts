// Dispute view, approval, and submission to the PayPal Disputes API.
import type { Env } from "./index";
import { getAccessToken } from "./paypal";

// Carriers PayPal accepts by code (subset of the enum in the Disputes API schema).
// Anything else is sent as OTHER with carrier_name_other.
const PAYPAL_CARRIERS = new Set([
  "UPS", "USPS", "FEDEX", "DHL", "TNT", "ROYAL_MAIL", "PARCELFORCE", "AIRBORNE_EXPRESS", "AIRSURE", "SWIFTAIR",
]);
const NOTES_MAX = 2000; // Disputes API: evidence.notes maxLength

type Draft = {
  evidence_type: string;
  evidence_ids: number[];
  carrier: string | null;
  tracking_number: string | null;
  notes: string;
  missing: string[];
  evidence_strength?: "strong" | "medium" | "weak";
  strength_reason?: string;
};

type DraftRow = {
  id: number;
  dispute_id: string;
  event_id: string | null;
  status: string;
  source: string;
  draft_json: string;
  rationale: string | null;
  model: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  submitted_at: string | null;
};

type EvidenceRow = {
  id: number;
  kind: string;
  title: string;
  body: string;
  carrier: string | null;
  tracking_number: string | null;
};

export async function audit(
  env: Env, disputeId: string, draftId: number | null, action: string, actor: string, detail?: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (dispute_id, draft_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(disputeId, draftId, action, actor, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

async function vaultItems(env: Env, ids: number[]): Promise<EvidenceRow[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, kind, title, body, carrier, tracking_number FROM evidence
      WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`
  )
    .bind(...ids)
    .all<EvidenceRow>();
  return results;
}

// Why a draft cannot be approved, in plain words. null means it can be approved.
function blockReason(row: DraftRow, draft: Draft): string | null {
  if (row.status !== "pending") return "This draft is already decided.";
  if (row.source === "saved")
    return "This is a saved draft from an earlier case, shown for reference only. A new draft is made when the daily AI limit resets.";
  if (!draft.evidence_ids.length) return "Needs evidence. This draft does not point to any proof yet.";
  return null;
}

function draftView(row: DraftRow, items: EvidenceRow[]) {
  const draft = JSON.parse(row.draft_json) as Draft;
  return {
    id: row.id,
    dispute_id: row.dispute_id,
    status: row.status,
    source: row.source,
    model: row.model,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    submitted_at: row.submitted_at,
    rationale: row.rationale,
    evidence_type: draft.evidence_type,
    notes: draft.notes,
    missing: draft.missing,
    evidence_strength: draft.evidence_ids.length ? draft.evidence_strength ?? null : "weak",
    strength_reason: draft.evidence_ids.length ? draft.strength_reason ?? null : "No proof is attached yet.",
    evidence: items,
    needs_evidence: draft.evidence_ids.length === 0,
    block_reason: blockReason(row, draft),
  };
}

export async function getDraft(env: Env, draftId: number) {
  const row = await env.DB.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(draftId).first<DraftRow>();
  if (!row) return null;
  const draft = JSON.parse(row.draft_json) as Draft;
  return draftView(row, await vaultItems(env, draft.evidence_ids));
}

export async function getDisputeView(env: Env, disputeId: string) {
  const { results: events } = await env.DB.prepare(
    `SELECT id, event_type, summary, payload, verified, verify_status, received_at, risk_score, risk_reason,
            explanation, next_step, is_demo
       FROM events WHERE resource_id = ? ORDER BY received_at`
  )
    .bind(disputeId)
    .all<Record<string, any>>();
  if (!events.length) return null;

  const latest = JSON.parse(events[events.length - 1].payload).resource ?? {};
  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM drafts WHERE dispute_id = ? ORDER BY id DESC`
  )
    .bind(disputeId)
    .all<DraftRow>();
  const drafts = [];
  for (const r of rows) drafts.push(draftView(r, await vaultItems(env, (JSON.parse(r.draft_json) as Draft).evidence_ids)));

  const { results: trail } = await env.DB.prepare(
    `SELECT id, draft_id, action, actor, detail, at FROM audit_log WHERE dispute_id = ? ORDER BY id`
  )
    .bind(disputeId)
    .all<Record<string, any>>();

  return {
    dispute_id: disputeId,
    is_demo: events.some((e) => e.is_demo === 1),
    reason: latest.reason ?? null,
    status: latest.status ?? null,
    amount: latest.dispute_amount ?? null,
    respond_by: latest.seller_response_due_date ?? null,
    buyer_messages: (latest.messages ?? []).filter((m: any) => m.posted_by === "BUYER").map((m: any) => m.content),
    events: events.map(({ payload, ...e }) => e),
    drafts,
    audit: trail.map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null })),
  };
}

// Constant-time password check: compare SHA-256 digests.
async function passwordOk(env: Env, given: string): Promise<boolean> {
  if (!env.DEMO_PASSWORD) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.DEMO_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Build the PayPal "evidences" payload. Tracking comes from the vault, not from model text.
function buildEvidence(draft: Draft, items: EvidenceRow[], notes: string) {
  const tracking = items
    .filter((i) => i.tracking_number)
    .map((i) => {
      const code = (i.carrier ?? "").toUpperCase().replace(/\s+/g, "_");
      return PAYPAL_CARRIERS.has(code)
        ? { carrier_name: code, tracking_number: i.tracking_number! }
        : { carrier_name: "OTHER", carrier_name_other: i.carrier || "Unknown carrier", tracking_number: i.tracking_number! };
    });
  // PayPal expects evidence_info for PROOF_OF_FULFILLMENT. Without tracking, send notes as OTHER.
  if (draft.evidence_type === "PROOF_OF_FULFILLMENT" && tracking.length) {
    return { evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: tracking }, notes }] };
  }
  return { evidences: [{ evidence_type: "OTHER", notes }] };
}

type Decision = { password?: string; name?: string; notes?: string; reason?: string };

export async function decideDraft(
  env: Env, draftId: number, action: "approve" | "reject", body: Decision
): Promise<{ status: number; body: unknown }> {
  if (!env.DEMO_PASSWORD) return { status: 503, body: { error: "Approvals are not set up on this server." } };
  if (!(await passwordOk(env, body.password ?? ""))) return { status: 401, body: { error: "Wrong password." } };
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) return { status: 400, body: { error: "Please type your name. It goes in the audit trail." } };

  const row = await env.DB.prepare(`SELECT * FROM drafts WHERE id = ?`).bind(draftId).first<DraftRow>();
  if (!row) return { status: 404, body: { error: "Draft not found." } };
  const draft = JSON.parse(row.draft_json) as Draft;

  if (action === "reject") {
    if (row.status !== "pending") return { status: 409, body: { error: "This draft is already decided." } };
    await env.DB.prepare(
      `UPDATE drafts SET status = 'rejected', decided_at = datetime('now'), decided_by = ? WHERE id = ?`
    ).bind(name, draftId).run();
    await audit(env, row.dispute_id, draftId, "rejected", name, { reason: (body.reason ?? "").slice(0, 500) || null });
    return { status: 200, body: { status: "rejected" } };
  }

  const blocked = blockReason(row, draft);
  if (blocked) return { status: 409, body: { error: blocked } };
  const notes = (body.notes ?? draft.notes).trim();
  if (!notes || notes.length > NOTES_MAX)
    return { status: 400, body: { error: `The reply must be 1 to ${NOTES_MAX} characters.` } };

  // Claim the draft atomically so a double click cannot send twice.
  const claimed = await env.DB.prepare(
    `UPDATE drafts SET status = 'approved', decided_at = datetime('now'), decided_by = ?
      WHERE id = ? AND status = 'pending'`
  ).bind(name, draftId).run();
  if (claimed.meta.changes !== 1) return { status: 409, body: { error: "This draft is already decided." } };

  const payload = buildEvidence(draft, await vaultItems(env, draft.evidence_ids), notes);
  await audit(env, row.dispute_id, draftId, "approved", name, { notes_edited: notes !== draft.notes });

  const ev = row.event_id
    ? await env.DB.prepare(`SELECT is_demo FROM events WHERE id = ?`).bind(row.event_id).first<{ is_demo: number }>()
    : null;
  if (ev?.is_demo) {
    await audit(env, row.dispute_id, draftId, "not_sent_demo", "PayHealth", { payload });
    return { status: 200, body: { status: "approved", sent: false, why: "Demo case. Nothing was sent to PayPal.", payload } };
  }

  const result = await submitToPayPal(env, row.dispute_id, payload);
  await env.DB.prepare(
    `UPDATE drafts SET status = ?, submitted_at = datetime('now'), submit_response = ? WHERE id = ?`
  ).bind(result.ok ? "submitted" : "failed", JSON.stringify(result), draftId).run();
  await audit(env, row.dispute_id, draftId, result.ok ? "sent" : "send_failed", "PayHealth", { payload, paypal: result });
  return { status: 200, body: { status: result.ok ? "submitted" : "failed", sent: result.ok, result, payload } };
}

type SubmitResult = { ok: boolean; step: string; http_status?: number; dispute_status?: string; message: string };

async function submitToPayPal(env: Env, disputeId: string, payload: unknown): Promise<SubmitResult> {
  const token = await getAccessToken(env);
  const base = `${env.PAYPAL_API_BASE}/v1/customer/disputes/${encodeURIComponent(disputeId)}`;

  // PayPal accepts evidence only when the dispute shows a provide-evidence link.
  const look = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
  if (!look.ok) {
    return { ok: false, step: "lookup", http_status: look.status, message: "PayPal could not find this dispute. Simulated disputes do not exist in PayPal." };
  }
  const dispute = (await look.json()) as { status?: string; links?: { rel: string }[] };
  if (!dispute.links?.some((l) => l.rel === "provide_evidence" || l.rel === "provide-evidence")) {
    return { ok: false, step: "lookup", dispute_status: dispute.status, message: `PayPal is not asking for evidence on this dispute right now (status: ${dispute.status ?? "unknown"}).` };
  }

  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(payload)], { type: "application/json" }));
  const res = await fetch(`${base}/provide-evidence`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  return {
    ok: res.ok,
    step: "provide_evidence",
    http_status: res.status,
    dispute_status: dispute.status,
    message: res.ok ? "PayPal accepted the evidence." : `PayPal refused the evidence: ${text.slice(0, 300)}`,
  };
}
