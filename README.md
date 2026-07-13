# RDX Technologies — Cloud-Integrated Tech Ecosystem

RDX Technologies is a full-stack web application designed for a specialized electronics repair shop and refurbished hardware reseller. The platform is mission-driven, focusing on circular electronics—rescuing discarded hardware, repairing consumer electronics, and extending device lifecycles to reduce e-waste.

This project implements a cloud-connected architecture utilizing **Google Firebase (Cloud Firestore & Authentication)**, an embedded **Stripe Elements** payment engine, and a secure **OpenAI GPT-4o-mini conversational assistant** powered via a custom Node.js proxy server.

---

## 💻 Website Directory & Features

### 1. Customer-Facing Pages
*   **`index.html` (Homepage)**: Presents the shop's mission, an interactive device intake ticker, e-waste metrics, and a step-by-step diagnostic guide.
*   **`services.html` (Care Plans)**: Displays three tiers of monthly repair subscription plans (Regular, Dynamic, Xtreme).
*   **`contact.html` (Support & Bookings)**: Features tabbed forms allowing users to book a physical repair diagnostic slot or submit general inquiries.
*   **`store.html` (Hardware Store)**: Houses refurbished phones, laptops, and components. Includes dynamic category filtering and inspectable product spec modals.

### 2. User Portals & Checkout
*   **`register.html` (Registration)**: A simplified, secure signup page powered by Google Sign-In.
*   **`dashboard.html` (Private Console)**: Displays logged-in user metrics, including total spend, recent order history, and automated e-waste diversion tracking.
*   **`settings.html` (Account Hub)**: Allows logged-in users to manage their profiles, active care plans, and view past receipts.
*   **`checkout.html` (Secure Checkout)**: A clean, multi-step checkout form managing Shipping, Payment, and Order Review.

---

## ⚙️ Core Systems & Integrations

### 1. Google Firebase Cloud Database
*   **Google Sign-In**: Handles registration securely with a single click. Creates a permanent user document in your database.
*   **Cloud-Synced Cart**: Shopping carts are continuously synchronized to the user's Firestore document so they persist across devices.
*   **Order Histories**: Successful checkouts write order documents directly to an `orders` collection.

### 2. Secure OpenAI Proxy Server (`server.js`)
*   **Local Host**: Hosts your website files on `http://localhost:3000`.
*   **CORS & Rate Limiter**: Implements an IP-based request cap of 20 requests per minute to prevent key abuse.
*   **AI Assistant**: Connects to the `gpt-4o-mini` engine to answer questions regarding repair policies, shipping, and technical specifications.

### 3. Stripe Elements
*   Securely embeds credit card input fields inside Step 2 of the custom checkout form, enabling secure tokenization without leaving the page layout.

---

## 🛠️ Technology Stack

*   **Frontend**: HTML5, CSS3, JavaScript (ES6)
*   **Database**: Google Firebase Cloud Firestore, Google Authentication
*   **Backend Server**: Node.js, Express.js, CORS
*   **AI Integration**: OpenAI API (`gpt-4o-mini`)

---

## 🚀 Setup & Installation Instructions

### 1. Install Dependencies
Open your terminal inside the project folder and run:
```bash
npm install# RDX-Technologies
