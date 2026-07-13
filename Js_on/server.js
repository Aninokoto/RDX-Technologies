/* ============================================================
   RDX ASSISTANT — LOCAL PROXY SERVER (for ChatGPT / OpenAI)
   ------------------------------------------------------------
   This server sits inside your /Js_on folder and performs two jobs:
   1. Hosts your HTML, CSS, and image files on http://localhost:3000.
   2. Acts as a secure, rate-limited proxy between your browser
      and OpenAI's GPT models.
============================================================ */

require('dotenv').config(); // Loads OPENAI_API_KEY from the .env file in /Js_on
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

// 1. Serve HTML and CSS files from your sibling "/website" folder
app.use(express.static(path.join(__dirname, "..", "website")));

// 2. Serve JavaScript files from your current "/Js_on" folder
app.use("/Js_on", express.static(path.join(__dirname)));

// 3. Serve phone and hardware images from your sibling "/images copy" folder
app.use("/images copy", express.static(path.join(__dirname, "..", "images copy")));

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

const PORT = 3000;
app.listen(PORT, () => {
    console.log("✅ RDX Full-Stack static paths mapped successfully.");
    console.log(`✅ RDX Assistant proxy running at http://localhost:${PORT}`);
    console.log(`   Keep this Terminal window open while you use the chat widget.`);
});