# PayHealth

PayHealth helps small online sellers keep their PayPal money. It starts **at the sale**, not when a dispute arrives: for every payment it shows which proof to keep (tracking, postage receipt, photos, buyer messages, terms), saves it, and can send the tracking number to PayPal. If the buyer later opens a dispute, the AI drafts the reply from that proof, and a person approves it before PayHealth sends it to PayPal.

*A seller should never lose a payment because the proof was not ready.*

Built for the PayPal AI Hackathon. **Sandbox only. No real money moves.**

## Try it in 2 minutes (for judges)

**Live demo:** https://payhealth.fpl-test.workers.dev
**Approval password:** in the submission's testing notes on Devpost. No PayPal or AI account is needed.

1. Click **Load a demo sale**. A made-up paid order opens with an empty proof checklist.
2. Save one or two items, for example a tracking number (any carrier and number) and a postage receipt. Type any name and the password. The checklist count goes up.
3. Click **Buyer opens a dispute (demo)**. Wait about 10 seconds. The dispute page opens, and the reply is already drafted from the proof you saved, so you can approve it straight away.
4. Click **Review and approve**, then **Approve (demo, nothing is sent)**. The audit trail shows who did what, when, and the exact payload.
5. To see the safety rule, go back home and click **Load demo case (no proof saved)**. The draft is marked **Needs evidence** and Approve is blocked. Add proof on that page and click **Make a new draft** to unlock it.
6. Real PayPal sandbox records: the [payment 9W907734NT218004L](https://payhealth.fpl-test.workers.dev/payment?id=9W907734NT218004L) (signed by PayPal) and its [dispute PP-R-GDA-10196082](https://payhealth.fpl-test.workers.dev/dispute?id=PP-R-GDA-10196082), where PayPal accepted the evidence twice (HTTP 200).

Demo sales and demo cases are made up and labeled everywhere. Each click creates its own order, so your test never affects another judge's.

## How this meets the judging criteria

| Criterion | Open this | What it shows | In the code |
|---|---|---|---|
| Technological Implementation | [Real dispute PP-R-GDA-10196082](https://payhealth.fpl-test.workers.dev/dispute?id=PP-R-GDA-10196082), its audit trail | Signed PayPal webhooks, evidence accepted by the Disputes API twice (HTTP 200), one draft per dispute stage. Rules in code: no proof, no approval; the AI can cite only saved proof; nothing is sent twice. 47 tests. | `src/disputes.ts`, `src/agent.ts`, `test/payhealth.test.ts` |
| Design | [Home page](https://payhealth.fpl-test.workers.dev), then **Load a demo sale** | A proof checklist in plain words, risk labels with text (not only color), and an approve page that works on a phone. | `public/index.html`, `public/payment.html`, `public/approve.html` |
| Potential Impact | [Real sale 9W907734NT218004L](https://payhealth.fpl-test.workers.dev/payment?id=9W907734NT218004L) | The seller saves proof while it still exists, and the tracking number goes to PayPal (HTTP 201). PayPal's docs link tracking to seller protection and faster access to funds (source in [What it does](#what-it-does)). | `src/payments.ts`, `src/tracking.ts` |
| Innovation | Load a demo sale, save proof, then **Buyer opens a dispute (demo)** | The proof saved at the sale is already in the first dispute draft, so the seller does not search for it later. | `src/payments.ts`, `src/agent.ts` (test: "puts proof saved after the sale into the vault of a later dispute") |
| Presentation | The demo video (linked on Devpost) and the [proof table](#proof-every-claim-how-it-was-shown-where-to-check-it) below | Each claim, how it was shown, and where to check it yourself. | `README.md` |

## What it does

**Before a dispute.** When a payment arrives, its page shows a proof checklist for that sale: tracking (with signature confirmation), postage receipt, photos of the item and packing, messages with the buyer, and shop terms. Proof saved here is stored against the payment. If a dispute opens later, the first draft already has it.

A tracking number can also be sent to PayPal from the same form (Orders v2 `POST /v2/checkout/orders/{id}/track`). PayPal's developer docs say to send shipment tracking numbers "for faster access to funds, seller protection, and quicker resolution of payment holds" ([Integrate package tracking](https://developer.paypal.com/docs/tracking/orders-api/integrate/)). The result (sent, or PayPal's error) is shown on the proof item and in the payment's audit trail. Demo sales never send anything.

This follows advice sellers give each other. In a public r/Watches thread on selling with PayPal Goods & Services ([link](https://www.reddit.com/r/Watches/comments/1xa1s5e/selling_on_reddit_is_paypal_buying_goods_risky/)), the top reply lists "item never arrived" claims among the most likely problems, and says many sellers skip documenting the sale and then have nothing to prove their case.

**When a dispute opens:**

1. PayPal sends a webhook to the Worker for each account event.
2. The Worker asks PayPal to verify the signature, then stores the event in D1.
3. An AI (Claude Haiku 5.5) writes "What happened" and "What to do next", and estimates the chance of losing money (0 to 100). Strong proof lowers it.
4. For a new dispute, the AI drafts a reply. It may use only items from the seller's evidence vault (tracking, receipts, emails, policies). Tracking numbers sent to PayPal come from the vault, not from AI text.
5. A draft that points to no proof is marked **Needs evidence** and cannot be approved.
6. The seller reads the draft, can edit it, and approves it with a name and password.
7. The Worker checks the dispute with the PayPal Disputes API and submits the evidence.
8. Every step is written to an audit trail: who approved, when, and exactly what was sent.

## Proof: every claim, how it was shown, where to check it

Real runs are on the PayPal **sandbox** (3 Nov 2026). "Test" means the automated tests in [`test/payhealth.test.ts`](test/payhealth.test.ts) (`npm test`, no keys, no network). "Demo" means made-up data, labeled on every screen.

| Claim | How it was shown | Check it |
|---|---|---|
| A buyer paid a real sandbox order | Real sandbox: capture `9W907734NT218004L`, USD 24.00, COMPLETED | [Payment page](https://payhealth.fpl-test.workers.dev/payment?id=9W907734NT218004L) |
| PayPal's messages are signature-checked | Real sandbox: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED` and `UPDATED` all returned SUCCESS from PayPal's verify call | [Event list](https://payhealth.fpl-test.workers.dev/), "Verified by PayPal" label |
| Tracking saved at the sale reaches PayPal | Real sandbox: `POST /v2/checkout/orders/{id}/track` returned **HTTP 201** | [Payment page](https://payhealth.fpl-test.workers.dev/payment?id=9W907734NT218004L), "Sent to PayPal" on the UPS item |
| PayPal accepted PayHealth's evidence (first complaint) | Real sandbox: `provide-evidence` returned **HTTP 200** after approval by a named person | [Dispute PP-R-GDA-10196082](https://payhealth.fpl-test.workers.dev/dispute?id=PP-R-GDA-10196082), audit trail |
| PayPal asked again when the case became a claim, and accepted again | Real sandbox: we escalated the case with the Disputes API `escalate` call to test the claim stage; PayHealth wrote a new draft for that stage; `provide-evidence` returned **HTTP 200** | Same dispute, second "Sent to PayPal" entry |
| The draft cites only the seller's proof | Real sandbox draft cites the three vault items (sample proof labeled "sandbox test"); test: unknown evidence ids are dropped | Dispute page, "Proof this reply uses" |
| No proof, no reply | Test (server refuses approval) + demo | Home → **Load demo case (no proof saved)** |
| Proof saved at the sale is used when a dispute opens later | Test + demo | Home → **Load a demo sale**, save proof, **Buyer opens a dispute (demo)** |
| Nothing is sent twice, and nothing is sent when PayPal is not asking | Tests (PayPal stubbed) | `npm test` |
| A move of the reply-by date is shown | Test; our real case moved from 23 Nov to 13 Nov when it became a claim | `npm test` (the real case is now under review, so PayPal no longer shows a date) |

The proof items in the real dispute are sample data we created for the sandbox test, labeled "(sandbox test)" in the app. No real money moved.

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

**What each key is for when you run it locally:**

| Key in `.dev.vars` | Needed for | Without it |
|---|---|---|
| `DEMO_PASSWORD` | Approve, reject, add proof, new draft | Those actions say "not set up on this server". |
| `ANTHROPIC_API_KEY` | The AI: explanations, risk, evidence strength, reply drafts | Demo cases load, but there is no explanation and no draft. The dispute page says the AI is not set up. |
| `PP_ID`, `PP_SECRET`, `PAYPAL_WEBHOOK_ID` | Real PayPal webhooks and sending evidence to PayPal | Demo cases still work (they never call PayPal). |

To try the AI without your own Anthropic key, use the hosted demo. `npm test` needs none of these keys.

## Tests

```bash
npm test
```

47 tests run inside the Workers runtime with a local D1 database and the real migrations (via Cloudflare's Vitest integration). They need no PayPal or AI keys and make no network calls: PayPal is stubbed where a test needs it.

They cover the rules the product depends on:

- Webhook: rejects non-JSON and non-PayPal bodies, stores unsigned simulator events as unverified, ignores duplicates, refuses unsigned events when the simulator switch is off.
- Plain-code guards: drafts that cite no proof are blocked and rated Weak; evidence ids the vault does not hold are dropped; saved drafts cannot be approved; a draft cannot be approved twice.
- One draft per dispute stage: a new draft when PayPal asks again at a new stage, never twice for the same stage, never while one is pending.
- Daily AI cap stops at the limit.
- Submission: nothing is sent when PayPal is not asking for evidence (the draft stays waiting); when it is, the evidence goes out as the multipart `input` part with tracking from the vault, and unknown carriers are sent as `OTHER` with `carrier_name_other`.
- Seller actions: proof validation, proof stays inside one case, each demo click gets its own order, redraft refused after the reply was sent.
- Reply-by date: a move is reported when an inquiry becomes a claim, with no false alarms for unchanged dates, small differences, or events with no date.
- Proof before a dispute: the payment checklist marks saved items, and proof saved on a payment is in the vault of a later dispute for that payment.
- Tracking to PayPal: the Orders v2 request goes to the payment's order with the right carrier fields and a request id per proof item; a refusal is recorded without losing the proof; nothing is sent when the box is unticked or for a demo sale.

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
| `POST /api/demo-sale` | Make a demo sale (made-up paid order). |
| `POST /api/payments/:id/demo-dispute` | Demo sales only: the buyer opens a dispute for this sale. |
| `GET /api/payments/:id` | One payment: proof checklist, saved proof, disputes for it, audit trail. |
| `POST /api/payments/:id/evidence` | Same body as dispute evidence, plus optional `send_to_paypal: "true"` for tracking items. Saves proof for this payment before any dispute. |
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
- **Simulated disputes do not exist in PayPal.** They cannot receive evidence. The full path (see "Proof: every claim") needs a real sandbox dispute on a completed payment.
- **PayPal accepts evidence only at some stages.** The Worker submits only when PayPal's dispute details include a `provide_evidence` link. Otherwise it sends nothing, keeps the draft waiting, and writes PayPal's status to the audit trail. In our test the link was present as soon as the buyer opened the case.
- **One draft per dispute stage.** When an inquiry becomes a claim and PayPal asks for evidence again, PayHealth writes a new draft for the claim. Other dispute events update the explanation and risk only. The seller can also ask for a new draft after adding proof, until the reply for that stage is approved.
- **Proof is text.** The seller describes each item (title, details, carrier and tracking number). Files such as photos or PDFs are not uploaded or sent to PayPal.
- **One shared approval password.** This is a demo control, not user accounts.

## License

MIT. See [LICENSE](LICENSE).
