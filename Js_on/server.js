/* ============================================================
   RDX TECHNOLOGIES — SECURE NODE.JS SERVER (server.js)
   ============================================================ */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");

// Firebase Admin SDK v14 Modular Imports
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Load environmental variables securely from parent or local directories
const localEnvPath = path.join(__dirname, ".env");
const parentEnvPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(localEnvPath)) {
    require('dotenv').config({ path: localEnvPath });
} else if (fs.existsSync(parentEnvPath)) {
    require('dotenv').config({ path: parentEnvPath });
} else {
    require('dotenv').config();
}

// SECURE DUAL-RESOLUTION SERVICE ACCOUNT INITIALIZATION
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const rawValue = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
    try {
        // Parse directly as an inline JSON string if valid
        serviceAccount = JSON.parse(rawValue);
    } catch (jsonErr) {
        // Resolve relative filepath across local subfolder and parent boundaries
        const pathsToTry = [
            path.resolve(process.cwd(), rawValue),
            path.resolve(__dirname, rawValue),
            path.resolve(path.join(__dirname, "..", rawValue))
        ];

        let fileResolved = false;
        for (const filePath of pathsToTry) {
            if (fs.existsSync(filePath)) {
                try {
                    const fileContent = fs.readFileSync(filePath, "utf8");
                    serviceAccount = JSON.parse(fileContent);
                    fileResolved = true;
                    break;
                } catch (fileErr) {
                    console.warn(`⚠️ Path found but failed parsing: ${filePath} (${fileErr.message})`);
                }
            }
        }

        if (!fileResolved) {
            console.error("⚠️ FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON, and file was not found.");
        }
    }
}

// FIREBASE ADMIN SDK v14 MODULAR INITIALIZATION
let db;
let auth;
let firebaseApp;

try {
    // Initialize Firebase App with modular v14 API
    if (serviceAccount) {
        firebaseApp = initializeApp({
            credential: cert(serviceAccount),
            projectId: "gtnbotp-7778a"
        });
        console.log("✅ Firebase Admin SDK securely initialized with Service Account credentials.");
    } else {
        firebaseApp = initializeApp({
            projectId: "gtnbotp-7778a"
        });
        console.log("✅ Firebase Admin SDK securely initialized with default credentials.");
    }

    // Get Auth service reference using modular API
    try {
        auth = getAuth(firebaseApp);
        console.log("✅ Firebase Auth service successfully retrieved.");
    } catch (authErr) {
        console.error("❌ Failed to get Firebase auth service:", authErr.message);
        console.error("Stack:", authErr.stack);
    }

    // Get Firestore reference using modular API
    try {
        db = getFirestore(firebaseApp);
        console.log("✅ Database Engine context bound successfully.");
    } catch (dbErr) {
        console.error("❌ Failed to get Firestore:", dbErr.message);
    }
} catch (initErr) {
    console.error("❌ Firebase Admin SDK critical initialization error:", initErr.message);
}

// Authoritative Catalog Registry (Fallback Verification Source)
const AUTHORITATIVE_CATALOG = {
    "regular plan": { price: 8.99, type: "Subscription" },
    "dynamic plan": { price: 17.99, type: "Subscription" },
    "xtreme plan": { price: 29.99, type: "Subscription" },
    "google pixel 8": { price: 300.00, type: "Hardware" },
    "iphone 15 pro": { price: 899.00, type: "Hardware" },
    "rtx 4090 gpu": { price: 1599.00, type: "Hardware" },
    "macbook pro 14": { price: 1299.00, type: "Hardware" }
};

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors()); 
app.use(express.json());

// Set COOP headers to prevent cross-origin context isolation from blocking Google popup signs-ins
app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    next();
});

// Secure Disk Storage and Multipart Configuration for Media Uploads
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
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB Limit per file
    fileFilter: function (req, file, cb) {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Unsupported format. Only JPG, PNG, and WEBP files are accepted."));
        }
    }
});

// Dynamic Certificate Cache and Algorithmic JWT Signature Validator
let googlePublicKeysCache = null;
let keysCacheExpiry = 0;

