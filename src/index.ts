export interface Env {
  DB: D1Database;
  PAYPAL_API_BASE: string;
  ALLOW_UNVERIFIED_SIMULATOR: string;
  PP_ID: string;
  PP_SECRET: string;
  PAYPAL_WEBHOOK_ID: string;
}

type VerifyResult = { verified: boolean; status: string };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

async function getAccessToken(env: Env): Promise<string> {
  const res = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.PP_ID}:${env.PP_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Ask PayPal to verify the signature. The raw body is spliced in as-is:
// re-serializing the parsed event can change it and break verification.
async function verifySignature(req: Request, rawBody: string, env: Env): Promise<VerifyResult> {
  const h = (name: string) => req.headers.get(name);
  const required = {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
  };
  if (Object.values(required).some((v) => !v)) {
    return { verified: false, status: "ERROR:missing_headers" };
  }
  if (!env.PAYPAL_WEBHOOK_ID) {
    return { verified: false, status: "ERROR:no_webhook_id" };
  }

  const head = JSON.stringify({ ...required, webhook_id: env.PAYPAL_WEBHOOK_ID });
  const body = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;

  try {
    const token = await getAccessToken(env);
    const res = await fetch(`${env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    if (!res.ok) return { verified: false, status: `ERROR:http_${res.status}` };
    const data = (await res.json()) as { verification_status: string };
    return { verified: data.verification_status === "SUCCESS", status: data.verification_status };
  } catch (err) {
    return { verified: false, status: `ERROR:${(err as Error).message}` };
  }
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();
  let event: {
    id?: string;
    event_type?: string;
    resource_type?: string;
    summary?: string;
    resource?: { id?: string; dispute_id?: string };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!event.id || !event.event_type) return json({ error: "not_a_paypal_event" }, 400);

  const v = await verifySignature(req, rawBody, env);
  if (!v.verified && env.ALLOW_UNVERIFIED_SIMULATOR !== "true") {
    return json({ error: "signature_failed", status: v.status }, 401);
  }

  const resourceId = event.resource?.dispute_id ?? event.resource?.id ?? null;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO events
       (id, event_type, resource_type, resource_id, summary, payload, verified, verify_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      event.id,
      event.event_type,
      event.resource_type ?? null,
      resourceId,
      event.summary ?? null,
      rawBody,
      v.verified ? 1 : 0,
      v.status
    )
    .run();

  // Always 200 for stored or duplicate events, so PayPal stops retrying.
  return json({
    stored: result.meta.changes === 1,
    duplicate: result.meta.changes === 0,
    verified: v.verified,
    verify_status: v.status,
  });
}

async function listEvents(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, resource_id, summary, verified, verify_status, received_at,
            risk_score, explanation
       FROM events ORDER BY received_at DESC LIMIT 50`
  ).all();
  return json(results);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "POST" && pathname === "/webhook") return handleWebhook(req, env);
    if (req.method === "GET" && pathname === "/api/events") return listEvents(env);
    if (req.method === "GET" && pathname === "/health") return json({ ok: true });
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
