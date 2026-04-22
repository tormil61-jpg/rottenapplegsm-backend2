require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow requests from your live site and local testing
app.use(cors({
  origin: [
    "https://www.rottenapplegsm.com",
    "https://rottenapplegsm.com",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
    // Netlify preview URLs
    /\.netlify\.app$/,
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Rotten Apple GSM backend running" });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRIPE
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/stripe/create-payment-intent
// Called by the frontend before showing the Stripe card form.
// Returns a clientSecret the browser uses to mount Stripe Elements.
app.post("/api/stripe/create-payment-intent", async (req, res) => {
  try {
    const { amount, orderId, description, email } = req.body;

    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }
    if (amount > 10000) {
      return res.status(400).json({ error: "Amount exceeds maximum." });
    }

    // Stripe amounts are in cents
    const amountCents = Math.round(parseFloat(amount) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amountCents,
      currency: "usd",
      description: description || "Carrier Unlock Service",
      receipt_email: email || undefined,
      metadata: {
        orderId:  orderId  || "",
        site:     "rottenapplegsm.com",
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe create-payment-intent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook
// Optional but recommended — Stripe calls this after payment to confirm.
// Set your webhook secret in .env as STRIPE_WEBHOOK_SECRET.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig    = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    // Webhook not configured — just acknowledge
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook error" });
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    console.log("Payment succeeded:", pi.id, "$" + (pi.amount / 100).toFixed(2));
    // TODO: mark order as paid in your database
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAYPAL
// ══════════════════════════════════════════════════════════════════════════════

// PayPal uses fetch-based REST API (v2 Orders)
const PAYPAL_BASE = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

async function getPayPalToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PayPal credentials not configured.");
  }

  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get PayPal token.");
  return data.access_token;
}

// POST /api/paypal/create-order
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount, description } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount." });
    }

    const token = await getPayPalToken();

    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: {
            currency_code: "USD",
            value: parseFloat(amount).toFixed(2),
          },
          description: description || "Carrier Unlock Service",
        }],
        application_context: {
          brand_name:          "Rotten Apple GSM",
          landing_page:        "NO_PREFERENCE",
          user_action:         "PAY_NOW",
          return_url:          "https://www.rottenapplegsm.com",
          cancel_url:          "https://www.rottenapplegsm.com",
          shipping_preference: "NO_SHIPPING",
        },
      }),
    });

    const data = await response.json();
    if (!data.id) throw new Error(data.message || "Failed to create PayPal order.");
    res.json({ id: data.id });
  } catch (err) {
    console.error("PayPal create-order error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/paypal/capture-order
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    if (!paypalOrderId) return res.status(400).json({ error: "Missing paypalOrderId." });

    const token = await getPayPalToken();

    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });

    const data = await response.json();
    if (data.status !== "COMPLETED") {
      throw new Error("PayPal capture not completed. Status: " + data.status);
    }

    console.log("PayPal payment captured:", paypalOrderId);
    res.json({ status: data.status });
  } catch (err) {
    console.error("PayPal capture-order error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Rotten Apple GSM backend running on port ${PORT}`);
});