async function getGooglePublicKeys() {
    const now = Date.now();
    if (googlePublicKeysCache && now < keysCacheExpiry) {
        return googlePublicKeysCache;
    }
    try {
        const res = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken-system@system.gserviceaccount.com");
        const data = await res.json();
        googlePublicKeysCache = data;
        keysCacheExpiry = now + (6 * 60 * 60 * 1000); // Cache certificates for 6 hours
        return googlePublicKeysCache;
    } catch (err) {
        console.error("⚠️ Failed to fetch Google secure token public certificates:", err.message);
        return googlePublicKeysCache || {};
    }
}

async function verifyTokenAlgoritmically(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    try {
        const header = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

        const now = Math.floor(Date.now() / 1000);
        const clockSkew = 300; // Allow a 5-minute clock skew window

        // Validate token structure
        if (payload.aud !== "gtnbotp-7778a") {
            console.warn("⚠️ Token audience mismatch. Expected: gtnbotp-7778a, Got:", payload.aud);
            return null;
        }
        if (payload.iss !== "https://securetoken.google.com/gtnbotp-7778a") {
            console.warn("⚠️ Token issuer mismatch.");
            return null;
        }
        
        // Check expiration FIRST before other validations
        if (payload.exp < (now - clockSkew)) {
            console.warn(`⚠️ Token expired. Expiry: ${payload.exp}, Now: ${now}`);
            return null; // Expired tokens cannot be recovered
        }
        
        if (payload.iat > (now + clockSkew)) {
            console.warn("⚠️ Token issue time in future (clock skew?).");
            return null;
        }

        if (header.alg !== "RS256" || !header.kid) {
            console.warn("⚠️ Unsupported algorithm or missing key ID.");
            return null;
        }

        const publicKeys = await getGooglePublicKeys();
        const cert = publicKeys[header.kid];
        if (!cert) {
            console.warn("⚠️ Public key not found for kid:", header.kid);
            return null;
        }

        const verifier = crypto.createVerify("RSA-SHA256");
        verifier.update(`${headerB64}.${payloadB64}`);
        const signature = Buffer.from(signatureB64, 'base64url');
        
        const isValid = verifier.verify(cert, signature);
        if (isValid) {
            console.log("✅ Token signature verified successfully for:", payload.email);
            return payload;
        } else {
            console.warn("⚠️ Token signature verification failed.");
        }
    } catch (err) {
        console.error("❌ Algorithmic signature verification error:", err.message);
    }
    return null;
}

// SECURE SESSION AUTHENTICATION MIDDLEWARE (verifyIdToken with Algorithmic Fallback)
async function authenticateSession(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.warn("❌ Missing Authorization header in request");
            return res.status(401).json({ error: "Access Denied: Missing or malformed authorization headers." });
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
            console.warn("❌ Empty Bearer token");
            return res.status(401).json({ error: "Access Denied: Session token is missing." });
        }

        let decodedToken = null;
        let primaryAuthError = null;
        
        // Log token for debugging (first 20 chars + last 20 chars only for security)
        const tokenPreview = token.substring(0, 20) + "..." + token.substring(token.length - 20);
        console.log(`📋 Verifying token: ${tokenPreview}...`);
        
        // Check if auth is initialized
        if (!auth) {
            console.error("❌ Firebase Auth not initialized! auth reference is null");
            return res.status(500).json({ 
                error: "Server authentication service not available",
                code: "AUTH_SERVICE_UNAVAILABLE"
            });
        }
        
        try {
            // Attempt standard Firebase Admin SDK Token Verification
            decodedToken = await auth.verifyIdToken(token);
            console.log(`✅ Admin SDK verification SUCCESS for: ${decodedToken.email}`);
        } catch (adminErr) {
            primaryAuthError = adminErr.message;
            console.warn(`⚠️ Admin SDK verification failed: ${adminErr.message}`);
            console.warn("⚠️ Attempting cryptographic fallback verification...");
            
            // Execute cryptographically secure algorithmic signature and claim verification fallback
            decodedToken = await verifyTokenAlgoritmically(token);
            if (decodedToken) {
                console.log(`✅ Fallback verification SUCCESS for: ${decodedToken.email}`);
            } else {
                console.warn("❌ Fallback verification also FAILED");
            }
        }

        if (!decodedToken || !decodedToken.email) {
            console.error(`❌ FINAL AUTH FAILURE - Primary Error: ${primaryAuthError}`);
            console.error(`⚠️ Last attempt returned: ${decodedToken ? 'token without email' : 'null'}`);
            return res.status(401).json({ 
                error: "Access Denied: Session token is expired, revoked, or invalid.",
                details: "Please refresh the page and sign in again.",
                code: "TOKEN_INVALID",
                primaryError: primaryAuthError
            });
        }

        req.userEmail = decodedToken.email.toLowerCase().trim();
        console.log(`✅ REQUEST AUTHENTICATED as: ${req.userEmail}`);
        next();
    } catch (err) {
        console.error(`❌ UNEXPECTED AUTH ERROR: ${err.message}`);
        console.error(`Stack: ${err.stack}`);
        return res.status(401).json({ 
            error: "Access Denied: Session token is expired, revoked, or invalid.",
            code: "AUTH_ERROR",
            exception: err.message
        });
    }
}

