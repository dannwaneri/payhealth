// PayHealth dashboard. Plain JS, no build step.
// All text from PayPal events or the AI is inserted with textContent, never as HTML.

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
  return n;
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status, body });
  return body;
}
const params = new URLSearchParams(location.search);

function when(s) {
  if (!s) return "";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function day(s) {
  if (!s) return "";
  return new Date(s).toLocaleDateString(undefined, { dateStyle: "long" });
}
function money(a) {
  return a ? `${a.currency_code} ${a.value}` : "";
}

// ---------- plain-English labels ----------
const EVENT_LABELS = {
  "CUSTOMER.DISPUTE.CREATED": "Buyer opened a dispute",
  "CUSTOMER.DISPUTE.UPDATED": "Dispute was updated",
  "CUSTOMER.DISPUTE.RESOLVED": "Dispute was closed",
  "PAYMENT.CAPTURE.COMPLETED": "Payment received",
  "PAYMENT.CAPTURE.PENDING": "Payment on hold",
  "PAYMENT.CAPTURE.DENIED": "Payment was denied",
  "PAYMENT.CAPTURE.DECLINED": "Payment was declined",
  "PAYMENT.CAPTURE.REFUNDED": "You refunded a payment",
  "PAYMENT.CAPTURE.REVERSED": "Payment was taken back",
  "CHECKOUT.ORDER.APPROVED": "Buyer approved an order",
  "CHECKOUT.ORDER.COMPLETED": "Order completed",
};
function eventLabel(type) {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  const words = type.toLowerCase().split(/[._-]/).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Buyer says the item did not arrive",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Buyer says the item is not as described",
  UNAUTHORISED: "Buyer says they did not make this payment",
  CREDIT_NOT_PROCESSED: "Buyer says a refund was not given",
  DUPLICATE_TRANSACTION: "Buyer says they were charged twice",
  INCORRECT_AMOUNT: "Buyer says the amount is wrong",
};
const EVIDENCE_TYPES = {
  PROOF_OF_FULFILLMENT: "Proof the item was shipped and delivered",
  PROOF_OF_REFUND: "Proof you refunded the buyer",
  OTHER: "Other information",
};
const PAYPAL_STATUS = {
  OPEN: "Open",
  WAITING_FOR_SELLER_RESPONSE: "Waiting for your reply",
  WAITING_FOR_BUYER_RESPONSE: "Waiting for the buyer",
  UNDER_REVIEW: "PayPal is reviewing the case",
  RESOLVED: "Closed",
  OTHER: "Other",
};
const STAGES = {
  INQUIRY: "Stage: buyer's first complaint",
  CHARGEBACK: "Stage: claim, PayPal decides",
};
const DRAFT_STATUS = {
  pending: "Waiting for you",
  approved: "Approved",
  submitted: "Sent to PayPal",
  failed: "Not sent. See the audit trail.",
  rejected: "Rejected",
  replaced: "Replaced by a newer draft",
};
const AUDIT_ACTIONS = {
  drafted: "Draft written",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent to PayPal",
  send_failed: "Sending to PayPal failed",
  not_sent_demo: "Not sent (demo case)",
  not_sent_not_ready: "Not sent: PayPal is not asking for evidence yet",
  proof_added: "Proof added",
  redraft_requested: "New draft requested",
};

// Risk score = the AI's estimate of the chance the seller loses money on this event (0-100).
function riskInfo(score) {
  if (score === null || score === undefined) return { label: "Not rated", cls: "risk-none" };
  if (score >= 70) return { label: `High · ${score}`, cls: "risk-high" };
  if (score >= 40) return { label: `Medium · ${score}`, cls: "risk-medium" };
  return { label: `Low · ${score}`, cls: "risk-low" };
}

// Days until the reply-by date. Negative means past due.
function daysLeft(due) {
  if (!due) return null;
  return Math.ceil((new Date(due).getTime() - Date.now()) / 864e5);
}
function urgencyBadge(due) {
  const d = daysLeft(due);
  if (d === null) return el("span", { class: "badge risk-none", text: "Urgency: check PayPal for the deadline" });
  if (d <= 0) return el("span", { class: "badge risk-high", text: "Urgency: past the reply-by date" });
  const text = `Urgency: ${d} day${d === 1 ? "" : "s"} left`;
  return el("span", { class: `badge ${d < 3 ? "risk-medium" : "tag"}`, text });
}
const STRENGTH = {
  strong: { label: "Evidence: Strong", cls: "risk-low" },
  medium: { label: "Evidence: Medium", cls: "risk-medium" },
  weak: { label: "Evidence: Weak", cls: "risk-high" },
};
function strengthBadge(level) {
  const s = STRENGTH[level] || { label: "Evidence: Not rated", cls: "risk-none" };
  return el("span", { class: `badge ${s.cls}`, text: s.label });
}
const riskBadge = (score) => {
  const r = riskInfo(score);
  return el("span", { class: `badge ${r.cls}`, text: r.label });
};
// Where an event came from. Simulator events cannot be signed by PayPal, so unsigned = simulated here.
function sourceBadge(e) {
  if (e.is_demo) return el("span", { class: "badge tag tag-demo", text: "Demo case (sample data)" });
  if (e.verified) return el("span", { class: "badge tag", text: "Verified by PayPal" });
  return el("span", { class: "badge tag", text: "Simulated (not signed by PayPal)" });
}
const draftKindBadge = (d) =>
  d.source === "saved"
    ? el("span", { class: "badge tag", text: "Saved draft" })
    : el("span", { class: "badge tag", text: "AI draft" });

function showError(where, err) {
  where.replaceChildren(el("div", { class: "notice bad", text: err.message || String(err) }));
}

// ---------- page: event feed ----------
async function initFeed() {
  const detail = $("#detail");
  const demoBtns = [$("#demo"), $("#demo-noproof")];
  const demoMsg = $("#demo-msg");

  for (const btn of demoBtns) {
    btn.addEventListener("click", async () => {
      demoBtns.forEach((b) => (b.disabled = true));
      demoMsg.textContent = "Working. The AI is reading the case. This takes about 10 seconds.";
      try {
        const r = await api(`/api/demo?case=${btn.dataset.case}`, { method: "POST" });
        location.href = `/dispute?id=${encodeURIComponent(r.dispute_id)}`;
      } catch (err) {
        demoMsg.textContent = `Could not load the demo case: ${err.message}`;
        demoBtns.forEach((b) => (b.disabled = false));
      }
    });
  }

  let rows;
  try {
    rows = await api("/api/events");
  } catch (err) {
    return showError($("#grid"), err);
  }
  if (!rows.length) {
    $("#grid").replaceChildren(el("div", { class: "empty", text: "No events yet. Load the demo case, or send a test event from PayPal." }));
    return;
  }

  const isDispute = (r) => r.event_type.startsWith("CUSTOMER.DISPUTE");
  const theme = agGrid.themeQuartz.withParams({
    fontSize: 16,
    fontFamily: "inherit",
    accentColor: "#0f6e6a",
    headerFontWeight: 600,
    rowVerticalPaddingScale: 1.4,
  });

  agGrid.createGrid($("#grid"), {
    theme,
    rowData: rows,
    defaultColDef: { sortable: true, resizable: true, filter: true },
    columnDefs: [
      { headerName: "When", field: "received_at", valueFormatter: (p) => when(p.value), width: 190, sort: "desc" },
      { headerName: "What happened", field: "event_type", valueFormatter: (p) => eventLabel(p.value), flex: 1, minWidth: 200 },
      {
        headerName: "Chance of losing money", field: "risk_score", width: 230,
        headerTooltip: "The AI's estimate, 0 to 100. Strong proof lowers it.",
        cellRenderer: (p) => riskBadge(p.value),
        filterValueGetter: (p) => riskInfo(p.data.risk_score).label.split(" ·")[0],
      },
      { headerName: "Source", field: "verified", width: 280, cellRenderer: (p) => sourceBadge(p.data), filter: false },
      {
        headerName: "Next step", field: "draft_status", width: 200,
        valueGetter: (p) => (isDispute(p.data) ? DRAFT_STATUS[p.data.draft_status] || "No draft yet" : "Nothing to do"),
      },
    ],
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    onRowClicked: (p) => {
      const r = p.data;
      if (isDispute(r) && r.resource_id) {
        location.href = `/dispute?id=${encodeURIComponent(r.resource_id)}`;
        return;
      }
      detail.replaceChildren(
        el("div", { class: "card" },
          el("h2", { text: eventLabel(r.event_type) }),
          el("div", { class: "row" }, riskBadge(r.risk_score), sourceBadge(r)),
          el("h3", { text: "What happened" }),
          el("p", { text: r.explanation || "Not explained yet." }),
          r.next_step ? el("h3", { text: "What to do next" }) : null,
          r.next_step ? el("p", { text: r.next_step }) : null,
          el("p", { class: "muted small", text: `${when(r.received_at)} · PayPal event ${r.id}` }))
      );
      detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  });
}

// ---------- page: dispute view ----------
async function initDispute() {
  const root = $("#dispute");
  const id = params.get("id");
  let v;
  try {
    v = await api(`/api/disputes/${encodeURIComponent(id || "")}`);
  } catch (err) {
    return showError(root, err.status === 404 ? new Error("This dispute was not found.") : err);
  }
  document.title = `Dispute ${v.dispute_id} · PayHealth`;
  const ev = v.events[v.events.length - 1];
  const draft = v.drafts[0];

  // After a reply is sent, nothing is due from the seller until PayPal asks again.
  const sent = draft && draft.status === "submitted";
  const left = daysLeft(v.respond_by);
  const replyBy = v.respond_by
    ? el("dd", {}, day(v.respond_by), " · ",
        el("span", { class: left !== null && left < 3 ? "badge risk-medium" : "", text: left <= 0 ? "past due" : `${left} day${left === 1 ? "" : "s"} left` }))
    : el("dd", { text: "Check the case in PayPal" });

  const summary = el("div", { class: "card" },
    el("div", { class: "row" }, sourceBadge(ev),
      sent ? el("span", { class: "badge risk-low", text: "Reply sent to PayPal" }) : urgencyBadge(v.respond_by),
      strengthBadge(draft?.evidence_strength)),
    el("h2", { style: "margin-top:12px", text: REASONS[v.reason] || "Buyer opened a dispute" }),
    el("dl", { class: "facts" },
      el("dt", { text: "Amount" }), el("dd", { text: money(v.amount) || "Not given" }),
      el("dt", { text: "Reply by" }), replyBy,
      el("dt", { text: "PayPal status" }), el("dd", { text: PAYPAL_STATUS[v.status] || v.status || "Unknown" }),
      el("dt", { text: "Case number" }), el("dd", { text: v.dispute_id })),
    el("h3", { text: "What happened" }),
    el("p", { text: ev.explanation || "Not explained yet." }),
    sent || ev.next_step ? el("h3", { text: "What to do next" }) : null,
    sent
      ? el("p", { text: `Nothing for now. Your reply was sent to PayPal on ${when(draft.submitted_at)}. PayHealth will show PayPal's next step here.` })
      : ev.next_step ? el("p", { text: ev.next_step }) : null,
    v.buyer_messages.length ? el("h3", { text: "What the buyer wrote" }) : null,
    ...v.buyer_messages.map((m) => el("p", { class: "quote", text: m }))
  );
  if (v.is_demo) {
    summary.prepend(el("div", { class: "notice", text: "Demo case. Not from PayPal. The seller, buyer and order are made up, and approving sends nothing." }));
  } else if (!ev.verified) {
    summary.prepend(el("div", { class: "notice warn", text: "PayPal did not sign this message, so PayHealth cannot confirm it is real. Open the case in PayPal and check it before you act." }));
  }

  const draftCard = el("div", { class: "card" });
  if (!draft) {
    draftCard.append(el("h2", { text: "Your reply" }), el("p", { class: "muted", text: "No draft yet." }));
  } else {
    draftCard.append(renderDraft(draft, true));
  }

  const older = v.drafts.slice(1);
  const olderCard = older.length
    ? el("div", { class: "card" }, el("details", {},
        el("summary", { text: `Earlier drafts (${older.length})` }),
        ...older.map((d) => el("div", { style: "margin-top:16px" }, renderDraft(d, false)))))
    : null;

  const trail = el("div", { class: "card" },
    el("h2", { text: "Audit trail" }),
    v.audit.length ? el("ol", { class: "trail" }, ...v.audit.map(renderAudit)) : el("p", { class: "muted", text: "Nothing yet." }));

  root.replaceChildren(summary, draftCard, renderProof(v), olderCard || "", trail);
}

const PROOF_KINDS = {
  tracking: "Tracking or delivery record",
  receipt: "Receipt or invoice",
  communication: "Message to or from the buyer",
  policy: "Shop policy",
  other: "Other proof",
};

// Saved proof for this order, the "Add proof" form, and "Make a new draft".
function renderProof(v) {
  const card = el("div", { class: "card" }, el("h2", { text: "Proof saved for this order" }));
  card.append(v.vault.length
    ? el("ul", { class: "plain" }, ...v.vault.map((e) =>
        el("li", {}, el("strong", { text: `${e.title}` }), ` (${PROOF_KINDS[e.kind] || e.kind}): ${e.body}`)))
    : el("p", { class: "muted", text: "No proof saved yet." }));

  const kind = el("select", { id: "p-kind" },
    ...Object.entries(PROOF_KINDS).map(([k, label]) => el("option", { value: k, text: label })));
  const title = el("input", { type: "text", id: "p-title", maxlength: "120", placeholder: "For example: Courier delivery record" });
  const details = el("textarea", { id: "p-details", maxlength: "1000", placeholder: "What does this proof show? Dates, names, amounts." });
  details.style.minHeight = "120px";
  const carrier = el("input", { type: "text", id: "p-carrier", maxlength: "60", placeholder: "For example: DHL, UPS, or your courier's name" });
  const tracking = el("input", { type: "text", id: "p-tracking", maxlength: "64" });
  const trackingFields = el("div", {},
    el("label", { for: "p-carrier", text: "Carrier" }), carrier,
    el("label", { for: "p-tracking", text: "Tracking number" }), tracking);
  const syncKind = () => (trackingFields.hidden = kind.value !== "tracking");
  kind.addEventListener("change", syncKind);
  syncKind();

  const name = el("input", { type: "text", id: "p-name", autocomplete: "name" });
  const pass = el("input", { type: "password", id: "p-pass", autocomplete: "current-password" });
  const msg = el("div", { "aria-live": "polite" });
  const saveBtn = el("button", { type: "button", text: "Save proof" });
  const redraftBtn = el("button", { type: "button", class: "secondary", text: "Make a new draft with my saved proof" });
  if (!v.can_redraft) redraftBtn.disabled = true;

  const send = async (path, body, btn, busy) => {
    saveBtn.disabled = redraftBtn.disabled = true;
    msg.replaceChildren(el("div", { class: "notice", text: busy }));
    try {
      await api(path, { method: "POST", body: JSON.stringify({ ...body, name: name.value, password: pass.value }) });
      return true;
    } catch (err) {
      showError(msg, err);
      saveBtn.disabled = false;
      redraftBtn.disabled = !v.can_redraft;
      return false;
    }
  };
  const base = `/api/disputes/${encodeURIComponent(v.dispute_id)}`;
  saveBtn.addEventListener("click", async () => {
    const ok = await send(`${base}/evidence`, {
      kind: kind.value, title: title.value, details: details.value, carrier: carrier.value, tracking_number: tracking.value,
    }, saveBtn, "Saving...");
    if (ok) {
      sessionStorage.setItem("ph-msg", "Proof saved. Click \"Make a new draft\" so the reply uses it.");
      location.reload();
    }
  });
  redraftBtn.addEventListener("click", async () => {
    const ok = await send(`${base}/redraft`, {}, redraftBtn, "Writing a new draft. This takes about 10 seconds.");
    if (ok) {
      sessionStorage.setItem("ph-msg", "New draft ready. The old one is marked \"Replaced\".");
      location.reload();
    }
  });

  let flash = null;
  try { flash = sessionStorage.getItem("ph-msg"); sessionStorage.removeItem("ph-msg"); } catch {}
  if (flash) card.prepend(el("div", { class: "notice", text: flash }));

  card.append(
    el("details", { open: !v.vault.length ? true : null },
      el("summary", { text: "Add proof" }),
      el("label", { for: "p-kind", text: "What kind of proof is it?" }), kind,
      el("label", { for: "p-title", text: "Title" }), title,
      el("label", { for: "p-details", text: "Details" }), details,
      trackingFields,
      el("p", { class: "muted small", text: "The AI may only use what you write here. Write facts you can show." })));
  card.append(
    el("label", { for: "p-name", text: "Your name (for the audit trail)" }), name,
    el("label", { for: "p-pass", text: "Approval password" }), pass,
    el("div", { class: "actions" }, saveBtn, redraftBtn),
    msg);
  if (!v.can_redraft) {
    msg.before(el("p", { class: "muted small", text: "Your reply for this stage was already sent. PayHealth drafts again when PayPal asks for more." }));
  }
  return card;
}

function renderDraft(d, withAction) {
  const box = el("div", {},
    el("div", { class: "row" }, draftKindBadge(d), el("span", { class: "badge tag", text: DRAFT_STATUS[d.status] || d.status }),
      d.stage ? el("span", { class: "badge tag", text: STAGES[d.stage] || d.stage }) : null),
    el("h2", { style: "margin-top:12px", text: "Your reply to PayPal" }),
    el("p", { class: "muted", text: EVIDENCE_TYPES[d.evidence_type] || d.evidence_type }),
    el("div", { class: "reply", text: d.notes }));

  if (d.evidence.length) {
    box.append(el("h3", { text: "Proof this reply uses" }),
      el("ul", { class: "plain" }, ...d.evidence.map((e) => el("li", {}, el("strong", { text: `${e.title}: ` }), e.body))));
  }
  if (d.missing.length) {
    box.append(el("h3", { text: d.needs_evidence ? "Add this proof first" : "Proof that would make it stronger" }),
      el("ul", { class: "plain" }, ...d.missing.map((m) => el("li", { text: m }))));
  }
  if (d.strength_reason) box.append(el("p", {}, strengthBadge(d.evidence_strength), " ", d.strength_reason));
  if (d.rationale) box.append(el("p", { class: "muted small", text: `Why this proof: ${d.rationale}` }));

  if (withAction && d.status === "pending") {
    box.append(el("p", { class: "muted", text: "Nothing is sent until you approve." }));
    if (d.block_reason) {
      box.append(el("div", { class: `notice ${d.needs_evidence ? "warn" : ""}`, text: d.block_reason }),
        el("div", { class: "actions" }, el("button", { disabled: true, text: "Review and approve" })));
    } else {
      box.append(el("div", { class: "actions" },
        el("button", { type: "button", onclick: () => (location.href = `/approve?draft=${d.id}`), text: "Review and approve" })));
    }
  }
  return box;
}

function renderAudit(a) {
  const li = el("li", {},
    el("strong", { text: AUDIT_ACTIONS[a.action] || a.action }),
    el("span", { class: "muted small", text: `${when(a.at)} · by ${a.actor}` }));
  const d = a.detail || {};
  if (a.action === "approved" && d.notes_edited) li.append(el("div", { class: "small", text: "The reply was edited before approval." }));
  if (a.action === "proof_added" && d.title) li.append(el("div", { class: "small", text: `${PROOF_KINDS[d.kind] || d.kind}: ${d.title}` }));
  if (a.action === "rejected" && d.reason) li.append(el("div", { class: "small", text: `Reason: ${d.reason}` }));
  if (d.paypal?.message) li.append(el("div", { class: "small", text: d.paypal.message }));
  if (d.payload) {
    li.append(el("details", {},
      el("summary", { text: a.action === "not_sent_demo" ? "What would have been sent" : "What was sent" }),
      el("pre", { text: JSON.stringify(d.payload, null, 2) })));
  }
  return li;
}

// ---------- page: approve ----------
async function initApprove() {
  const root = $("#approve");
  const draftId = params.get("draft");
  let d, v;
  try {
    d = await api(`/api/drafts/${encodeURIComponent(draftId || "")}`);
    v = await api(`/api/disputes/${encodeURIComponent(d.dispute_id)}`);
  } catch (err) {
    return showError(root, err.status === 404 ? new Error("This draft was not found.") : err);
  }
  const back = `/dispute?id=${encodeURIComponent(d.dispute_id)}`;
  $("#back").href = back;

  const notes = el("textarea", { id: "notes", maxlength: "2000" });
  notes.value = d.notes;
  const count = el("div", { class: "muted small", "aria-live": "polite" });
  const updateCount = () => (count.textContent = `${notes.value.length} of 2000 characters`);
  notes.addEventListener("input", updateCount);
  updateCount();

  const name = el("input", { type: "text", id: "name", autocomplete: "name" });
  const pass = el("input", { type: "password", id: "pass", autocomplete: "current-password" });
  const result = el("div", { "aria-live": "polite" });
  const approveBtn = el("button", { text: v.is_demo ? "Approve (demo, nothing is sent)" : "Approve and send to PayPal" });
  const rejectBtn = el("button", { class: "secondary", text: "Reject this draft" });

  const decide = async (action) => {
    approveBtn.disabled = rejectBtn.disabled = true;
    result.replaceChildren(el("div", { class: "notice", text: action === "approve" ? "Sending..." : "Saving..." }));
    try {
      const body = { name: name.value, password: pass.value };
      if (action === "approve") body.notes = notes.value;
      if (action === "reject") body.reason = prompt("Why are you rejecting it? (optional)") || "";
      const r = await api(`/api/drafts/${d.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
      const msg =
        r.status === "rejected" ? "Rejected. Nothing was sent." :
        r.status === "submitted" ? "Sent. PayPal accepted the evidence." :
        r.status === "failed" ? `Approved, but PayPal did not accept it. ${r.result?.message || ""}` :
        r.status === "not_ready" ? `Nothing was sent. ${r.result?.message || ""} The draft is still waiting for you.` :
        r.why || "Approved.";
      result.replaceChildren(
        el("div", { class: `notice ${r.status === "failed" ? "bad" : ""}`, text: msg }),
        el("a", { class: "button secondary", href: back, text: "See the audit trail" }));
    } catch (err) {
      showError(result, err);
      approveBtn.disabled = !!d.block_reason;
      rejectBtn.disabled = false;
    }
  };
  approveBtn.addEventListener("click", () => decide("approve"));
  rejectBtn.addEventListener("click", () => decide("reject"));
  if (d.block_reason) approveBtn.disabled = true;
  if (d.status !== "pending") approveBtn.disabled = rejectBtn.disabled = true;

  root.replaceChildren(
    el("div", { class: "card" },
      el("div", { class: "row" }, draftKindBadge(d), v.is_demo ? el("span", { class: "badge tag tag-demo", text: "Demo case (sample data)" }) : null),
      el("h2", { style: "margin-top:12px", text: REASONS[v.reason] || "Dispute" }),
      el("p", { class: "muted", text: `${money(v.amount)} · Case ${d.dispute_id}${v.respond_by ? ` · Reply by ${day(v.respond_by)}` : ""}` }),
      v.is_demo ? el("div", { class: "notice", text: "Demo case. Approving it records your decision but sends nothing to PayPal." }) : null,
      d.block_reason ? el("div", { class: "notice warn", text: d.block_reason }) : null,
      el("label", { for: "notes", text: "Your reply to PayPal (you can edit it)" }),
      notes, count,
      d.evidence.length ? el("h3", { text: "Proof attached" }) : null,
      d.evidence.length ? el("ul", { class: "plain" }, ...d.evidence.map((e) => el("li", { text: e.title }))) : null,
      d.missing.length ? el("h3", { text: d.needs_evidence ? "Add this proof first" : "Proof that would make it stronger" }) : null,
      d.missing.length ? el("ul", { class: "plain" }, ...d.missing.map((m) => el("li", { text: m }))) : null,
      el("label", { for: "name", text: "Your name (for the audit trail)" }), name,
      el("label", { for: "pass", text: "Approval password" }), pass,
      el("div", { class: "actions" }, approveBtn, rejectBtn),
      result)
  );
}

// ---------- start ----------
const page = document.body.dataset.page;
({ feed: initFeed, dispute: initDispute, approve: initApprove })[page]?.();
