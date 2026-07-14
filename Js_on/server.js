/* ============================================================
   RDX ASSISTANT & SECURE CONFIGURATION — LOCAL PROXY SERVER
   ------------------------------------------------------------
   This server sits inside your /Js_on folder and performs three jobs:
   1. Hosts your HTML, CSS, and image files on http://localhost:3000.
   2. Acts as a secure, rate-limited proxy between your browser
      and OpenAI's GPT models.
   3. Holds and serves secure configurations dynamically.
============================================================ */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// AUTO-PATHING: Try loading .env from local Js_on folder, fallback to root RDX-Project folder
const localEnvPath = path.join(__dirname, ".env");
const parentEnvPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(localEnvPath)) {
    require('dotenv').config({ path: localEnvPath });
    console.log("📝 Loaded .env configuration from local /Js_on directory.");
} else if (fs.existsSync(parentEnvPath)) {
    require('dotenv').config({ path: parentEnvPath });
    console.log("📝 Loaded .env configuration from parent /RDX-Project directory.");
} else {
    require('dotenv').config(); // Default fallback
    console.warn("⚠️ No .env file detected locally or in parent folders.");
}

// Initialize Stripe with the private key from your .env file
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// Open CORS allows VS Code Live Server and local files to talk to this backend
app.use(cors()); 
app.use(express.json());

// 1. Serve HTML and CSS files from your sibling "/website" folder
app.use(express.static(path.join(__dirname, "..", "website")));

// 2. Case-Sensitivity Safety: Serve your scripts from both uppercase and lowercase paths
app.use("/Js_on", express.static(path.join(__dirname)));
app.use("/js_on", express.static(path.join(__dirname)));

// 3. Serve phone and hardware images from your sibling "/images_copy" folder
app.use("/images_copy", express.static(path.join(__dirname, "..", "images_copy")));

// Force the server to send index.html when opening the home page (Fixes "Cannot GET")
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "website", "index.html"));
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = "You are the RDX Technologies site-wide assistant. You have two jobs: (1) When asked about a specific product, phone, laptop, GPU, or repair plan, explain specs and tech terms in simple, friendly, jargon-free language for shoppers who aren't tech-savvy. (2) For everything else, act as a normal helpful customer service agent for RDX Technologies (a tech repair and refurbished hardware company) — answer questions about orders, repairs, shipping, and general policy in a friendly way, and warmly accept feedback or complaints, acknowledging them and thanking the user for sharing. Keep answers short (2-4 sentences) unless the person asks for more detail. If you don't know something store-specific (like an exact order status), say so honestly and suggest they check their Account Dashboard or the Contact page. you can also choose not to respond to questions that aren't relvent to tech repair or refurbished hardware, and instead politely redirect the user to the Contact page for further assistance. Always be polite, friendly, and helpful.";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestLog = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const entry = requestLog.get(ip) || { count: 0, windowStart: now };

    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        entry.count = 0;
        entry.windowStart = now;
    }

    entry.count += 1;
    requestLog.set(ip, entry);
    return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

// Route to handle AI Chat Widget requests
app.post("/api/chat", async (req, res) => {
    try {
        if (isRateLimited(req.ip)) {
            return res.status(429).json({ error: "You're sending messages a little too fast. Give it a moment and try again." });
        }

        if (!OPENAI_API_KEY) {
            return res.status(500).json({ error: "Missing OPENAI_API_KEY. Set it before starting the server." });
        }

        const { messages } = req.body;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages]
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("OpenAI error:", data.error);
            return res.status(500).json({ error: data.error.message });
        }

        const reply = data.choices[0].message.content;
        res.json({ reply });

    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ error: "Something went wrong on the server." });
    }
});

// Route to securely share config variables with the frontend browser dynamically
app.get("/api/config", (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        firebaseConfig: {
            apiKey: "AIzaSyBocUJuMTrPh6rynHpzLsv-yRU5eNUD41Q",
            authDomain: "gtnbotp-7778a.firebaseapp.com",
            databaseURL: "https://gtnbotp-7778a-default-rtdb.firebaseio.com",
            projectId: "gtnbotp-7778a",
            storageBucket: "gtnbotp-7778a.firebasestorage.app",
            messagingSenderId: "30007546279",
            appId: "1:30007546279:web:25d235582d9e3887d36682",
            measurementId: "G-DM54V040T7"
        }
    });
});

// Route to handle Stripe Secure PaymentIntent generation
app.post("/api/create-payment-intent", async (req, res) => {
    try {
        const { amount, currency, email } = req.body;

        if (!amount) {
            return res.status(400).json({ error: "Missing amount parameters." });
        }

        // Stripe expects amounts in cents ($10.00 = 1000 cents)
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: currency || "usd",
            receipt_email: email,
            metadata: { integration_check: "accept_a_payment" }
        });

        // Send client secret back to frontend browser securely
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error("Stripe payment intent generation failed:", err);
        res.status(500).json({ error: err.message || "Failed to initialize Stripe transaction." });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log("✅ RDX Full-Stack static paths mapped successfully.");
    console.log(`✅ RDX Assistant proxy running at http://localhost:${PORT}`);
    console.log(`   Keep this Terminal window open while you use the checkout page and chat widget.`);
});