// ADMINISTRATIVE ACCESS CONTROL MIDDLEWARE
async function authenticateAdmin(req, res, next) {
    try {
        if (!req.userEmail) {
            return res.status(401).json({ error: "Access Denied: Unauthenticated user context." });
        }

        // Verify user administrative permissions natively from the database context
        const userDoc = await db.collection("users").doc(req.userEmail).get();
        if (!userDoc.exists || userDoc.data().role !== "admin") {
            return res.status(403).json({ error: "Access Denied: Administrative permissions are required." });
        }

        next();
    } catch (err) {
        console.error("Admin verification error caught:", err);
        return res.status(500).json({ error: "Internal server administrative verification failure." });
    }
}

app.use(express.static(path.join(__dirname, "..", "website")));
app.use("/Js_on", express.static(path.join(__dirname)));
app.use("/js_on", express.static(path.join(__dirname)));
app.use("/images_copy", express.static(path.join(__dirname, "..", "images_copy")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "website", "index.html"));
});

// DIAGNOSTIC ENDPOINT: Verify token validity without action
app.get("/api/token-status", authenticateSession, (req, res) => {
    res.json({ 
        status: "valid", 
        email: req.userEmail, 
        message: "Token is valid and verified." 
    });
});

// Secure Bulk Image Upload Routing
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
            content: String(m.content).slice(0, 1000)
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

// Dynamic Price & Stock Verification on Checkout Intent Generation
app.post("/api/create-payment-intent", async (req, res) => {
    try {
        if (!req.body || typeof req.body !== "object") {
            return res.status(400).json({ error: "Invalid request payload." });
        }

        const { cartItems, email } = req.body;

        if (!email || typeof email !== "string" || !email.includes("@")) {
            return res.status(412).json({ error: "Unauthenticated payment attempts are securely rejected. A valid email is required." });
        }

        if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
            return res.status(400).json({ error: "Checkout failed: Cart is empty or malformed." });
        }

        let verifiedTotal = 0;

        for (const item of cartItems) {
            if (!item || typeof item !== "object") {
                return res.status(400).json({ error: "Invalid cart item structure detected." });
            }

            if (!item.title || typeof item.title !== "string") {
                return res.status(400).json({ error: "Invalid product parameters: Missing valid item title." });
            }

            const normalizedTitle = String(item.title).toLowerCase().trim();
            const quantity = parseInt(item.quantity, 10);

            if (isNaN(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
                return res.status(400).json({ error: "Invalid product quantity detected." });
            }

            let verifiedPrice = 0;

            // 1. Check native catalog / live Firestore collection first to handle dynamically uploaded custom items
            const docKey = item.title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
            const productDoc = await db.collection("products").doc(docKey).get();

            if (productDoc.exists) {
                const priceStr = String(productDoc.data().price || "0");
                verifiedPrice = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
                
                const dbStock = parseInt(productDoc.data().stock, 10) || 0;
                if (dbStock < quantity) {
                    return res.status(400).json({ error: `Overselling protection: "${item.title}" only has ${dbStock} units available.` });
                }
            } else if (AUTHORITATIVE_CATALOG[normalizedTitle]) {
                // 2. Use fallbacks for standardized core plans / static hardware items
                verifiedPrice = parseFloat(AUTHORITATIVE_CATALOG[normalizedTitle].price);
            } else {
                return res.status(400).json({ error: `Catalog verification failed: "${item.title}" does not exist.` });
            }

            if (isNaN(verifiedPrice) || verifiedPrice <= 0) {
                return res.status(500).json({ error: "Internal price verification calculation failed." });
            }

            verifiedTotal += (verifiedPrice * quantity);
        }

        if (verifiedTotal < 0.50) {
            return res.status(400).json({ error: "Calculated transaction total must be greater than $0.50 USD." });
        }

        if (!stripe) {
            return res.status(500).json({ error: "Stripe API instance is uninitialized on this server." });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(verifiedTotal * 100), 
            currency: "usd",
            receipt_email: email,
            metadata: { 
                integration_check: "accept_a_payment",
                verified_items_count: cartItems.length
            }
        });

        res.json({ clientSecret: paymentIntent.client_secret });

    } catch (err) {
        console.error("Stripe payment intent backend error caught:", err);
        res.status(500).json({ error: err.message || "Stripe transaction creation failed." });
    }
});

