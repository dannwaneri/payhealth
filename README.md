# PayHealth

PayHealth watches a PayPal seller account and explains each event in plain words. When a buyer opens a dispute, it drafts the seller's reply from proof the seller has already saved. A person must approve the reply before it is sent to PayPal.

Built for the PayPal AI Hackathon. **Sandbox only. No real money moves.**

## What it does

1. PayPal sends a webhook to the Worker for each account event.
2. The Worker asks PayPal to verify the signature, then stores the event in D1.
3. An AI (Claude Haiku 5.5) writes "What happened" and "What to do next", and estimates the chance of losing money (0 to 100). Strong proof lowers it.
4. For a new dispute, the AI drafts a reply. It may use only items from the seller's evidence vault (tracking, receipts, emails, policies). Tracking numbers sent to PayPal come from the vault, not from AI text.
5. A draft that points to no proof is marked **Needs evidence** and cannot be approved.
6. The seller reads the draft, can edit it, and approves it with a name and password.
7. The Worker checks the dispute with the PayPal Disputes API and submits the evidence.
8. Every step is written to an audit trail: who approved, when, and exactly what was sent.

## How to test

### Hosted demo (fastest)

Open the hosted URL listed in the submission. The approval password is in the submission's testing notes.

1. On the home page, click **Load demo case**. Wait about 10 seconds.
   - This stores a made-up dispute (a fabric order that "did not arrive") and runs it through the same pipeline as a real webhook.
   - The demo case is labeled "Demo case (sample data)" on every screen.
2. On the dispute page, read the explanation, the risk label and the drafted reply. Check the "Proof this reply uses" list against the reply text.
3. Click **Review and approve**. Edit the reply if you want, type your name and the password, and click **Approve (demo, nothing is sent)**.
4. Go back to the dispute. The audit trail shows your approval and the exact payload that would go to PayPal.
5. To see a refused approval, open a dispute marked **Needs evidence**. The Approve button is disabled, and the server also refuses it.

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
| `POST /api/demo` | Load the demo case. |
| `GET /api/selfcheck` | Configuration check (booleans only). |

## AI tools used

- **Claude Haiku 5.5 (Anthropic API)** runs inside the product. One call per event returns structured JSON: category, plain-English explanation, risk score and reason, and for new disputes a reply draft that cites vault item IDs. Code drops any cited ID that is not in the vault. Calls are capped per day.
- **Claude Code (Anthropic)** was used to write and test the code.

## Known limits

- **Simulator events cannot be verified.** PayPal's Webhooks Simulator page says simulator events cannot be verified. PayHealth stores them with `verified = 0` and labels them "simulated".
- **Simulated disputes do not exist in PayPal.** Approving one records the decision, then the PayPal lookup fails and the audit trail says why. A full submission needs a real sandbox dispute on a completed payment.
- **PayPal accepts evidence only at some stages.** The Worker submits only when PayPal's dispute details include a provide-evidence link. Otherwise it records the dispute status and sends nothing.
- **No file uploads yet.** Evidence is sent as tracking info and notes. Documents (receipts, photos) are not attached.
- **One shared approval password.** This is a demo control, not user accounts.

## License

MIT. See [LICENSE](LICENSE).
