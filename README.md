# PayHealth

PayHealth watches a PayPal seller account and explains each event in plain words. When a buyer opens a dispute, it drafts the seller's reply from proof the seller has already saved. A person must approve the reply before it is sent to PayPal.

Built for the PayPal AI Hackathon. **Sandbox only. No real money moves.**

## Try it in 2 minutes (for judges)

**Live demo:** https://payhealth.fpl-test.workers.dev
**Approval password:** in the submission's testing notes on Devpost. No PayPal or AI account is needed.

1. Click **Load demo case (no proof saved)**. Wait about 10 seconds. The draft is marked **Needs evidence** and **Approve is blocked**, because the seller has saved no proof.
2. Under **Add proof**, pick "Tracking or delivery record", fill in a title, details, carrier and tracking number, type any name and the password, and click **Save proof**.
3. Click **Make a new draft with my saved proof**. The new draft cites only your proof, the evidence is rated Strong, and Approve unlocks.
4. Click **Review and approve**, then **Approve (demo, nothing is sent)**. The audit trail shows who did what, when, and the exact payload.
5. To see a real PayPal case, open [dispute PP-R-GDA-10196082](https://payhealth.fpl-test.workers.dev/dispute?id=PP-R-GDA-10196082). It shows signed PayPal events and two submissions that PayPal accepted (HTTP 200).

Demo cases are made up and labeled "Demo case" everywhere. Each click creates its own order, so your test never affects another judge's.

## What it does

1. PayPal sends a webhook to the Worker for each account event.
2. The Worker asks PayPal to verify the signature, then stores the event in D1.
3. An AI (Claude Haiku 5.5) writes "What happened" and "What to do next", and estimates the chance of losing money (0 to 100). Strong proof lowers it.
4. For a new dispute, the AI drafts a reply. It may use only items from the seller's evidence vault (tracking, receipts, emails, policies). Tracking numbers sent to PayPal come from the vault, not from AI text.
5. A draft that points to no proof is marked **Needs evidence** and cannot be approved.
6. The seller reads the draft, can edit it, and approves it with a name and password.
7. The Worker checks the dispute with the PayPal Disputes API and submits the evidence.
8. Every step is written to an audit trail: who approved, when, and exactly what was sent.

## Tested end to end (our own sandbox run, 3 Nov 2026)

| Step | Result |
|---|---|
| Buyer pays a sandbox order | Capture `9W907734NT218004L`, USD 24.00, COMPLETED |
| PayPal webhooks for the payment | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`: signature check SUCCESS |
| Buyer opens an "item not received" case | Dispute `PP-R-GDA-10196082` |
| PayPal webhooks for the dispute | `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`: signature check SUCCESS |
| AI draft | Evidence: Strong. Cites only the three vault items (marked "sandbox test"). |
| Human approval | Name and time recorded in the audit trail |
| Submit to PayPal | `POST /v1/customer/disputes/{id}/provide-evidence` returned HTTP 200 |

The vault items for this test are sample data we created for the sandbox. They are labeled "(sandbox test)" in the app.

## How to test

### Hosted demo (fastest)

Open the hosted URL listed in the submission. The approval password is in the submission's testing notes.

1. On the home page, click **Load demo case (with proof)**. Wait about 10 seconds.
   - This stores a made-up dispute (a fabric order that "did not arrive") and runs it through the same pipeline as a real webhook.
   - The demo case is labeled "Demo case (sample data)" on every screen.
2. On the dispute page, read the explanation, the risk label and the drafted reply. Check the "Proof this reply uses" list against the reply text.
3. Click **Review and approve**. Edit the reply if you want, type your name and the password, and click **Approve (demo, nothing is sent)**.
4. Go back to the dispute. The audit trail shows your approval and the exact payload that would go to PayPal.
5. Go back to the home page and click **Load demo case (no proof saved)**. The seller saved nothing for this order, so the draft is marked **Needs evidence**, the evidence is rated Weak, and Approve is disabled. The server also refuses it.
6. On the same page, open **Add proof**. Pick "Tracking or delivery record", give it a title, details, carrier and tracking number, type your name and the password, and click **Save proof**.
7. Click **Make a new draft with my saved proof**. The old draft is marked "Replaced", the new one cites your proof, and Approve unlocks. The audit trail shows "Proof added" and "New draft requested" with your name.

Each demo click gets its own order, so proof you add to one demo case never appears in another.

### Send a test event from PayPal

1. In the PayPal developer dashboard, open **Testing Tools → Webhooks Simulator**.
2. Enter the Worker URL plus `/webhook`, pick **Customer dispute created**, and click **Send test**.
3. Refresh the PayHealth home page. The event shows as "Simulated (not signed by PayPal)" with a risk label and a draft.

### Make a real sandbox dispute

Simulated disputes do not exist in PayPal, so they cannot receive evidence. To test the full path:

1. Run `node scripts/sandbox-checkout.mjs` with `PP_ID` and `PP_SECRET` set to the sandbox app that owns the webhook.
2. Open the link it prints and pay with a sandbox **personal** account. PayPal returns you to a page that says "Payment approved".
3. Press Enter in the terminal. The script captures the payment and prints the transaction ID.
4. Log in to the sandbox site as the same personal account, open the payment, and report a problem: "item not received".
5. The dispute event arrives in PayHealth signed by PayPal ("Verified by PayPal").
6. A new "not received" case starts at the inquiry stage, where PayPal may not accept evidence yet. If you approve then, PayHealth sends nothing and the audit trail shows PayPal's status. To move the case forward from the seller side, use the sandbox helper:

   ```bash
   node scripts/sandbox-dispute.mjs list
   node scripts/sandbox-dispute.mjs escalate <dispute-id>
   node scripts/sandbox-dispute.mjs seller-evidence <dispute-id>
   ```

   `seller-evidence` and `settle` use sandbox-only PayPal routes (`require-evidence`, `adjudicate`).

### Self-check

`GET /api/selfcheck` returns true/false for: PayPal credentials work, the webhook ID exists in PayPal, the webhook URL points at this Worker, and the AI key is set. It never returns IDs or keys.

## Labels on screen

| Label | Meaning |
|---|---|
| Verified by PayPal | PayPal's verify-webhook-signature API returned SUCCESS. |
| Simulated (not signed by PayPal) | The event failed signature verification. In the sandbox this is the Webhooks Simulator, which PayPal says cannot be verified. |
| Demo case (sample data) | Made-up data from the Load demo case button. Never sent to PayPal. |
| AI draft / Saved draft | A saved draft appears when the daily AI limit is reached. It is shown for reference and cannot be approved. |
| Chance of losing money: Low / Medium / High | The AI's estimate: below 40 / 40 to 69 / 70 and above. Strong proof lowers it. Always shown as text, not only color. |
| Urgency: N days left | Days until PayPal's reply-by date. Amber under 3 days, red when past due. |
| Evidence: Strong / Medium / Weak | How well the saved proof answers the buyer's claim. A draft with no proof is always Weak and cannot be approved. |

## Run it yourself

You need Node.js 20 or later, a Cloudflare account, a PayPal developer account with a sandbox app, and an Anthropic API key.

```bash
npm install
npx wrangler d1 create payhealth
```

Put the new `database_id` in `wrangler.jsonc`. Then:

```bash
npx wrangler d1 migrations apply payhealth --remote
npx wrangler deploy
npx wrangler secret put PP_ID
npx wrangler secret put PP_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DEMO_PASSWORD
```

In your PayPal sandbox app, add a webhook with the URL `https://<your-worker>.workers.dev/webhook` and select the dispute and payment events. Copy its webhook ID, then:

```bash
npx wrangler secret put PAYPAL_WEBHOOK_ID
```

Open `https://<your-worker>.workers.dev/api/selfcheck`. All four values should be `true`.

**Local development:** copy `.dev.vars.example` to `.dev.vars`, fill it in, then run `npm run db:local` and `npm run dev`. The dashboard is at http://localhost:8799.

## Tests

```bash
npm test
```

32 tests run inside the Workers runtime with a local D1 database and the real migrations (via Cloudflare's Vitest integration). They need no PayPal or AI keys and make no network calls: PayPal is stubbed where a test needs it.

They cover the rules the product depends on:

- Webhook: rejects non-JSON and non-PayPal bodies, stores unsigned simulator events as unverified, ignores duplicates, refuses unsigned events when the simulator switch is off.
- Plain-code guards: drafts that cite no proof are blocked and rated Weak; evidence ids the vault does not hold are dropped; saved drafts cannot be approved; a draft cannot be approved twice.
- One draft per dispute stage: a new draft when PayPal asks again at a new stage, never twice for the same stage, never while one is pending.
- Daily AI cap stops at the limit.
- Submission: nothing is sent when PayPal is not asking for evidence (the draft stays waiting); when it is, the evidence goes out as the multipart `input` part with tracking from the vault, and unknown carriers are sent as `OTHER` with `carrier_name_other`.
- Seller actions: proof validation, proof stays inside one case, each demo click gets its own order, redraft refused after the reply was sent.

We checked that the tests catch real mistakes by breaking three rules on purpose (the pending-draft check, the "Needs evidence" block, the carrier mapping). Five tests failed, and all passed again after the code was restored.

## Settings

| Name | Where | Purpose |
|---|---|---|
| `PAYPAL_API_BASE` | `wrangler.jsonc` | Sandbox API. Do not change. |
| `ALLOW_UNVERIFIED_SIMULATOR` | `wrangler.jsonc` | `"true"` stores unsigned events (labeled simulated). `"false"` rejects them with 401. |
| `AI_DAILY_CAP` | `wrangler.jsonc` | Max AI calls per UTC day. Default 50. |
| `PP_ID`, `PP_SECRET` | secret | PayPal sandbox app credentials. |
| `PAYPAL_WEBHOOK_ID` | secret | Used to verify webhook signatures. |
| `ANTHROPIC_API_KEY` | secret | For Claude Haiku 5.5. |
| `DEMO_PASSWORD` | secret | Required to approve or reject a draft. |

## API

| Route | Purpose |
|---|---|
| `POST /webhook` | PayPal webhook receiver. |
| `GET /api/events` | Latest events with explanation and risk. |
| `GET /api/disputes/:id` | One dispute: events, drafts, audit trail. |
| `GET /api/drafts/:id` | One draft with the evidence it uses. |
| `POST /api/drafts/:id/approve` | Body: `name`, `password`, optional edited `notes`. |
| `POST /api/drafts/:id/reject` | Body: `name`, `password`, optional `reason`. |
| `POST /api/disputes/:id/evidence` | Body: `name`, `password`, `kind`, `title`, `details`, optional `carrier`, `tracking_number`. Saves proof for this dispute's payment. |
| `POST /api/disputes/:id/redraft` | Body: `name`, `password`. Writes a new draft from the saved proof; the pending one is marked "Replaced". |
| `POST /api/demo` | Load the demo case with proof. `?case=no-proof` loads the case with no proof saved. |
| `POST /api/events/:id/recheck` | Body: `password`. Run the AI on an event again (counts toward the daily cap). |
| `GET /api/selfcheck` | Configuration check (booleans only). |

## AI tools used

- **Claude Haiku 5.5 (Anthropic API)** runs inside the product. One call per event returns structured JSON: category, plain-English explanation, risk score and reason, and for new disputes a reply draft that cites vault item IDs. Code drops any cited ID that is not in the vault. Calls are capped per day.
- **Claude Code (Anthropic)** was used to write and test the code.

## Known limits

- **Simulator events cannot be verified.** PayPal's Webhooks Simulator page says simulator events cannot be verified. PayHealth stores them with `verified = 0` and labels them "simulated".
- **Simulated disputes do not exist in PayPal.** They cannot receive evidence. The full path (see "Tested end to end") needs a real sandbox dispute on a completed payment.
- **PayPal accepts evidence only at some stages.** The Worker submits only when PayPal's dispute details include a `provide_evidence` link. Otherwise it sends nothing, keeps the draft waiting, and writes PayPal's status to the audit trail. In our test the link was present as soon as the buyer opened the case.
- **One draft per dispute stage.** When an inquiry becomes a claim and PayPal asks for evidence again, PayHealth writes a new draft for the claim. Other dispute events update the explanation and risk only. The seller can also ask for a new draft after adding proof, until the reply for that stage is approved.
- **Proof is text.** The seller describes each item (title, details, carrier and tracking number). Files such as photos or PDFs are not uploaded or sent to PayPal.
- **One shared approval password.** This is a demo control, not user accounts.

## License

MIT. See [LICENSE](LICENSE).