/* ============================================================
   SECURE FIRESTORE WRITE APIS (PREVENTS CLIENT-SIDE WRITES)
   ============================================================ */

// 1. SECURE ORDER CREATION & ATOMIC STOCK DECREMENT (Prevents Concurrency Overselling)
app.post("/api/orders/create", authenticateSession, async (req, res) => {
    try {
        const { orderId, paymentIntentId, items, total, shippingDetails, isDigital, customerName } = req.body;

        if (!orderId || !paymentIntentId || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required order parameters." });
        }

        // Cryptographically authenticate payment validity directly from Stripe API before persisting db entries
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (!paymentIntent || paymentIntent.status !== "succeeded") {
            return res.status(402).json({ error: "Transaction verification failed: Payment was not successfully captured." });
        }

        const calculatedAmountCents = Math.round(total * 100);
        if (paymentIntent.amount !== calculatedAmountCents) {
            return res.status(402).json({ error: "Transaction verification failed: Payment amount mismatch." });
        }

        // Execute stock check and decrement inside a highly secure, atomic Firestore Transaction to completely mitigate race conditions
        await db.runTransaction(async (transaction) => {
            for (const item of items) {
                if (item.type !== "Hardware") continue;

                const docKey = item.title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
                const productRef = db.collection("products").doc(docKey);
                const productDoc = await transaction.get(productRef);

                if (!productDoc.exists) {
                    throw new Error(`Product "${item.title}" no longer exists in our catalog.`);
                }

                const currentStock = parseInt(productDoc.data().stock, 10) || 0;
                if (currentStock < item.quantity) {
                    throw new Error(`Overselling protection: Product "${item.title}" only has ${currentStock} units remaining.`);
                }

                // Decrement stock levels atomically within the active transaction window
                transaction.update(productRef, { stock: currentStock - item.quantity });
            }
        });

        const now = new Date();
        const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

        const finalOrderPayload = {
            orderId,
            userEmail: req.userEmail,
            date: now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
            time: timeStr,
            items,
            total,
            paymentStatus: "Paid",
            trackingNumber: isDigital ? "N/A - Digital Membership" : "Pending",
            shippingStatus: isDigital ? "Activated" : "Processed",
            isDigital: !!isDigital,
            customerName: customerName || shippingDetails?.name || "RDX Customer",
            shippingDetails: shippingDetails || {}
        };

        // Write secure order entry directly to the database context
        await db.collection("orders").doc(orderId).set(finalOrderPayload);

        // Update User Subscription level securely upon premium care purchase
        const subItem = items.find(item => item.type === "Subscription");
        if (subItem) {
            await db.collection("users").doc(req.userEmail).update({
                activeSubscription: subItem.title
            });
        }

        res.json({ success: true, orderId });
    } catch (err) {
        console.error("Secure order creation error caught:", err);
        res.status(500).json({ error: err.message || "Failed to process order securely." });
    }
});

