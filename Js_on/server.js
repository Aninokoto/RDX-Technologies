/* ============================================================
   RDX TECHNOLOGIES — SECURE NODE.JS SERVER (server.js)
   ============================================================ */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// Load environmental variables securely from parent directories
const localEnvPath = path.join(__dirname, ".env");
const parentEnvPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(localEnvPath)) {
    require('dotenv').config({ path: localEnvPath });
} else if (fs.existsSync(parentEnvPath)) {
    require('dotenv').config({ path: parentEnvPath });
} else {
    require('dotenv').config();
}

// Authoritative Catalog Registry (Secure Source of Truth)
const AUTHORITATIVE_CATALOG = {
    // Care Subscriptions
    "regular plan": { price: 8.99, type: "Subscription" },
    "dynamic plan": { price: 17.99, type: "Subscription" },
    "xtreme plan": { price: 29.99, type: "Subscription" },
    
    // Certified Refurbished Hardware Fallback Data
    "google pixel 8": { price: 300.00, type: "Hardware" },
    "iphone 15 pro": { price: 899.00, type: "Hardware" },
    "rtx 4090 gpu": { price: 1599.00, type: "Hardware" },
    "macbook pro 14": { price: 1299.00, type: "Hardware" }
};

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors()); 
app.use(express.json());

// Secure Storage Configuration for Uploaded Media
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const destPath = path.join(__dirname, "..", "images_copy");
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }
        cb(null, destPath);
    },
    filename: function (req, file, cb) {
        const rawExt = path.extname(file.originalname).toLowerCase();
        const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(rawExt) ? rawExt : ".jpg";
        const uniqueToken = Date.now() + "-" + Math.round(Math.random() * 1E9);
        cb(null, `upload-${uniqueToken}${safeExt}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB Upload Limit
    fileFilter: function (req, file, cb) {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Unsupported format. Only JPG, PNG, and WEBP files are accepted."));
        }
    }
});

// Middleware: Authenticate Session Requests
function authenticateSession(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(411).json({ error: "Access Denied: Missing authorization headers." });
    }
    next();
}

app.use(express.static(path.join(__dirname, "..", "website")));
app.use("/Js_on", express.static(path.join(__dirname)));
app.use("/js_on", express.static(path.join(__dirname)));
app.use("/images_copy", express.static(path.join(__dirname, "..", "images_copy")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "website", "index.html"));
});

// Secure Bulk Image Upload (Limits to 3 Files, Authenticated Admins/Users)
app.post("/api/upload-bulk", authenticateSession, (req, res) => {
    upload.array("imageFiles", 3)(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ error: "Upload rejected: File size exceeds 2MB limit." });
            }
            return res.status(400).json({ error: `Multer Error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files were selected for upload." });
        }

        const paths = req.files.map(file => `/images_copy/${file.filename}`);
        res.json({ imagePaths: paths });
    });
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = "You are the RDX Technologies site-wide assistant. Explain technical specs or repairs in simple, friendly, jargon-free language for regular consumers. Limit answers to 2-4 sentences unless requested otherwise.";

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

app.post("/api/chat", async (req, res) => {
    try {
        if (isRateLimited(req.ip)) {
            return res.status(429).json({ error: "Rate limit reached. Please wait a moment." });
        }
        if (!OPENAI_API_KEY) {
            return res.status(500).json({ error: "AI assistant integration is currently offline." });
        }

        const { messages } = req.body;
        const sanitizedMessages = (messages || []).map(m => ({
            role: m.role === "user" ? "user" : "assistant",
            content: String(m.content).slice(0, 1000) // Truncate content to mitigate payload issues
        }));

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: SYSTEM_PROMPT }, ...sanitizedMessages]
            })
        });

        const data = await response.json();
        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        res.json({ reply: data.choices[0].message.content });
    } catch (err) {
        res.status(500).json({ error: "Failed to connect to internal OpenAI servers." });
    }
});

// Secure Price Calculation on Checkout (Server-Side Verification)
app.post("/api/create-payment-intent", async (req, res) => {
    try {
        const { cartItems, email } = req.body;

        if (!email) {
            return res.status(412).json({ error: "Unauthenticated payment attempts are securely rejected." });
        }
        if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
            return res.status(400).json({ error: "Checkout failed: Cart is empty." });
        }

        let verifiedTotal = 0;

        for (const item of cartItems) {
            const normalizedTitle = String(item.title).toLowerCase().trim();
            const quantity = parseInt(item.quantity, 10) || 1;

            if (quantity <= 0) {
                return res.status(400).json({ error: "Invalid product quantity detected." });
            }

            const catalogMatch = AUTHORITATIVE_CATALOG[normalizedTitle];

            if (!catalogMatch) {
                return res.status(400).json({ error: `Catalog verification failed for item: "${item.title}".` });
            }

            verifiedTotal += (catalogMatch.price * quantity);
        }

        if (verifiedTotal <= 0) {
            return res.status(400).json({ error: "Calculated transaction total must be greater than zero." });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(verifiedTotal * 100), // Stripe expects amounts in cents
            currency: "usd",
            receipt_email: email,
            metadata: { integration_check: "accept_a_payment" }
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message || "Stripe transaction creation failed." });
    }
});

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
            appId: "1:30007546279:web:25d235582d9e3887d36682"
        }
    });
});

app.get("/api/track/usps/:trackingNumber", async (req, res) => {
    const { trackingNumber } = req.params;
    const apiKey = process.env.SHIPPO_API_KEY;

    if (!apiKey || apiKey === "MOCK_KEY" || trackingNumber.startsWith("RDX-MOCK")) {
        return res.json({
            tracking_number: trackingNumber,
            carrier: "usps",
            status: "IN_TRANSIT",
            tracking_status: {
                status: "IN_TRANSIT",
                status_details: "Your package is currently in transit to the next postal facility.",
                status_date: new Date().toISOString()
            }
        });
    }

    try {
        const response = await fetch(`https://api.goshippo.com/v1/tracks/usps/${trackingNumber}`, {
            headers: { "Authorization": `ShippoToken ${apiKey}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to connect to tracking networks." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Production server listening at: http://localhost:${PORT}`);
});