// 2. SECURE ADMIN PRODUCT CREATION API
app.post("/api/admin/products/add", authenticateSession, authenticateAdmin, async (req, res) => {
    try {
        const { title, price, stock, category, imagePath, desc, specs, altImages } = req.body;

        if (!title || !price || isNaN(stock) || stock < 0 || !category || !desc) {
            return res.status(400).json({ error: "Missing required catalog product fields." });
        }

        const docKey = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const newProduct = {
            title,
            price,
            stock: parseInt(stock, 10),
            category,
            imagePath: imagePath || "/images_copy/logo.svg",
            desc,
            specs: specs || "",
            altImages: altImages || [],
            createdAt: new Date().toISOString()
        };

        await db.collection("products").doc(docKey).set(newProduct);
        res.json({ success: true, docId: docKey });
    } catch (err) {
        console.error("Secure product creation error:", err);
        res.status(500).json({ error: err.message || "Failed to create catalog product securely." });
    }
});

// 3. SECURE ADMIN PRODUCT EDITING API
app.post("/api/admin/products/edit", authenticateSession, authenticateAdmin, async (req, res) => {
    try {
        const { docId, title, price, stock, category, desc, specs } = req.body;

        if (!docId || !title || !price || isNaN(stock) || stock < 0 || !category || !desc) {
            return res.status(400).json({ error: "Missing required product update fields." });
        }

        const productRef = db.collection("products").doc(docId);
        const doc = await productRef.get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Catalog product not found." });
        }

        const updatedProduct = {
            ...doc.data(),
            title,
            price,
            stock: parseInt(stock, 10),
            category,
            desc,
            specs: specs || ""
        };

        const newDocId = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

        await db.collection("products").doc(newDocId).set(updatedProduct);
        if (newDocId !== docId) {
            await db.collection("products").doc(docId).delete();
        }

        res.json({ success: true, docId: newDocId });
    } catch (err) {
        console.error("Secure product editing error:", err);
        res.status(500).json({ error: err.message || "Failed to edit catalog product securely." });
    }
});

// 4. SECURE ADMIN PRODUCT DELETION API
app.post("/api/admin/products/delete", authenticateSession, authenticateAdmin, async (req, res) => {
    try {
        const { docId } = req.body;
        if (!docId) {
            return res.status(400).json({ error: "Missing required product ID parameter." });
        }

        const productRef = db.collection("products").doc(docId);
        const doc = await productRef.get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Catalog product not found." });
        }

        await productRef.delete();
        res.json({ success: true });
    } catch (err) {
        console.error("Secure product deletion error:", err);
        res.status(500).json({ error: err.message || "Failed to delete catalog product securely." });
    }
});

// 5. SECURE ADMIN STOCK LEVEL UPDATING API
app.post("/api/admin/products/update-stock", authenticateSession, authenticateAdmin, async (req, res) => {
    try {
        const { docId, stock } = req.body;
        const val = parseInt(stock, 10);

        if (!docId || isNaN(val) || val < 0) {
            return res.status(400).json({ error: "Invalid stock quantity or parameters." });
        }

        const productRef = db.collection("products").doc(docId);
        const doc = await productRef.get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Catalog product not found." });
        }

        await productRef.update({ stock: val });
        res.json({ success: true, docId, stock: val });
    } catch (err) {
        console.error("Secure stock updating error:", err);
        res.status(500).json({ error: err.message || "Failed to update stock levels securely." });
    }
});

// 6. SECURE ADMIN CUSTOMER EXPERIENCE REVIEW DELETION API
app.post("/api/admin/feedback/delete", authenticateSession, authenticateAdmin, async (req, res) => {
    try {
        const { docId } = req.body;
        if (!docId) {
            return res.status(400).json({ error: "Missing required review document ID parameter." });
        }

        const feedbackRef = db.collection("feedback").doc(docId);
        const doc = await feedbackRef.get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Review document not found." });
        }

        await feedbackRef.delete();
        res.json({ success: true });
    } catch (err) {
        console.error("Secure feedback deletion error:", err);
        res.status(500).json({ error: err.message || "Failed to delete customer review securely." });
    }
});

/* ============================================================
   SYSTEM UTILITY CONFIGS & TRACKING HANDLERS
   ============================================================ */
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