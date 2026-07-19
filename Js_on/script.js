/* ============================================================
   RDX TECHNOLOGIES — MASTER CONTROL SCRIPT (DEBUGGED)
   Full rewrite with stock sync, order history, tier fixes
   ============================================================ */

let db = null; 
let localCartState = [];
let activeSlideImages = [];
let currentSlideIndex = 0;
let checkoutCurrentStep = 1;
let stripeInstance = null;
let cardNumElement = null, cardExpiryElement = null, cardCvcElement = null;
let allAdminOrders = [];
let activeAdminFilterStatus = "all";
let activeAdminEditProductId = null;
let chatHistory = [];
let stockWatcherUnsubscribe = null; // Firebase listener cleanup

const GUEST_MESSAGE_LIMIT = 3;
let dynamicStoreCatalogCache = {};

/* ============================================================
   CART PERSISTENCE (LocalStorage + Cloud Sync)
   ============================================================ */
function saveCartToLocalStorage() {
    const suffix = getActiveUserSuffix();
    if (suffix) {
        try {
            localStorage.setItem("rdx_cart" + suffix, JSON.stringify(localCartState));
        } catch (e) { console.error("LocalStorage cart save failed:", e); }
    }
}

function loadCartFromLocalStorage() {
    const suffix = getActiveUserSuffix();
    if (suffix) {
        try {
            const saved = localStorage.getItem("rdx_cart" + suffix);
            localCartState = saved ? JSON.parse(saved) : [];
        } catch (e) {
            console.error("LocalStorage cart load failed:", e);
            localCartState = [];
        }
    } else { 
        localCartState = []; 
    }
}

async function syncCartToDatabase() {
    if (!db) return;
    const session = localStorage.getItem("rdx_session");
    if (!session) return;
    try {
        await db.collection("users").doc(JSON.parse(session).email).update({ cart: localCartState });
    } catch (err) { console.error("Failed to sync cart to database:", err); }
}

async function fetchCartFromDatabase() {
    if (!db) return [];
    const session = localStorage.getItem("rdx_session");
    if (!session) return [];
    try {
        const doc = await db.collection("users").doc(JSON.parse(session).email).get();
        if (doc.exists) return doc.data().cart || [];
    } catch (err) { console.error("Failed to load cloud cart:", err); }
    return [];
}

async function getActiveSubscription() {
    const session = localStorage.getItem("rdx_session");
    if (!session) return "";

    const suffix = getActiveUserSuffix();
    let activeSub = suffix ? localStorage.getItem("rdx_active_subscription" + suffix) || "" : "";

    if (db) {
        try {
            const user = JSON.parse(session);
            const doc = await db.collection("users").doc(user.email).get();
            if (doc.exists) {
                activeSub = doc.data().activeSubscription || "";
                if (suffix) {
                    if (activeSub) localStorage.setItem("rdx_active_subscription" + suffix, activeSub);
                    else localStorage.removeItem("rdx_active_subscription" + suffix);
                }
            }
        } catch (err) {
            console.error("Failed to load active subscription:", err);
        }
    }

    return activeSub;
}

/* ============================================================
   REAL-TIME STOCK MONITORING (Auto-Remove OOS Items)
   ============================================================ */
function setupStockWatcher() {
    if (!db) return;
    
    // Clean up previous listener
    if (stockWatcherUnsubscribe) {
        stockWatcherUnsubscribe();
    }

    // Listen to ALL products collection for stock changes
    stockWatcherUnsubscribe = db.collection("products").onSnapshot(
        (snapshot) => {
            snapshot.forEach((doc) => {
                const product = doc.data();
                const stockLevel = parseInt(product.stock, 10) || 0;
                
                // Check if this product is in user's cart
                const cartItemIndex = localCartState.findIndex(
                    item => item.title === product.title
                );

                if (cartItemIndex > -1) {
                    // Hold sold-out cart items instead of deleting them, so they can reactivate when stock returns.
                    if (stockLevel <= 0) {
                        if (!localCartState[cartItemIndex].outOfStockHold) {
                            localCartState[cartItemIndex].outOfStockHold = true;
                            saveCartToLocalStorage();
                            syncCartToDatabase();
                            updateCartUI();
                            showToast(`Notice: "${localCartState[cartItemIndex].title}" is temporarily sold out and held in your cart.`);
                            if (window.location.pathname.includes("checkout.html")) renderCheckoutPage();
                        }
                    } else {
                        if (localCartState[cartItemIndex].outOfStockHold) {
                            localCartState[cartItemIndex].outOfStockHold = false;
                            saveCartToLocalStorage();
                            syncCartToDatabase();
                            updateCartUI();
                            showToast(`Success: "${product.title}" is back in stock and restored in your cart.`);
                            if (window.location.pathname.includes("checkout.html")) renderCheckoutPage();
                        }
                        if (localCartState[cartItemIndex].quantity > stockLevel) {
                            localCartState[cartItemIndex].quantity = stockLevel;
                            saveCartToLocalStorage();
                            syncCartToDatabase();
                            updateCartUI();
                        }
                    }
                    if (stockLevel > 0 && localCartState[cartItemIndex].quantity > stockLevel) {
                        showToast(`Notice: Limited stock available. Only ${stockLevel} remaining for "${product.title}".`);
                    }
                }
            });
        },
        (error) => {
            console.error("Stock watcher error:", error);
        }
    );
}

/* ============================================================
   GLOBAL STOCK LIMIT PROTECTION ENGINE (Task 1)
   ============================================================ */
async function fetchStockLimit(title) {
    if (db) {
        try {
            const docKey = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
            const doc = await db.collection("products").doc(docKey).get();
            if (doc.exists) {
                return parseInt(doc.data().stock, 10) || 0;
            }
        } catch (e) {
            console.error("Could not fetch stock limit:", e);
        }
    }
    return 99; // Fallback if DB is unavailable
}

async function addToCart(title, price, type, details, imagePath = null) {
    if (!localStorage.getItem("rdx_session")) {
        showToast("Access required. Please sign in to add items.");
        openSigninDrawer();
        return;
    }

    // If adding a subscription, remove other subscriptions
    if (type === "Subscription") {
        localCartState = localCartState.filter(item => item.type !== "Subscription");
    }

    // Global Stock Protection Checks (Task 1)
    if (type === "Hardware") {
        const stockLevel = await fetchStockLimit(title);
        const cartItem = localCartState.find(item => item.title === title);
        const currentQtyInCart = cartItem ? cartItem.quantity : 0;
        
        if (stockLevel <= 0) {
            showToast(`Product "${title}" is completely out of stock.`);
            return;
        }
        
        if (currentQtyInCart + 1 > stockLevel) {
            showToast(`Stock limit reached. You cannot add more than ${stockLevel} of "${title}" to your cart.`);
            return;
        }
    }

    // Add or increment quantity safely
    const idx = localCartState.findIndex(item => item.title === title);
    if (idx > -1 && type !== "Subscription") {
        localCartState[idx].quantity += 1;
    } else {
        localCartState.push({
            title, price, numericPrice: parseFloat(price.replace(/[^0-9.]/g, '')),
            type, details, imagePath, quantity: 1
        });
    }

    saveCartToLocalStorage();
    updateCartUI();
    showToast(`Confirmed: ${title} added to cart.`);
    await syncCartToDatabase();
}

async function changeQuantity(index, delta) {
    if (!localCartState[index]) return;
    const item = localCartState[index];
    
    if (delta > 0 && item.type === "Hardware") {
        const stockLevel = await fetchStockLimit(item.title);
        if (item.quantity + delta > stockLevel) {
            showToast(`Stock limit reached. Only ${stockLevel} available for "${item.title}".`);
            return;
        }
    }
    
    localCartState[index].quantity += delta;
    if (localCartState[index].quantity <= 0) {
        localCartState.splice(index, 1);
    }
    saveCartToLocalStorage();
    updateCartUI();
    await syncCartToDatabase();
    if (window.location.pathname.includes("checkout.html")) renderCheckoutPage();
}

/* ============================================================
   UPDATING CART LAYER (Task 1 Colors & Task 2 Buttons)
   ============================================================ */
function updateCartUI() {
    const count = localCartState.reduce((total, item) => total + item.quantity, 0);
    if (document.getElementById("cart-count")) document.getElementById("cart-count").innerText = count;
    
    const container = document.getElementById("cartDrawerItems");
    if (!container) return;
    
    container.innerHTML = "";
    if (localCartState.length === 0) {
        container.innerHTML = `<p style="color: rgba(255,255,255,0.4); text-align: center; margin-top: 40px; font-size: 0.9rem;">Your cart is empty.</p>`;
        if (document.getElementById("cartDrawerSubtotal")) {
            document.getElementById("cartDrawerSubtotal").innerText = "$0.00";
        }
        return;
    }

    let subtotal = 0;
    localCartState.forEach((item, index) => {
        subtotal += item.numericPrice * item.quantity;
        const held = item.outOfStockHold === true;
        
        let colorClass = "";
        let borderClass = "";
        let badge = "";
        const isSub = item.type === "Subscription";
        
        if (isSub) {
            if (item.title.toLowerCase().includes("regular")) {
                colorClass = "plan-regular-text";
                borderClass = "plan-border-regular";
                badge = `<span class="plan-cart-badge regular">Regular Plan</span>`;
            } else if (item.title.toLowerCase().includes("dynamic")) {
                colorClass = "plan-dynamic-text";
                borderClass = "plan-border-dynamic";
                badge = `<span class="plan-cart-badge dynamic">Dynamic Plan</span>`;
            } else if (item.title.toLowerCase().includes("xtreme")) {
                colorClass = "plan-xtreme-text";
                borderClass = "plan-border-xtreme";
                badge = `<span class="plan-cart-badge xtreme">Xtreme Plan</span>`;
            }
        } else {
            colorClass = "product-brand-text";
            borderClass = "product-brand-border";
            badge = `<span class="plan-cart-badge product">Hardware</span>`;
        }

        // Clean layouts containing non-nested button structures (Task 2)
        container.insertAdjacentHTML("beforeend", `
            <div class="cart-drawer-item ${borderClass}">
                ${item.imagePath ? `<img class="cart-item-img" src="${item.imagePath}" alt="${item.title}">` : ''}
                <div class="cart-item-info">
                    <h4 class="${colorClass}">${item.title}</h4>
                    <span class="price">${item.price}</span>
                    <div style="margin-top: 4px;">${badge}</div>
                    ${held ? `<span style="display:block; margin-top:6px; font-size:0.72rem; color:#ff7a00; font-weight: 500;">Sold out - held until restock</span>` : ''}
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
                    ${isSub ? `
                        <button class="cart-remove-btn" onclick="changeQuantity(${index},-1)">Remove</button>
                    ` : `
                        <div class="cart-item-qty">
                            <button class="cart-qty-btn" onclick="changeQuantity(${index},-1)">−</button>
                            <span class="cart-qty-val">${item.quantity}</span>
                            <button class="cart-qty-btn" onclick="changeQuantity(${index},1)">+</button>
                        </div>
                    `}
                </div>
            </div>
        `);
    });
    
    if (document.getElementById("cartDrawerSubtotal")) {
        document.getElementById("cartDrawerSubtotal").innerText = `$${subtotal.toFixed(2)}`;
    }
}

function showToast(message) {
    const toast = document.getElementById("cartToast");
    const msg = document.getElementById("cartToastMessage");
    if (toast && msg) {
        msg.innerText = message;
        toast.classList.add("active");
        setTimeout(() => { toast.classList.remove("active"); }, 3000);
    }
}

function openCartDrawer(e = null) {
    if (e) e.preventDefault();
    document.getElementById("cartDrawer")?.classList.add("active");
    document.getElementById("cartDrawerOverlay")?.classList.add("active");
    document.body.classList.add("scroll-locked");
}

function closeCartDrawer() {
    document.getElementById("cartDrawer")?.classList.remove("active");
    document.getElementById("cartDrawerOverlay")?.classList.remove("active");
    checkScrollUnlock();
}

/* ============================================================
   CHECKOUT AUTHENTICATION REQUIREMENT (Task 2)
   ============================================================ */
function navigateToCheckout() { 
    closeCartDrawer(); 
    
    if (!localStorage.getItem("rdx_session")) {
        // Safe redirect parameters to return users back to checkout after auth (Task 2)
        localStorage.setItem("rdx_redirect_target", "checkout.html");
        showToast("Authentication required. Please sign in to proceed.");
        openSigninDrawer();
    } else {
        window.location.href = "checkout.html"; 
    }
}

function checkScrollUnlock() {
    const c = document.getElementById("cartDrawer")?.classList.contains("active");
    const s = document.getElementById("specsModal")?.classList.contains("active");
    const si = document.getElementById("signinDrawer")?.classList.contains("active");
    if (!c && !s && !si) document.body.classList.remove("scroll-locked");
}

/* ============================================================
   AUTHENTICATION & PROFILE
   ============================================================ */
function getActiveUserSuffix() {
    const s = localStorage.getItem("rdx_session");
    if (s) {
        try { return `_user_${JSON.parse(s).email.replace(/[^a-zA-Z0-9]/g, "")}`; } 
        catch (e) { localStorage.removeItem("rdx_session"); }
    }
    return "";
}

function openSigninDrawer() {
    const signinCopy = document.getElementById("signinDrawerCopy");
    if (signinCopy) signinCopy.innerText = "Sign in to access your RDX dashboard, cart, and repair plans.";
    document.getElementById("signinDrawer")?.classList.add("active");
    document.getElementById("signinDrawerOverlay")?.classList.add("active");
    document.body.classList.add("scroll-locked");
}

function closeSigninDrawer() {
    document.getElementById("signinDrawer")?.classList.remove("active");
    document.getElementById("signinDrawerOverlay")?.classList.remove("active");
    const signinCopy = document.getElementById("signinDrawerCopy");
    if (signinCopy) signinCopy.innerText = "";
    checkScrollUnlock();
}

function handleProfileNavClick(e) {
    if (e) e.preventDefault();
    if (localStorage.getItem("rdx_session")) window.location.href = "settings.html";
    else openSigninDrawer();
}

/* ============================================================
   GOOGLE AVATARS IN NAV BAR MODULES (Task 2)
   ============================================================ */
function updateProfileNavUI() {
    const btn = document.getElementById("navProfileBtn");
    const session = localStorage.getItem("rdx_session");
    if (!btn) return;
    
    if (session) {
        const user = JSON.parse(session);
        btn.innerText = user.name.split(' ')[0];
        if (db) {
            // Check for user-uploaded custom or Google profiles dynamically (Task 2)
            db.collection("users").doc(user.email).get().then(doc => {
                if (doc.exists && doc.data().pfpUrl) {
                    btn.innerHTML = `
                        <div style="display:flex; align-items:center; gap:8px;">
                            <img src="${doc.data().pfpUrl}" style="width:22px; height:24px; border-radius:50%; object-fit:cover; border:1px solid #00e5b4; display:block;">
                            <span>${user.name.split(' ')[0]}</span>
                        </div>
                    `;
                }
            }).catch(console.error);
        }
    } else {
        btn.innerText = "Sign In";
    }
    toggleOurStoryNavigation();
}

/* ============================================================
   LOGGED-IN NAVIGATION FILTER (Task 1)
   ============================================================ */
function toggleOurStoryNavigation() {
    const session = localStorage.getItem("rdx_session");
    const storyLinks = document.querySelectorAll('a[href*="#story"], a[href*="story"]');
    storyLinks.forEach(link => {
        const li = link.closest('li');
        if (li) {
            if (session) {
                li.style.display = 'none'; // Hide if logged in
            } else {
                li.style.display = 'block'; // Show if logged out
            }
        }
    });
}

async function handleGoogleSignIn() {
    if (typeof firebase === 'undefined' || !db) { 
        alert("Database offline. Try again in a moment."); 
        return; 
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        const result = await firebase.auth().signInWithPopup(provider);
        const email = result.user.email.toLowerCase().trim();
        const name = result.user.displayName || "RDX User";
        const pfpUrl = result.user.photoURL || "";
        
        const doc = await db.collection("users").doc(email).get();
        if (!doc.exists) {
            await db.collection("users").doc(email).set({ 
                name, email, activeSubscription: "", cart: [], role: "user", pfpUrl: pfpUrl 
            });
        }
        
        const data = doc.exists ? doc.data() : { name, email, pfpUrl };
        localStorage.setItem("rdx_session", JSON.stringify({ name: data.name, email: data.email }));
        
        if (data.activeSubscription) {
            localStorage.setItem("rdx_active_subscription" + getActiveUserSuffix(), data.activeSubscription);
        } else {
            localStorage.removeItem("rdx_active_subscription" + getActiveUserSuffix());
        }
        
        localCartState = data.cart || [];
        saveCartToLocalStorage();
        updateProfileNavUI(); 
        updateCartUI(); 
        await checkActiveSubscriptionButtons();
        closeSigninDrawer();
        showToast(`Welcome back, ${data.name.split(' ')[0]}.`);
        
        // Handle Post-Auth Redirects Safely (Task 2 Checkout bounce-back)
        const targetUrl = localStorage.getItem("rdx_redirect_target");
        if (targetUrl) {
            localStorage.removeItem("rdx_redirect_target");
            setTimeout(() => { window.location.href = targetUrl; }, 500);
        } else {
            setTimeout(() => { window.location.href = "dashboard.html"; }, 500);
        }
    } catch (err) { 
        console.error("Sign-in error:", err);
        showToast("Sign-in process failed.");
    }
}

function logUserOut() {
    const suffix = getActiveUserSuffix();
    if (suffix) {
        try { localStorage.removeItem("rdx_cart" + suffix); } 
        catch (e) { console.error("Cleanup error:", e); }
    }
    localStorage.removeItem("rdx_session");
    localStorage.removeItem("rdx_active_subscription" + suffix);
    localCartState = [];
    updateCartUI();
    if (typeof firebase !== 'undefined') firebase.auth().signOut().catch(console.error);
    toggleOurStoryNavigation();
    window.location.href = "index.html";
}

/* ============================================================
   PARALLAX & ANIMATIONS
   ============================================================ */
document.addEventListener('mousemove', (e) => {
    const target = document.querySelector('.hero-content, .header-content, .contact-header, .services-intro');
    if (target) {
        const x = (window.innerWidth / 2 - e.clientX) * 0.005; 
        const y = (window.innerHeight / 2 - e.clientY) * 0.005;
        target.style.transform = `translateX(${-x}px) translateY(${-y}px)`;
    }
});

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('active');
        else entry.target.classList.remove('active');
    });
}, { threshold: 0.1, rootMargin: "0px 0px -50px 0px" });

function initReveals() {
    document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
    setTimeout(() => { 
        document.querySelectorAll('.reveal').forEach(el => el.classList.add('active')); 
    }, 900);
}

window.addEventListener('load', initReveals);
if (document.readyState === 'complete') initReveals();

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { 
        closeCartDrawer(); 
        closeProductSpecs(); 
        closeSigninDrawer(); 
    }
});

/* ============================================================
   PRODUCT SPECS MODAL (Task 4 Fixed-Height Description Scroll)
   ============================================================ */
function openProductSpecs(title, price, desc, mainImage, altImages, specsString, stock, docId) {
    const modal = document.getElementById('specsModal');
    if (!modal) return;
    
    trackRecentlyViewed(title, price, mainImage);
    activeSlideImages = [mainImage, ...altImages];
    currentSlideIndex = 0;
    
    document.getElementById('specsTitle').innerText = title;
    document.getElementById('specsPrice').innerText = price;
    
    // Convert description panel to a safe scroll box of unified height (Task 4)
    const descArea = document.getElementById('specsDesc');
    if (descArea) {
        descArea.className = "specs-info-desc";
        descArea.innerText = desc;
    }
    
    updateSlideshowUI();
    
    const gridContainer = document.getElementById('specsListGrid');
    if (gridContainer && specsString) {
        gridContainer.innerHTML = "";
        specsString.split(';').forEach(item => {
            const parts = item.split(':');
            if (parts.length === 2) {
                gridContainer.insertAdjacentHTML('beforeend', `
                    <div class="specs-list-item">
                        <strong>${parts[0].trim()}</strong>
                        <span>${parts[1].trim()}</span>
                    </div>
                `);
            }
        });
    }

    const badge = document.getElementById("modalStockBadge");
    const dot = document.getElementById("modalStockDot");
    const text = document.getElementById("modalStockText");
    const addBtn = document.getElementById("specsModalAddBtn");

    if (badge && dot && text) {
        const isOutOfStock = (parseInt(stock, 10) || 0) <= 0;
        if (isOutOfStock) {
            badge.style.background = "rgba(255, 122, 0, 0.06)";
            badge.style.borderColor = "rgba(255, 122, 0, 0.12)";
            badge.style.color = "#ff7a00";
            dot.style.background = "#ff7a00";
            dot.style.boxShadow = "0 0 8px #ff7a00";
            text.innerText = "SOLD OUT";
            if (addBtn) {
                addBtn.disabled = true;
                addBtn.innerText = "Out of Stock";
                addBtn.style.background = "rgba(255, 255, 255, 0.05)";
                addBtn.style.color = "rgba(255, 255, 255, 0.25)";
                addBtn.style.pointerEvents = "none";
            }
        } else {
            badge.style.background = "rgba(0, 229, 180, 0.06)";
            badge.style.borderColor = "rgba(0, 229, 180, 0.12)";
            badge.style.color = "rgb(0, 229, 180)";
            dot.style.background = "rgb(0, 229, 180)";
            dot.style.boxShadow = "0 0 8px rgb(0, 229, 180)";
            text.innerText = "In Stock";
            if (addBtn) {
                addBtn.disabled = false;
                addBtn.innerText = "Add to Cart";
                addBtn.style.background = "rgb(0, 229, 180)";
                addBtn.style.color = "#000";
                addBtn.style.pointerEvents = "auto";
            }
        }
    }

    document.getElementById('specsModalAddBtn').onclick = () => {
        if (docId) { triggerProductAddToCart(docId); } 
        else { addToCart(title, price, 'Hardware', desc, mainImage); }
        closeProductSpecs();
    };
    
    modal.classList.add('active');
    document.body.classList.add('scroll-locked');
}

function updateSlideshowUI() {
    const displayImg = document.getElementById('specsImage');
    const thumbContainer = document.getElementById('specsThumbnailsRow');
    if (!displayImg || !thumbContainer || activeSlideImages.length === 0) return;
    
    displayImg.src = activeSlideImages[currentSlideIndex];
    thumbContainer.innerHTML = "";
    activeSlideImages.forEach((imgSrc, index) => {
        thumbContainer.insertAdjacentHTML('beforeend', `
            <div class="specs-thumb ${index === currentSlideIndex ? 'active' : ''}" onclick="setSlide(${index})">
                <img src="${imgSrc}" alt="Thumbnail">
            </div>
        `);
    });
}

function setSlide(index) { currentSlideIndex = index; updateSlideshowUI(); }
function changeSlide(direction) {
    currentSlideIndex += direction;
    if (currentSlideIndex >= activeSlideImages.length) currentSlideIndex = 0;
    else if (currentSlideIndex < 0) currentSlideIndex = activeSlideImages.length - 1;
    updateSlideshowUI();
}
function closeProductSpecs() {
    const modal = document.getElementById("specsModal");
    if (modal) { modal.classList.remove("active"); checkScrollUnlock(); }
}

/* ============================================================
   MASTER ECOSYSTEM INITIALIZATION
   ============================================================ */
async function initializeEcosystem() {
    try {
        loadCartFromLocalStorage();
        updateCartUI();
        updateProfileNavUI();
        toggleOurStoryNavigation();

        if (window.location.pathname.includes("checkout.html")) {
            // Strict Frontend Direct-Access Block (Task 2)
            if (!localStorage.getItem("rdx_session")) {
                localStorage.setItem("rdx_redirect_target", "checkout.html");
                window.location.replace("index.html");
                return;
            }
            renderCheckoutPage();
        }

        const res = await fetch("/api/config");
        const config = await res.json();
        
        if (typeof firebase !== 'undefined' && config.firebaseConfig) {
            firebase.initializeApp(config.firebaseConfig);
            db = firebase.firestore();
            console.log("✅ Firebase initialized successfully.");

            // Enable offline persistence
            db.enablePersistence()
                .then(() => console.log("✅ Offline persistence enabled."))
                .catch((err) => {
                    if (err.code === 'failed-precondition') {
                        console.warn("⚠️ Multiple tabs open.");
                    } else if (err.code === 'unimplemented') {
                        console.warn("⚠️ Browser doesn't support offline persistence.");
                    }
                });

            // Fetch cloud cart
            const cloudCart = await fetchCartFromDatabase();
            if (Array.isArray(cloudCart) && cloudCart.length > 0) {
                localCartState = cloudCart;
                saveCartToLocalStorage();
                updateCartUI();
                if (window.location.pathname.includes("checkout.html")) {
                    renderCheckoutPage();
                }
            }

            // Setup real-time stock monitoring
            if (localCartState.length > 0) {
                setupStockWatcher();
            }
        }

        if (window.location.pathname.includes("checkout.html") && config.stripePublishableKey) {
            initStripeElements(config.stripePublishableKey);
        }
        if (window.location.pathname.includes("store.html")) {
            loadDynamicStoreCatalog();
            initCategoryFilters();
        }
        if (window.location.pathname.includes("tracking.html")) initAutoTracking();
        if (window.location.pathname.includes("admin.html")) initAdminPage();
        if (window.location.pathname.includes("dashboard.html")) await renderDashboardPage();
        if (window.location.pathname.includes("settings.html")) await renderSettingsPage();
        
        await checkActiveSubscriptionButtons();
    } catch (err) { 
        console.error("Initialization error:", err);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const injections = `
        <div id="cartDrawerOverlay" class="cart-drawer-overlay" onclick="closeCartDrawer()"></div>
        <div id="cartDrawer" class="cart-drawer">
            <div class="cart-drawer-header"><h3>Your Cart</h3><button class="cart-drawer-close" onclick="closeCartDrawer()">&times;</button></div>
            <div id="cartDrawerItems" class="cart-drawer-items"></div>
            <div class="cart-drawer-footer">
                <div class="cart-drawer-subtotal"><span>Subtotal</span><span id="cartDrawerSubtotal">$0.00</span></div>
                <button class="btn-cart-checkout" onclick="navigateToCheckout()">Proceed to Checkout</button>
            </div>
        </div>
        <div id="specsModal" class="specs-modal" onclick="closeProductSpecs()"><div class="specs-modal-content" onclick="event.stopPropagation()"><button class="checkout-close" onclick="closeProductSpecs()">&times;</button><div class="specs-grid"><div class="specs-visual-container"><div class="specs-visual"><span class="specs-arrow prev" onclick="changeSlide(-1)">&lsaquo;</span><img id="specsImage" src=""><span class="specs-arrow next" onclick="changeSlide(1)">&rsaquo;</span></div><div class="specs-thumbnails" id="specsThumbnailsRow"></div></div><div class="specs-info"><div class="stock-badge" id="modalStockBadge"><div class="stock-dot" id="modalStockDot"></div><span id="modalStockText">In Stock</span></div><h2 id="specsTitle"></h2><div id="specsPrice" class="price"></div><p id="specsDesc"></p><div id="specsListGrid" class="specs-list-grid"></div><button id="specsModalAddBtn" class="btn-primary" style="background:#00e5b4; color:#000; width:100%; padding:12px;">Add to Cart</button></div></div></div></div>
        <div id="signinDrawerOverlay" class="signin-drawer-overlay" onclick="closeSigninDrawer()"></div>
        <div id="signinDrawer" class="signin-drawer">
            <div class="cart-drawer-header"><h3>Access Profile</h3><button class="cart-drawer-close" onclick="closeSigninDrawer()">&times;</button></div>
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 20px;">
                <p id="signinDrawerCopy" style="font-size:0.88rem; color:rgba(255,255,255,0.4); text-align:center;"></p>
                <button class="btn-checkout-submit" onclick="handleGoogleSignIn()" style="background:#00e5b4; color:#000; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.24 10.285V13.4h6.887C18.2 15.614 15.645 18 12.24 18c-3.86 0-7-3.14-7-7s3.14-7 7-7c1.7 0 3.3.6 4.5 1.7l2.4-2.4C17.3 1.5 14.9 1 12.24 1 6.58 1 2 5.58 2 11.24s4.58 10.24 10.24 10.24c5.79 0 10.24-4.07 10.24-10.24 0-.69-.06-1.35-.18-1.95H12.24z"/></svg>Sign In with Google
                </button>
            </div>
        </div>
        <div id="cartToast" class="cart-toast"><div class="toast-dot"></div><span id="cartToastMessage"></span></div>
    `;
    document.body.insertAdjacentHTML('beforeend', injections);
    document.querySelectorAll(".nav-cart-btn").forEach(el => el.addEventListener("click", openCartDrawer));
    initializeEcosystem();
});

/* ============================================================
   CONTACT & FILTERS
   ============================================================ */
function switchContactTab(tab) {
    const isBooking = tab === "booking";
    const isGeneral = tab === "general";
    const isFeedback = tab === "feedback";

    document.getElementById("contactPanelBooking")?.classList.toggle("active", isBooking);
    document.getElementById("contactPanelGeneral")?.classList.toggle("active", isGeneral);
    document.getElementById("contactPanelFeedback")?.classList.toggle("active", isFeedback);

    document.getElementById("contactTabBtnBooking")?.classList.toggle("active", isBooking);
    document.getElementById("contactTabBtnGeneral")?.classList.toggle("active", isGeneral);
    document.getElementById("contactTabBtnFeedback")?.classList.toggle("active", isFeedback);
}

function handleBookingSubmit(e) { 
    e.preventDefault(); 
    showToast("Appointment requested. A confirmation will be sent via email.");
    e.target.reset(); 
}

function handleGeneralContactSubmit(e) { 
    e.preventDefault(); 
    showToast("Message received. We will respond within 24 hours.");
    e.target.reset(); 
}

function initCategoryFilters() {
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            
            const filterValue = chip.dataset.filter;
            const cards = document.querySelectorAll('.gallery-card');
            
            cards.forEach(card => {
                if (filterValue === 'all' || card.getAttribute('data-category') === filterValue) {
                    card.style.display = 'flex';
                    setTimeout(() => card.style.opacity = '1', 50);
                } else {
                    card.style.opacity = '0';
                    setTimeout(() => card.style.display = 'none', 300);
                }
            });
        });
    });
}

async function checkActiveSubscriptionButtons() {
    const session = localStorage.getItem("rdx_session");
    if (!session) return;
    
    const activeSub = await getActiveSubscription();
    if (!activeSub) return;
    
    document.querySelectorAll(".service-card").forEach(card => {
        const h = card.querySelector("h3")?.innerText;
        const btn = card.querySelector("button");
        
        if (h && h.includes(activeSub.split(" ")[0]) && btn) {
            btn.innerText = "Plan Active";
            btn.disabled = true;
            btn.style.opacity = "0.6";
            btn.style.pointerEvents = "none";
        }
    });
}

/* ============================================================
   STRIPE CHECKOUT
   ============================================================ */
function initStripeElements(publishableKey) {
    stripeInstance = Stripe(publishableKey);
    const elements = stripeInstance.elements();
    const style = { 
        base: { 
            color: '#fff', 
            fontFamily: 'Inter, sans-serif', 
            fontSize: '14.4px', 
            '::placeholder': { color: 'rgba(255,255,255,0.25)' } 
        }, 
        invalid: { color: '#ff7a00' } 
    };
    
    cardNumElement = elements.create('cardNumber', { style });
    cardExpiryElement = elements.create('cardExpiry', { style });
    cardCvcElement = elements.create('cardCvc', { style });
    
    if (document.getElementById('stripe-card-number')) {
        cardNumElement.mount('#stripe-card-number');
        cardExpiryElement.mount('#stripe-card-expiry');
        cardCvcElement.mount('#stripe-card-cvc');
        
        [cardNumElement, cardExpiryElement, cardCvcElement].forEach(el => {
            el.on('focus', () => { 
                document.getElementById(el._parent.id)?.classList.add('stripe-input-container--focus'); 
            });
            el.on('blur', () => { 
                document.getElementById(el._parent.id)?.classList.remove('stripe-input-container--focus'); 
            });
        });
    }
}

function isCartOnlyDigital() {
    if (localCartState.length === 0) return false;
    return localCartState.every(item => item.type === "Subscription");
}

function renderCheckoutPage() {
    const mf = document.getElementById("checkoutMainFlow");
    const sf = document.getElementById("checkoutSuccessFlow");
    const sn = document.getElementById("checkoutStepsNav");
    const es = document.getElementById("checkoutEmptyState");
    
    if (!mf) return;
    
    sf.style.display = "none";
    
    if (localCartState.length === 0) {
        mf.style.display = "none";
        sn.style.display = "none";
        es.style.display = "block";
        return;
    }
    
    es.style.display = "none";
    mf.style.display = "grid";
    sn.style.display = "flex";

    // Skip Shipping Steps Dynamically if Cart is only Subscriptions/Digital (Task 2)
    const step1Node = document.querySelector('.step-node[data-step="1"]');
    const stepPanel1 = document.getElementById("stepPanel1");

    if (isCartOnlyDigital()) {
        if (step1Node) {
            step1Node.querySelector('.step-label').innerText = "Account Email";
            step1Node.querySelector('.step-circle').innerText = "✓";
        }
        if (stepPanel1) {
            stepPanel1.innerHTML = `
                <h4 class="step-panel-heading">Digital Delivery Link</h4>
                <p style="color: rgba(255,255,255,0.6); margin-bottom: 25px; font-size: 0.9rem; line-height: 1.6;">
                    You are purchasing a digital membership. It will be instantly activated on your account <strong>${JSON.parse(localStorage.getItem("rdx_session"))?.email || ""}</strong> immediately after payment. No physical shipping is required.
                </p>
                <div class="checkout-field">
                    <label for="shipName">Membership Holder Full Name</label>
                    <input type="text" id="shipName" required placeholder="John Doe" value="${JSON.parse(localStorage.getItem("rdx_session"))?.name || ""}">
                </div>
                <!-- Prefilled fields for Stripe compilation -->
                <input type="hidden" id="shipAddress" value="Digital Delivery">
                <input type="hidden" id="shipApt" value="">
                <input type="hidden" id="shipCity" value="Digital">
                <input type="hidden" id="shipState" value="Digital">
                <input type="hidden" id="shipZip" value="00000">
                <input type="hidden" id="shipPhone" value="N/A">
                
                <div class="checkout-step-actions">
                    <button type="button" class="btn-checkout-submit" onclick="goToStep(2)">Continue to Payment</button>
                </div>
            `;
        }
    } else {
        if (step1Node) {
            step1Node.querySelector('.step-label').innerText = "Shipping";
            step1Node.querySelector('.step-circle').innerText = "1";
        }
    }

    renderCheckoutSidebar();
    updateCheckoutAvailability();
}

function hasBlockedCheckoutItems() {
    return localCartState.some(item => item.type === "Hardware" && item.outOfStockHold === true);
}

function updateCheckoutAvailability() {
    const btn = document.getElementById("checkoutSubmitBtn");
    const blocked = hasBlockedCheckoutItems();
    if (!btn) return;

    btn.disabled = blocked;
    btn.innerText = blocked ? "Remove Sold Out Items" : "Place Order";
}

function renderCheckoutSidebar() {
    const container = document.getElementById("checkoutSidebarItems");
    if (!container) return;
    
    container.innerHTML = "";
    let subtotal = 0;
    
    localCartState.forEach((item, index) => {
        subtotal += item.numericPrice * item.quantity;
        const held = item.outOfStockHold === true;

        // Apply color identity to checkout summary lines (Task 1 Color Alignment)
        let colorClass = "";
        let borderClass = "";
        const isSub = item.type === "Subscription";
        
        if (isSub) {
            if (item.title.toLowerCase().includes("regular")) {
                colorClass = "plan-regular-text";
                borderClass = "plan-border-regular";
            } else if (item.title.toLowerCase().includes("dynamic")) {
                colorClass = "plan-dynamic-text";
                borderClass = "plan-border-dynamic";
            } else if (item.title.toLowerCase().includes("xtreme")) {
                colorClass = "plan-xtreme-text";
                borderClass = "plan-border-xtreme";
            }
        } else {
            colorClass = "product-brand-text";
            borderClass = "product-brand-border";
        }

        container.insertAdjacentHTML('beforeend', `
            <div class="checkout-sidebar-item ${borderClass}">
                ${item.imagePath ? `<img src="${item.imagePath}" class="checkout-item-img" alt="${item.title}">` : ''}
                <div class="checkout-sidebar-item-info">
                    <h4 class="${colorClass}">${item.title}</h4>
                    <span class="price">$${(item.numericPrice * item.quantity).toFixed(2)}</span>
                    ${held ? `<span style="display:block; margin:6px 0 8px; font-size:0.72rem; color:#ff7a00; font-weight: 500;">Sold out - remove before checkout</span>` : ''}
                    <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                        ${isSub ? `
                            <button class="cart-remove-btn" onclick="changeQuantity(${index},-1)">Remove</button>
                        ` : `
                            <div class="cart-item-qty">
                                <button class="cart-qty-btn" onclick="changeQuantity(${index},-1)">−</button>
                                <span class="cart-qty-val">${item.quantity}</span>
                                <button class="cart-qty-btn" onclick="changeQuantity(${index},1)">+</button>
                            </div>
                        `}
                    </div>
                </div>
            </div>
        `);
    });
    
    if (document.getElementById("checkoutSubtotalVal")) {
        document.getElementById("checkoutSubtotalVal").innerText = `$${subtotal.toFixed(2)}`;
    }
    if (document.getElementById("checkoutGrandTotalVal")) {
        document.getElementById("checkoutGrandTotalVal").innerText = `$${subtotal.toFixed(2)}`;
    }
    updateCheckoutAvailability();
}

function goToStep(step) {
    if (step > checkoutCurrentStep && hasBlockedCheckoutItems()) {
        showToast("Remove sold out items before proceeding.");
        updateCheckoutAvailability();
        return;
    }

    if (step > checkoutCurrentStep) {
        const required = document.getElementById('stepPanel' + checkoutCurrentStep).querySelectorAll('input[required]');
        for (const input of required) { 
            if (!input.reportValidity()) return; 
        }
    }
    
    document.querySelectorAll('.checkout-step-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('stepPanel' + step).classList.add('active');
    document.querySelectorAll('.step-node').forEach(node => {
        const ns = parseInt(node.dataset.step, 10);
        node.classList.remove('active', 'complete');
        if (ns < step) node.classList.add('complete');
        if (ns === step) node.classList.add('active');
    });
    
    checkoutCurrentStep = step;
    if (step === 3) populateReviewStep();
}

function populateReviewStep() {
    const n = document.getElementById('shipName').value;
    const a = document.getElementById('shipAddress').value;
    const apt = document.getElementById('shipApt').value;
    const c = document.getElementById('shipCity').value;
    const s = document.getElementById('shipState').value;
    const z = document.getElementById('shipZip').value;
    const p = document.getElementById('shipPhone').value;
    
    if (isCartOnlyDigital()) {
        document.getElementById('reviewShippingText').innerText = `${n} — Digital Activation on Account`;
    } else {
        document.getElementById('reviewShippingText').innerText = 
            `${n} — ${a}${apt ? `, ${apt}` : ''}, ${c}, ${s} ${z} · ${p}`;
    }
    document.getElementById('reviewPaymentText').innerText = 
        `Card: ${document.getElementById('checkoutName').value || 'Card Holder'}`;
}

async function decrementPurchasedStock(items) {
    if (!db) return;
    
    for (const item of items) {
        if (item.type !== "Hardware") continue;
        
        const docKey = item.title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const productRef = db.collection("products").doc(docKey);
        
        try {
            await db.runTransaction(async (tx) => {
                const doc = await tx.get(productRef);
                if (!doc.exists) return;
                
                const currentStock = parseInt(doc.data().stock, 10) || 0;
                const newStock = Math.max(0, currentStock - item.quantity);
                tx.update(productRef, { stock: newStock });
            });
        } catch (e) {
            console.error(`Failed to decrement stock for "${item.title}":`, e);
        }
    }
}

async function handleCheckoutSubmit() {
    if (!db) return;
    
    const session = localStorage.getItem("rdx_session");
    if (!session || localCartState.length === 0) return;

    if (hasBlockedCheckoutItems()) {
        showToast("Remove sold out items before final purchase.");
        updateCheckoutAvailability();
        return;
    }
    
    const btn = document.getElementById("checkoutSubmitBtn");
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Processing...";
    }
    
    try {
        // Validate all items still in stock
        for (const item of localCartState) {
            if (item.type === "Hardware") {
                const docKey = item.title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
                const doc = await db.collection("products").doc(docKey).get();
                if (!doc.exists || parseInt(doc.data().stock, 10) < item.quantity) {
                    showToast("Notice: Product is no longer available in the requested quantity.");
                    if (btn) {
                        btn.disabled = false;
                        btn.innerText = "Place Order";
                    }
                    return;
                }
            }
        }
        
        const orderTotal = localCartState.reduce((sum, item) => sum + (item.numericPrice * item.quantity), 0);
        const res = await fetch("/api/create-payment-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                amount: orderTotal, 
                currency: "usd", 
                email: document.getElementById("checkoutEmail").value 
            })
        });
        
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        
        const result = await stripeInstance.confirmCardPayment(d.clientSecret, {
            payment_method: { 
                card: cardNumElement, 
                billing_details: { 
                    name: document.getElementById("checkoutName").value, 
                    email: document.getElementById("checkoutEmail").value 
                } 
            }
        });
        
        if (result.error) throw new Error(result.error.message);
        
        if (result.paymentIntent.status === 'succeeded') {
            const orderId = "RDX-" + Date.now();
            const sub = localCartState.find(item => item.type === "Subscription")?.title || "";
            const userEmail = JSON.parse(session).email;
            const isDigital = isCartOnlyDigital();

            // Safe Client-Data Payload — No Card, CVV or sensitive credentials stored (Task 3)
            const shippingDetails = {
                name: document.getElementById('shipName').value,
                phone: isDigital ? "N/A" : document.getElementById('shipPhone').value,
                address: isDigital ? "Digital Membership Activation" : `${document.getElementById('shipAddress').value}, ${document.getElementById('shipCity').value}, ${document.getElementById('shipState').value} ${document.getElementById('shipZip').value}`,
                street: isDigital ? "Digital" : document.getElementById('shipAddress').value,
                city: isDigital ? "Digital" : document.getElementById('shipCity').value,
                state: isDigital ? "Digital" : document.getElementById('shipState').value,
                zip: isDigital ? "00000" : document.getElementById('shipZip').value
            };

            const now = new Date();
            const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

            const orderPayload = {
                orderId,
                userEmail,
                date: now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
                time: timeStr,
                items: localCartState,
                total: orderTotal,
                paymentStatus: "Paid",
                trackingNumber: isDigital ? "N/A - Digital Membership" : "Pending",
                shippingStatus: isDigital ? "Activated" : "Processed",
                isDigital: isDigital,
                customerName: document.getElementById('shipName').value,
                shippingDetails: shippingDetails
            };

            await db.collection("orders").doc(orderId).set(orderPayload);
            
            // Decrement stock
            await decrementPurchasedStock(localCartState);
            
            // Clear user cart and update subscription
            await db.collection("users").doc(userEmail).update({ cart: [] });
            if (sub) {
                await db.collection("users").doc(userEmail).update({ activeSubscription: sub });
                localStorage.setItem("rdx_active_subscription" + getActiveUserSuffix(), sub);
            }
            
            // Clear local state
            const suffix = getActiveUserSuffix();
            if (suffix) {
                try { localStorage.removeItem("rdx_cart" + suffix); } 
                catch (e) { console.error("Local clear failed:", e); }
            }
            
            localCartState = [];
            updateCartUI();
            
            // Render receipt directly on success flow (Task 2)
            document.getElementById("successTitle").innerText = "Order Complete";
            let successMsg = "Your transaction was authenticated successfully.";
            if (isDigital) {
                successMsg += " Your digital membership plan is now active.";
            }
            document.getElementById("successMessage").innerText = successMsg;

            const successFlow = document.getElementById("checkoutSuccessFlow");
            if (successFlow) {
                const existingBtn = successFlow.querySelector(".btn-primary");
                const receiptBtnId = "inlineReceiptBtn";
                if (!document.getElementById(receiptBtnId)) {
                    existingBtn.insertAdjacentHTML("beforebegin", `
                        <button id="${receiptBtnId}" class="btn-primary" style="margin: 0 auto 15px; width: auto; padding: 12px 28px; background: #00e5b4; color: #000;" onclick="viewInlineReceipt('${orderId}')">View Order Receipt</button>
                    `);
                }
            }

            document.getElementById("checkoutMainFlow").style.display = "none";
            document.getElementById("checkoutStepsNav").style.display = "none";
            document.getElementById("checkoutSuccessFlow").style.display = "block";
        }
    } catch (err) { 
        console.error("Checkout error:", err);
        showToast("Error: " + err.message);
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Place Order";
        }
    }
}

/* ============================================================
   ADVANCED SEARCH & DUAL MANUAL PRICE FILTERS (Task 3 Redesign)
   ============================================================ */
function updatePriceLabel(value) {
    const label = document.getElementById("priceLabel");
    if (label) label.innerText = `$${value} Max`;
    filterStoreCatalog();
}

function resetStoreFilters() {
    const searchInput = document.getElementById("storeSearchInput");
    const minPriceInput = document.getElementById("minPriceInput");
    const maxPriceInput = document.getElementById("maxPriceInput");
    const outOfStockCheckbox = document.getElementById("excludeOosInput");
    const catAllRadio = document.querySelector('input[name="catFilter"][value="all"]');

    if (searchInput) searchInput.value = "";
    if (minPriceInput) minPriceInput.value = "0";
    if (maxPriceInput) maxPriceInput.value = "2000";
    if (outOfStockCheckbox) outOfStockCheckbox.checked = false;
    if (catAllRadio) catAllRadio.checked = true;

    showToast("Filters successfully reset.");
    filterStoreCatalog();
}

function filterStoreCatalog() {
    const searchVal = document.getElementById("storeSearchInput")?.value.toLowerCase().trim() || "";
    const categoryVal = document.querySelector('input[name="catFilter"]:checked')?.value || "all";
    const minPrice = parseFloat(document.getElementById("minPriceInput")?.value || 0);
    const maxPrice = parseFloat(document.getElementById("maxPriceInput")?.value || 2000);
    const excludeOos = document.getElementById("excludeOosInput")?.checked || false;

    const cards = document.querySelectorAll('.gallery-card');
    let visibleCount = 0;

    cards.forEach((card, index) => {
        const title = card.querySelector('h3')?.innerText.toLowerCase() || "";
        const cat = card.getAttribute('data-category') || "";
        const priceText = card.querySelector('.price')?.innerText || "$0";
        const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
        const isSoldOut = card.innerHTML.includes("SOLD OUT");

        // Unified multi-filter query logic (Task 2 & 3)
        const matchesSearch = title.includes(searchVal) || cat.includes(searchVal);
        const matchesCategory = categoryVal === "all" || cat === categoryVal;
        const matchesPrice = price >= minPrice && price <= maxPrice;
        const matchesAvailability = !excludeOos || !isSoldOut;

        if (matchesSearch && matchesCategory && matchesPrice && matchesAvailability) {
            // Apply stagger entrance animation sequentially (Task 5 Animations)
            card.style.display = 'flex';
            setTimeout(() => {
                card.classList.add("visible-card");
            }, index * 40); 
            visibleCount++;
        } else {
            card.classList.remove("visible-card");
            setTimeout(() => {
                card.style.display = 'none';
            }, 150);
        }
    });

    const statusEl = document.getElementById("catalogStatus");
    if (statusEl) {
        statusEl.innerText = `Showing ${visibleCount} of ${cards.length} items`;
    }
}/* ============================================================
   PLAYSTATION-STYLE DIGITAL RECEIPT ENGINE (Task 2)
   ============================================================ */
window.viewInlineReceipt = async function(orderId) {
    if (!db) return;
    try {
        const doc = await db.collection("orders").doc(orderId).get();
        if (doc.exists) {
            showReceiptModal(doc.data());
        } else {
            showToast("Receipt details not found.");
        }
    } catch (e) {
        console.error("Could not fetch receipt:", e);
    }
};

function showReceiptModal(order) {
    // Remove existing modal if any
    document.getElementById("receiptModal")?.remove();

    const itemsRows = (order.items || []).map(item => {
        let planColorClass = "";
        const isSub = item.type === "Subscription";
        if (isSub) {
            if (item.title.toLowerCase().includes("regular")) planColorClass = "plan-regular-text";
            else if (item.title.toLowerCase().includes("dynamic")) planColorClass = "plan-dynamic-text";
            else if (item.title.toLowerCase().includes("xtreme")) planColorClass = "plan-xtreme-text";
        } else {
            planColorClass = "product-brand-text";
        }

        return `
            <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px dashed rgba(255,255,255,0.1); font-size: 0.85rem;">
                <span class="${planColorClass}">${item.title} (x${item.quantity})</span>
                <span style="font-family: 'Space Mono', monospace; font-weight: 600;">$${(item.numericPrice * item.quantity).toFixed(2)}</span>
            </div>
        `;
    }).join("");

    const receiptHTML = `
        <div id="receiptModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(12px); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px;">
            <div id="printArea" style="background: #0f0f0f; border: 1px solid rgba(255,255,255,0.1); width: 100%; max-width: 500px; border-radius: 20px; padding: 30px; position: relative; color: #fff; font-family: 'Inter', sans-serif; box-shadow: 0 15px 40px rgba(0,0,0,0.6);">
                <button onclick="document.getElementById('receiptModal').remove()" style="position: absolute; top: 20px; right: 20px; background: none; border: none; color: rgba(255,255,255,0.4); font-size: 1.5rem; cursor: pointer;">&times;</button>
                
                <!-- Receipt Header -->
                <div style="text-align: center; border-bottom: 2px dashed rgba(255,255,255,0.15); padding-bottom: 20px; margin-bottom: 20px;">
                    <h3 style="font-family: 'Syne', sans-serif; letter-spacing: 1px; color: #00e5b4; margin-bottom: 4px;">RDX TECHNOLOGIES</h3>
                    <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 2px; color: rgba(255,255,255,0.4);">Digital Receipt & Confirmation</span>
                </div>

                <!-- Info Grid -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 25px; font-size: 0.82rem;">
                    <div>
                        <span style="display: block; color: rgba(255,255,255,0.4); font-size: 0.68rem; text-transform: uppercase;">Customer Name</span>
                        <strong style="color: #fff;">${order.shippingDetails?.name || order.customerName || "RDX Customer"}</strong>
                    </div>
                    <div>
                        <span style="display: block; color: rgba(255,255,255,0.4); font-size: 0.68rem; text-transform: uppercase;">Order ID</span>
                        <strong style="color: #fff; font-family: 'Space Mono', monospace;">${order.orderId}</strong>
                    </div>
                    <div>
                        <span style="display: block; color: rgba(255,255,255,0.4); font-size: 0.68rem; text-transform: uppercase;">Date & Time</span>
                        <strong style="color: #fff;">${order.date} ${order.time || ""}</strong>
                    </div>
                    <div>
                        <span style="display: block; color: rgba(255,255,255,0.4); font-size: 0.68rem; text-transform: uppercase;">Payment Status</span>
                        <strong style="color: #00e5b4;">${order.paymentStatus || "Paid"}</strong>
                    </div>
                </div>

                <!-- Purchased Items -->
                <div style="margin-bottom: 25px;">
                    <span style="display: block; color: rgba(255,255,255,0.4); font-size: 0.68rem; text-transform: uppercase; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">Purchased Membership / Items</span>
                    ${itemsRows}
                </div>

                <!-- Total -->
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 2px solid rgba(255,255,255,0.1); padding-top: 15px; margin-bottom: 30px;">
                    <span style="font-family: 'Syne', sans-serif; font-weight: 700;">TOTAL AMOUNT PAID</span>
                    <span style="font-size: 1.4rem; font-weight: 800; color: #00e5b4; font-family: 'Space Mono', monospace;">$${(order.total || 0).toFixed(2)}</span>
                </div>

                <!-- Actions -->
                <div style="display: flex; gap: 10px;" class="no-print">
                    <button class="btn-primary" onclick="window.print()" style="flex: 1; height:40px; background:#00e5b4; color:#000;">Print Receipt</button>
                    <button class="btn-secondary" onclick="document.getElementById('receiptModal').remove()" style="flex: 1; height:40px;">Close</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML("beforeend", receiptHTML);
}

/* ============================================================
   ORDER HISTORY
   ============================================================ */
async function getOrderHistory() {
    if (!db) return [];
    
    const session = localStorage.getItem("rdx_session");
    if (!session) return [];
    
    try {
        const email = JSON.parse(session).email;
        const snap = await db.collection("orders").where("userEmail", "==", email).get();
        const orders = [];
        
        snap.forEach(doc => orders.push(doc.data()));
        orders.sort((a, b) => parseInt(b.orderId.replace("RDX-", "")) - parseInt(a.orderId.replace("RDX-", "")));
        
        return orders;
    } catch (err) {
        console.error("Failed to load order history:", err);
        return [];
    }
}

/* ============================================================
   DASHBOARD PAGE & ECOSYSTEM ACTIVITY FEATURE (Task 3 & 6 PFPs)
   ============================================================ */
async function renderDashboardPage() {
    const session = localStorage.getItem("rdx_session");
    if (!session) { window.location.href = "index.html"; return; }
    
    const user = JSON.parse(session);
    
    // Set user info
    if (document.getElementById("welcomeGreeting")) {
        document.getElementById("welcomeGreeting").innerText = `Welcome back, ${user.name.split(' ')[0]}.`;
    }
    if (document.getElementById("userName")) document.getElementById("userName").innerText = user.name;
    if (document.getElementById("userEmail")) document.getElementById("userEmail").innerText = user.email;
    
    // REDESIGNED ACCOUNT DASHBOARD PROFILE PICTURE (PFP) HUD (Task 6)
    const pfpFrame = document.getElementById("avatarInitial");
    if (pfpFrame && db) {
        pfpFrame.className = "pfp-outer-frame";
        try {
            const udoc = await db.collection("users").doc(user.email).get();
            const savedUrl = udoc.exists ? udoc.data().pfpUrl : "";
            const isManager = udoc.exists && udoc.data().role === "admin";
            
            if (savedUrl) {
                pfpFrame.innerHTML = `
                    <img src="${savedUrl}" class="pfp-display-img" alt="PFP">
                    <span class="pfp-badge-label">${isManager ? 'Admin' : 'Member'}</span>
                `;
            } else {
                pfpFrame.innerHTML = `
                    <div style="font-family:'Syne', sans-serif; font-weight:800; font-size:1.6rem; color:#00e5b4;">${user.name.charAt(0).toUpperCase()}</div>
                    <span class="pfp-badge-label">${isManager ? 'Admin' : 'Member'}</span>
                `;
            }
        } catch (e) { console.error("PFP HUD Load Error:", e); }
    }
    
    // Check for admin role
    try {
        const udoc = await db.collection("users").doc(user.email).get();
        if (udoc.exists && udoc.data().role === "admin" && !document.getElementById("adminPortalBtn")) {
            document.getElementById("dashHeaderActions")?.insertAdjacentHTML("beforeend", `
                <a href="admin.html" id="adminPortalBtn" class="btn-secondary" style="text-decoration:none; border-color:#00e5b4; color:#00e5b4; height: 46px;">Admin Console</a>
            `);
        }
    } catch (e) { console.warn("Admin check failed:", e); }
    
    // Get orders
    const orders = await getOrderHistory();
    
    // Get active subscription
    const activeSub = await getActiveSubscription();
    const planEl = document.getElementById("kpiPlanVal");
    if (planEl) {
        planEl.innerText = activeSub || "No Active Plan";
        planEl.style.color = activeSub ? "#00e5b4" : "rgba(255,255,255,0.5)";
        planEl.style.fontSize = activeSub ? "1.6rem" : "1.15rem";
        
        // Colors from specific subscription tier identities (Task 1 Alignment)
        if (activeSub.toLowerCase().includes("regular")) {
            planEl.className = "dash-kpi-value plan-regular-text";
        } else if (activeSub.toLowerCase().includes("dynamic")) {
            planEl.className = "dash-kpi-value plan-dynamic-text";
        } else if (activeSub.toLowerCase().includes("xtreme")) {
            planEl.className = "dash-kpi-value plan-xtreme-text";
        }
    }
    
    // Calculate total impact e-waste value (Task 3 Activity Sync)
    let totalWeightKg = 0;
    let addedDigital = false;

    orders.forEach(order => {
        (order.items || []).forEach(item => {
            const title = (item.title || "").toLowerCase();
            const qty = item.quantity || 1;
            
            if (item.type === "Subscription") {
                // Digital products count as a one-time activity contribution only (Task 3)
                if (!addedDigital) {
                    totalWeightKg += 1.5; 
                    addedDigital = true;
                }
            } else {
                // Physical products accumulate dynamically per event purchase quantity (Task 3)
                if (title.includes("macbook") || title.includes("laptop")) {
                    totalWeightKg += (1.4 * qty);
                } else if (title.includes("rtx") || title.includes("gpu") || title.includes("component")) {
                    totalWeightKg += (1.1 * qty);
                } else if (title.includes("iphone") || title.includes("samsung") || title.includes("phone") || title.includes("pixel")) {
                    totalWeightKg += (0.18 * qty);
                } else {
                    totalWeightKg += (0.2 * qty);
                }
            }
        });
    });

    // Populate overall KPI and Activity gauges correctly
    if (document.getElementById("kpiSpentVal")) {
        const spent = orders.reduce((sum, o) => sum + (o.total || 0), 0);
        document.getElementById("kpiSpentVal").innerText = `$${spent.toFixed(2)}`;
    }
    if (document.getElementById("kpiOrdersVal")) document.getElementById("kpiOrdersVal").innerText = orders.length;
    if (document.getElementById("kpiEwasteVal")) document.getElementById("kpiEwasteVal").innerText = `${totalWeightKg.toFixed(2)} kg`;
    if (document.getElementById("chartDivertedVal")) document.getElementById("chartDivertedVal").innerText = `${totalWeightKg.toFixed(2)} kg`;
    if (document.getElementById("cntOrders")) document.getElementById("cntOrders").innerText = orders.length;
    if (document.getElementById("cntWeight")) document.getElementById("cntWeight").innerText = totalWeightKg.toFixed(2);
    
    renderDashboardTransmissions(orders);
    renderRecentlyViewedShelf();
    
    // Protection level
    let protectionPercent = 15;
    if (activeSub) {
        const subLower = activeSub.toLowerCase();
        if (subLower.includes("regular")) protectionPercent = 45;
        else if (subLower.includes("dynamic")) protectionPercent = 75;
        else if (subLower.includes("xtreme")) protectionPercent = 95;
    } else if (orders.length > 0) {
        protectionPercent = Math.min(35, 15 + (orders.length * 5));
    }

    const gaugeText = document.getElementById("gaugePercentText");
    const gaugeCircle = document.getElementById("circularGauge");
    if (gaugeText) gaugeText.innerText = `${protectionPercent}%`;
    if (gaugeCircle) {
        gaugeCircle.style.background = `conic-gradient(#00e5b4 ${protectionPercent}%, rgba(255,255,255,0.05) ${protectionPercent}%)`;
    }
}

function renderDashboardTransmissions(orders) {
    const container = document.getElementById("dashboardTransmissions");
    if (!container) return;
    
    container.innerHTML = "";
    if (orders.length === 0) {
        container.innerHTML = `<div class="order-history-empty">No orders found.</div>`;
        return;
    }
    
    orders.slice(0, 4).forEach(o => {
        const isDigital = o.isDigital || o.items?.every(item => item.type === "Subscription");
        container.insertAdjacentHTML("beforeend", `
            <div class="order-history-item">
                <div class="order-history-item-header">
                    <span>${o.date} · ${o.orderId}</span>
                    <strong>$${(o.total || 0).toFixed(2)}</strong>
                </div>
                <div style="display: flex; gap: 8px; align-items: center; margin-top: 8px;">
                    <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; height: 28px; border-color: #00e5b4; color: #00e5b4;" onclick="viewInlineReceipt('${o.orderId}')">View Receipt</button>
                    ${!isDigital ? `<a href="tracking.html?id=${o.orderId}" class="review-edit-link" style="text-decoration:none; font-weight:600;">Track Shipment →</a>` : `<span style="font-size:0.75rem; color:#00e5b4; font-weight:500;">Plan Active</span>`}
                </div>
            </div>
        `);
    });
}

/* ============================================================
   RECENTLY VIEWED GRID REDESIGN (Task 4)
   ============================================================ */
function renderRecentlyViewedShelf() {
    const container = document.getElementById("viewedRow");
    if (!container) return;
    
    const viewed = getRecentlyViewed();
    if (document.getElementById("cntViewed")) document.getElementById("cntViewed").innerText = viewed.length;
    
    container.innerHTML = "";
    if (viewed.length === 0) {
        container.innerHTML = `<div class="viewed-empty-state" style="grid-column: span 4; text-align: center; padding: 40px 0; color: rgba(255,255,255,0.35);">No recently viewed hardware items.</div>`;
        return;
    }
    
    // Beautiful, clean e-commerce cards (Task 4 Redesign)
    viewed.forEach(item => {
        container.insertAdjacentHTML("beforeend", `
            <div class="viewed-item-card text-left">
                <div class="viewed-item-img-container">
                    <img class="viewed-item-img" src="${item.imagePath}" alt="${item.title}">
                </div>
                <div class="viewed-item-meta">
                    <h5>${item.title}</h5>
                    <span class="price">${item.price}</span>
                </div>
            </div>
        `);
    });
}

/* ============================================================
   SETTINGS PAGE REDESIGN WITH ACCOUNT MODULES (Task 5)
   ============================================================ */
async function renderSettingsPage() {
    const session = localStorage.getItem("rdx_session");
    if (!session) { window.location.href = "index.html"; return; }
    
    const user = JSON.parse(session);
    
    if (document.getElementById("sidebarUserName")) document.getElementById("sidebarUserName").innerText = user.name;
    if (document.getElementById("sidebarUserEmail")) document.getElementById("sidebarUserEmail").innerText = user.email;
    
    // HUD profile picture layout (Task 6)
    const avatar = document.getElementById("accountAvatarInitial");
    if (avatar && db) {
        avatar.className = "pfp-outer-frame";
        try {
            const udoc = await db.collection("users").doc(user.email).get();
            const savedUrl = udoc.exists ? udoc.data().pfpUrl : "";
            if (savedUrl) {
                avatar.innerHTML = `<img src="${savedUrl}" class="pfp-display-img" alt="PFP">`;
            } else {
                avatar.innerHTML = `<div style="font-family:'Syne', sans-serif; font-weight:800; font-size:1.2rem; color:#00e5b4;">${user.name.charAt(0).toUpperCase()}</div>`;
            }
        } catch (e) { console.error(e); }
    }
    
    const welcomeTitle = document.getElementById("welcomeUserTitle");
    if (welcomeTitle) welcomeTitle.innerText = `Welcome, ${user.name.split(' ')[0]}`;

    // Load active subscription indicators
    const activeSub = await getActiveSubscription();
    const profileTier = document.getElementById("profileTier");
    if (profileTier) {
        if (activeSub) {
            profileTier.innerText = `${activeSub} - Active`;
            profileTier.style.color = "#00e5b4";
        } else {
            profileTier.innerText = "No Active Plan";
            profileTier.style.color = "rgba(255, 255, 255, 0.5)";
        }
    }

    const planHud = document.getElementById("hudEcosystemPlan");
    if (planHud) {
        planHud.innerText = activeSub || "Basic Ecosystem";
        planHud.style.color = activeSub ? "#00e5b4" : "rgba(255, 255, 255, 0.5)";
        if (activeSub.toLowerCase().includes("regular")) planHud.className = "hud-value plan-regular-text";
        else if (activeSub.toLowerCase().includes("dynamic")) planHud.className = "hud-value plan-dynamic-text";
        else if (activeSub.toLowerCase().includes("xtreme")) planHud.className = "hud-value plan-xtreme-text";
    }
    
    // Inject the refined settings module grids dynamically inside #panelProfile (Task 1 Combined Modules)
    const profilePanel = document.getElementById("panelProfile");
    if (profilePanel && db) {
        try {
            const udoc = await db.collection("users").doc(user.email).get();
            const savedPfp = udoc.exists ? udoc.data().pfpUrl || "" : "";
            
            profilePanel.innerHTML = `
                <span class="plan-tag">Settings Console</span>
                <h2 class="account-panel-title">Profile &amp; Account Security</h2>
                
                <div class="settings-menu-grid">
                    <!-- Column 1: Profile & Identity details -->
                    <div class="settings-card-module">
                        <h3>Identity Details</h3>
                        <div class="settings-input-group">
                            <label>Display Name</label>
                            <input type="text" id="setDisplayName" value="${escapeAttr(user.name)}" required>
                        </div>
                        <div class="settings-input-group">
                            <label>Profile Picture Control</label>
                            <p style="font-size: 0.8rem; color: rgba(255,255,255,0.45); line-height:1.4; margin: 0 0 4px;">Click your profile picture in the sidebar to upload a new avatar natively from your device.</p>
                        </div>
                        <button onclick="saveProfileSettings()" class="btn-primary" style="margin-top:10px;">Save Profile Changes</button>
                    </div>

                    <!-- Column 2: Connected Google OAuth Security HUD (Task 1) -->
                    <div class="settings-card-module">
                        <h3>Google Authentication</h3>
                        <p style="font-size:0.8rem; color:rgba(255,255,255,0.45); line-height:1.5;">This account is securely connected via Google Single-Sign-On. Access and password changes are securely validated via Google OAuth servers.</p>
                        <div class="oauth-connected-hud">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            <div>
                                <strong style="display:block; color:#fff; font-size:0.83rem;">OAuth Session Secured</strong>
                                <span style="font-family:'Space Mono', monospace; font-size:0.75rem;">${escapeHtml(user.email)}</span>
                            </div>
                        </div>
                        <button onclick="deleteAccountPermanently()" class="cart-remove-btn" style="width:100%; margin-top:10px; height:44px; border-radius:10px;">Delete Account Permanently</button>
                    </div>
                </div>
            `;
        } catch (err) { console.error("Settings load failed:", err); }
    }

    // REDESIGNED TIERS AND CARE SUBSCRIPTIONS (Task 3 Brand Color Subscription Cards)
    const subscriptionPanel = document.getElementById("subscriptionTiersGrid");
    if (subscriptionPanel) {
        subscriptionPanel.innerHTML = `
                <!-- Regular Plan Card -->
                <div class="settings-tier-card regular ${activeSub.toLowerCase().includes("regular") ? 'active-plan' : ''}">
                    <div>
                        <h3>Regular Plan</h3>
                        <div class="price">$8.99</div>
                        <div class="desc">Standard care diagnostics, battery swaps, screen alignments, and 30-day warranty coverage windows.</div>
                    </div>
                    <div class="settings-tier-card-actions">
                        ${activeSub.toLowerCase().includes("regular") ? `
                            <button onclick="cancelSubscriptionPlan()" class="cart-remove-btn" style="width:100%; height:40px; border-radius:8px;">Cancel Coverage</button>
                        ` : `
                            <button onclick="upgradeSubscriptionPlan('Regular Plan')" class="btn-primary" style="width:100%; height:40px; border-radius:8px; background:#00b8d9 !important; box-shadow: 0 4px 12px rgba(0, 184, 217, 0.15) !important;">
                                ${activeSub ? 'Change to Regular' : 'Select Plan'}
                            </button>
                        `}
                    </div>
                </div>

                <!-- Dynamic Plan Card -->
                <div class="settings-tier-card dynamic ${activeSub.toLowerCase().includes("dynamic") ? 'active-plan' : ''}">
                    <div>
                        <h3>Dynamic Plan</h3>
                        <div class="price">$17.99</div>
                        <div class="desc">Priority 24h diagnostic turnaround cycles, OEM top-grade alignment components, and extended 90-day coverage guarantees.</div>
                    </div>
                    <div class="settings-tier-card-actions">
                        ${activeSub.toLowerCase().includes("dynamic") ? `
                            <button onclick="cancelSubscriptionPlan()" class="cart-remove-btn" style="width:100%; height:40px; border-radius:8px;">Cancel Coverage</button>
                        ` : `
                            <button onclick="upgradeSubscriptionPlan('Dynamic Plan')" class="btn-primary" style="width:100%; height:40px; border-radius:8px; background:#00e5b4 !important; box-shadow: 0 4px 12px rgba(0, 229, 180, 0.15) !important;">
                                ${activeSub ? 'Change to Dynamic' : 'Select Plan'}
                            </button>
                        `}
                    </div>
                </div>

                <!-- Xtreme Plan Card -->
                <div class="settings-tier-card xtreme ${activeSub.toLowerCase().includes("xtreme") ? 'active-plan' : ''}">
                    <div>
                        <h3>Xtreme Plan</h3>
                        <div class="price">$29.99</div>
                        <div class="desc">VIP same-day priority alignments, data backups, custom tuning adjustments, and lifetime warranty protection limits.</div>
                    </div>
                    <div class="settings-tier-card-actions">
                        ${activeSub.toLowerCase().includes("xtreme") ? `
                            <button onclick="cancelSubscriptionPlan()" class="cart-remove-btn" style="width:100%; height:40px; border-radius:8px;">Cancel Coverage</button>
                        ` : `
                            <button onclick="upgradeSubscriptionPlan('Xtreme Plan')" class="btn-primary" style="width:100%; height:40px; border-radius:8px; background:#ff7a00 !important; box-shadow: 0 4px 12px rgba(255, 122, 0, 0.15) !important;">
                                ${activeSub ? 'Upgrade to Xtreme' : 'Select Plan'}
                            </button>
                        `}
                    </div>
                </div>
        `;
    }
    
    // Load past transactions
    await renderOrderHistoryPanel();
    await calculateEwasteMetric();
}

/* ============================================================
   DIRECT PROFILE PICTURE UPLOAD FLOW (Task 1 Direct PFP Uploads)
   ============================================================ */
function triggerLocalPfpUpload() {
    // Avoid double trigger if already uploading
    const frame = document.getElementById("accountAvatarInitial");
    if (frame && frame.classList.contains("uploading")) return;
    document.getElementById("pfpFileInput")?.click();
}

async function handlePfpFileSelection(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate size (< 2MB) and MIME type
    if (file.size > 2 * 1024 * 1024) {
        showToast("Error: Profile picture must be smaller than 2MB.");
        return;
    }
    if (!file.type.startsWith("image/")) {
        showToast("Error: Selected file is not an image.");
        return;
    }

    // Set Loading Visual State (Task 1)
    const frame = document.getElementById("accountAvatarInitial");
    const originalHTML = frame ? frame.innerHTML : "";
    if (frame) {
        frame.classList.add("uploading");
        frame.innerHTML = `<div class="pfp-loader-overlay"><div class="pfp-spinner"></div></div>`;
    }

    const formData = new FormData();
    formData.append("imageFiles", file);

    try {
        const res = await fetch("/api/upload-bulk", { method: "POST", body: formData });
        const data = await res.json();
        
        if (data.imagePaths && data.imagePaths.length > 0) {
            const uploadedPath = data.imagePaths[0];
            const session = localStorage.getItem("rdx_session");
            if (session) {
                const email = JSON.parse(session).email;
                await db.collection("users").doc(email).update({ pfpUrl: uploadedPath });
                showToast("Profile picture updated successfully.");
                
                if (window.location.pathname.includes("settings.html")) await renderSettingsPage();
                if (window.location.pathname.includes("dashboard.html")) await renderDashboardPage();
            }
        } else {
            throw new Error(data.error || "PFP upload failed.");
        }
    } catch (e) {
        console.error("PFP upload error:", e);
        showToast("Error: Failed to upload profile picture.");
        if (frame) {
            frame.classList.remove("uploading");
            frame.innerHTML = originalHTML;
        }
    }
}

async function saveProfileSettings() {
    const session = localStorage.getItem("rdx_session");
    if (!session || !db) return;
    
    const newName = document.getElementById("setDisplayName").value.trim();
    const newPfp = document.getElementById("setProfilePfpUrl").value.trim();

    if (!newName) { showToast("Display name cannot be left empty."); return; }

    try {
        const user = JSON.parse(session);
        await db.collection("users").doc(user.email).update({
            name: newName,
            pfpUrl: newPfp
        });
        
        user.name = newName;
        localStorage.setItem("rdx_session", JSON.stringify(user));
        
        showToast("Profile settings saved successfully.");
        await renderSettingsPage();
    } catch (e) {
        console.error("Profile edit error:", e);
        showToast("Error updating credentials.");
    }
}

/* ============================================================
   PERMANENT ACCOUNT CANCELLATION (Task 1 Wiping Records)
   ============================================================ */
async function deleteAccountPermanently() {
    if (!db) return;
    const session = localStorage.getItem("rdx_session");
    if (!session) return;
    
    const email = JSON.parse(session).email;
    if (!confirm("Caution: This action is permanent. This will erase all diagnostic metrics and transaction history. Proceed?")) return;

    try {
        await db.collection("users").doc(email).delete();
        showToast("Account deleted successfully.");
        logUserOut();
    } catch (e) {
        console.error("Delete account error:", e);
        showToast("Error wiping profile.");
    }
}

/* ============================================================
   SUBSCRIPTIONS ROUTING AND CHANGE PLANS (Task 5 Flow)
   ============================================================ */
async function upgradeSubscriptionPlan(tier) {
    // Expected Flow: Select New Plan -> Add to Cart -> Normal Checkout (Task 5 Upgrade Flow)
    let priceString = "$8.99";
    if (tier.toLowerCase().includes("dynamic")) priceString = "$17.99";
    if (tier.toLowerCase().includes("xtreme")) priceString = "$29.99";

    showToast(`Plan selected: "${tier}". Directing to Checkout...`);
    
    // Clear any existing subscriptions first to avoid duplicate plans in cart
    localCartState = localCartState.filter(item => item.type !== "Subscription");
    
    // Add plan as a product item into cart
    await addToCart(tier, priceString, "Subscription", `Digital Membership - ${tier}`);
    
    // Direct instantly to checkout (Task 5 Flow)
    setTimeout(() => {
        window.location.href = "checkout.html";
    }, 800);
}

/* ============================================================
   PROPER MULTI-STEP CANCELLATION FLOW (Task 5 Cancellation)
   ============================================================ */
let pendingCancellationUserEmail = "";

function cancelSubscriptionPlan() {
    const session = localStorage.getItem("rdx_session");
    if (!session) return;
    
    pendingCancellationUserEmail = JSON.parse(session).email;
    
    // Show confirmation modal screen instead of immediate cancellation (Task 5)
    const modal = document.getElementById("cancelSubscriptionModal");
    if (modal) modal.style.display = "flex";
}

function closeSubscriptionCancellationModal() {
    const modal = document.getElementById("cancelSubscriptionModal");
    if (modal) modal.style.display = "none";
    pendingCancellationUserEmail = "";
}

async function confirmSubscriptionPlanCancellation() {
    if (!db || !pendingCancellationUserEmail) return;

    try {
        await db.collection("users").doc(pendingCancellationUserEmail).update({
            activeSubscription: ""
        });
        
        localStorage.removeItem("rdx_active_subscription" + getActiveUserSuffix());
        showToast("Ecosystem subscription plan cancelled.");
        closeSubscriptionCancellationModal();
        await renderSettingsPage();
    } catch (e) {
        console.error(e);
        showToast("Error cancelling subscription plan.");
    }
}

async function renderOrderHistoryPanel() {
    const container = document.getElementById("orderHistoryList");
    if (!container) return;
    
    const orders = await getOrderHistory();
    container.innerHTML = "";
    
    if (!orders || orders.length === 0) {
        container.innerHTML = `<div class="order-history-empty">No transactions found.</div>`;
        return;
    }
    
    orders.forEach(o => {
        let itemsHTML = "";
        if (o.items && Array.isArray(o.items)) {
            o.items.forEach(i => {
                let planColorClass = "";
                if (i.type === "Subscription") {
                    if (i.title.toLowerCase().includes("regular")) planColorClass = "plan-regular-text";
                    else if (i.title.toLowerCase().includes("dynamic")) planColorClass = "plan-dynamic-text";
                    else if (i.title.toLowerCase().includes("xtreme")) planColorClass = "plan-xtreme-text";
                } else {
                    planColorClass = "product-brand-text";
                }

                itemsHTML += `
                    <div class="order-history-product-row">
                        <span class="${planColorClass}">${i.title} (x${i.quantity})</span>
                        <span>$${(i.numericPrice * i.quantity).toFixed(2)}</span>
                    </div>
                `;
            });
        }
        
        const isDigital = o.isDigital || o.items?.every(item => item.type === "Subscription");

        container.insertAdjacentHTML("beforeend", `
            <div class="order-history-item">
                <div class="order-history-item-header">
                    <span>${o.date} · ${o.orderId}</span>
                    <strong>$${(o.total || 0).toFixed(2)}</strong>
                </div>
                <div class="order-history-products">${itemsHTML || '<p style="color:rgba(255,255,255,0.4); font-size:0.85rem;">No items found.</p>'}</div>
                <div style="margin-top:14px; border-top:1px solid rgba(255,255,255,0.03); padding-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <button class="btn-secondary" style="padding:6px 12px; font-size:0.75rem; height: 28px; border-color:#00e5b4; color:#00e5b4;" onclick="viewInlineReceipt('${o.orderId}')">View Receipt</button>
                    ${!isDigital ? `<a href="tracking.html?id=${o.orderId}" class="review-edit-link" style="text-decoration:none; font-weight:600;">Track Shipment →</a>` : `<span style="font-size:0.8rem; color:#00e5b4; font-weight: 500;">Activated</span>`}
                </div>
            </div>
        `);
    });
}

function switchSettingsPanel(panelId) {
    document.querySelectorAll('.account-nav-item').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const activeBtn = document.querySelector(`.account-nav-item[data-panel="${panelId}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.account-content .account-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    const targetPanelId = "panel" + panelId.charAt(0).toUpperCase() + panelId.slice(1);
    const targetPanel = document.getElementById(targetPanelId);
    if (targetPanel) targetPanel.classList.add('active');
}

/* ============================================================
   RECENTLY VIEWED
   ============================================================ */
function getRecentlyViewed() { 
    const k = "rdx_recently_viewed" + getActiveUserSuffix(); 
    const v = localStorage.getItem(k); 
    return v ? JSON.parse(v) : []; 
}

function trackRecentlyViewed(title, price, imagePath) {
    const k = "rdx_recently_viewed" + getActiveUserSuffix();
    let v = getRecentlyViewed();
    v = v.filter(i => i.title !== title);
    v.unshift({ title, price, imagePath });
    localStorage.setItem(k, JSON.stringify(v.slice(0, 8)));
}

function clearRecentlyViewed() { 
    localStorage.removeItem("rdx_recently_viewed" + getActiveUserSuffix()); 
    renderRecentlyViewedShelf(); 
}

/* ============================================================
   STORE CATALOG
   ============================================================ */
async function loadDynamicStoreCatalog() {
    const grid = document.getElementById("dynamicProductsGrid");
    if (!grid) return;
    
    try {
        if (!db) { 
            grid.innerHTML = `<p style="grid-column: span 4; text-align: center; color: #ff7a00;">Database offline.</p>`;
            return; 
        }
        
        const snap = await db.collection("products").get();
        if (snap.empty) {
            grid.innerHTML = `<p style="grid-column: span 4; text-align: center; color: rgba(255,255,255,0.4);">No products available. Coming soon!</p>`;
            return;
        }

        grid.innerHTML = "";
        snap.forEach(doc => {
            const p = doc.data();
            const docId = doc.id;
            const stockLevel = parseInt(p.stock, 10) || 0;
            const isOutOfStock = stockLevel <= 0;
            
            dynamicStoreCatalogCache[docId] = p;

            const cardHTML = `
                <div class="gallery-card reveal active" data-category="${p.category}">
                    <div class="gallery-image">
                        <img src="${p.imagePath || '/images_copy/logo.svg'}" alt="${p.title}">
                    </div>
                    <div class="gallery-info">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap: 8px;">
                            <h3>${p.title}</h3>
                            ${isOutOfStock ? `<span style="font-size:0.65rem; color:#ff7a00; border:1px solid #ff7a00; padding:2px 8px; border-radius:100px; white-space:nowrap;">SOLD OUT</span>` : ''}
                        </div>
                        <p class="price">${p.price}</p>
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <button class="btn-view" style="padding: 8px; font-size: 0.75rem; flex: 1;" 
                                    onclick="triggerProductInspect('${docId}')">Inspect</button>
                            
                            <button class="btn-primary" style="padding: 8px; font-size: 0.75rem; flex: 1; background: ${isOutOfStock ? 'rgba(255,255,255,0.05)' : '#00e5b4'}; color: ${isOutOfStock ? 'rgba(255,255,255,0.25)' : '#000'};" 
                                    ${isOutOfStock ? 'disabled style="pointer-events: none;"' : ''}
                                    onclick="triggerProductAddToCart('${docId}')">
                                    ${isOutOfStock ? 'Sold Out' : 'Add'}
                            </button>
                        </div>
                    </div>
                </div>
            `;
            grid.insertAdjacentHTML("beforeend", cardHTML);
        });
        
        // Auto-run status label compilations
        filterStoreCatalog();
    } catch (e) {
        console.error("Store load error:", e);
        grid.innerHTML = `<p style="grid-column: span 4; text-align: center; color: #ff7a00;">Error loading products: ${e.message}</p>`;
    }
}

function triggerProductInspect(docId) {
    const p = dynamicStoreCatalogCache[docId];
    if (!p) return;
    openProductSpecs(p.title, p.price, p.desc, p.imagePath, p.altImages || [], p.specs || "", p.stock, docId);
}

function triggerProductAddToCart(docId) {
    const p = dynamicStoreCatalogCache[docId];
    if (!p) return;
    
    const cartItemIdx = localCartState.findIndex(item => item.title === p.title);
    const currentQtyInCart = cartItemIdx > -1 ? localCartState[cartItemIdx].quantity : 0;
    const stockLimit = parseInt(p.stock, 10) || 0;
    
    if (currentQtyInCart + 1 > stockLimit) {
        showToast(`Only ${stockLimit} available.`);
        return;
    }
    
    addToCart(p.title, p.price, 'Hardware', p.desc, p.imagePath);
}

/* ============================================================
   DYNAMIC APPOINTMENT BOOKING PROCESSOR (Task 2 Booking & Availability)
   ============================================================ */
async function handleAppointmentBooking(event) {
    event.preventDefault();
    if (!db) return;

    const btn = document.getElementById("bookSubmitBtn");
    if (btn) { btn.disabled = true; btn.innerText = "Checking availability..."; }

    const name = document.getElementById("bookName").value.trim();
    const email = document.getElementById("bookEmail").value.trim();
    const phone = document.getElementById("bookPhone").value.trim();
    const device = document.getElementById("bookDevice").value;
    const date = document.getElementById("bookDate").value;
    const time = document.getElementById("bookTime").value;
    const issue = document.getElementById("bookIssue").value.trim();

    try {
        // Query database to prevent double bookings securely (Task 2)
        const conflictSnap = await db.collection("appointments")
            .where("date", "==", date)
            .where("time", "==", time)
            .where("status", "in", ["Pending", "Confirmed"])
            .get();

        if (!conflictSnap.empty) {
            showToast("Notice: Selected time slot is already booked. Please choose another date or time.");
            if (btn) { btn.disabled = false; btn.innerText = "Submit Appointment Request"; }
            return;
        }

        // Save appointment log (Task 2)
        await db.collection("appointments").add({
            name, email, phone, device, date, time, issue,
            status: "Pending",
            createdDate: new Date().toLocaleDateString("en-US")
        });

        showToast("Success: Your appointment request has been received. We will confirm your appointment shortly.");
        event.target.reset();
        
        if (window.location.pathname.includes("admin.html")) renderAdminAppointmentsBoard();

    } catch (e) {
        console.error("Booking error:", e);
        showToast("Error processing appointment scheduling.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Submit Appointment Request"; }
    }
}

async function validateAppointmentTimeSlots() {
    const dateInput = document.getElementById("bookDate");
    const select = document.getElementById("bookTime");
    if (!db || !dateInput || !select || !dateInput.value) return;

    // Soft validate day limits in client-side picker
    const selectedDate = new Date(dateInput.value + "T00:00:00");
    const today = new Date();
    today.setHours(0,0,0,0);

    if (selectedDate < today) {
        showToast("Error: Appointments cannot be scheduled for past dates.");
        dateInput.value = "";
        return;
    }
}

/* ============================================================
   CUSTOMER FEEDBACK & EXPERIENCE RATING SYSTEMS (Task 3)
   ============================================================ */
function selectFeedbackRate(rate) {
    document.getElementById("feedRatingVal").value = rate;
    document.querySelectorAll(".feedback-rating-row .rating-btn-node").forEach(btn => {
        const itemRate = parseInt(btn.getAttribute("data-rate"), 10);
        btn.classList.toggle("active-rate", itemRate === rate);
    });
}

async function handleFeedbackSubmission(event) {
    event.preventDefault();
    if (!db) return;

    const btn = document.getElementById("feedSubmitBtn");
    if (btn) { btn.disabled = true; btn.innerText = "Posting..."; }

    const name = document.getElementById("feedName").value.trim();
    const rating = parseInt(document.getElementById("feedRatingVal").value, 10) || 5;
    const message = document.getElementById("feedMessage").value.trim();
    const session = localStorage.getItem("rdx_session");

    if (!name || !message) {
        showToast("Error: All fields are required.");
        if (btn) { btn.disabled = false; btn.innerText = "Post Feedback"; }
        return;
    }

    try {
        await db.collection("feedback").add({
            name, rating, message,
            userEmail: session ? JSON.parse(session).email : "Guest Session",
            createdDate: new Date().toLocaleDateString("en-US")
        });

        showToast("Thank you for your feedback. We appreciate your input.");
        event.target.reset();
        selectFeedbackRate(5); // Reset stars to default

        if (window.location.pathname.includes("admin.html")) renderAdminFeedbackList();

    } catch (e) {
        console.error("Feedback submission failed:", e);
        showToast("Error: Failed to process feedback submission.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "Post Feedback"; }
    }
}

/* ============================================================
   ADMIN CONSOLE - APPOINTMENTS & FEEDBACK REVIEW MODULE (Task 6)
   ============================================================ */
async function renderAdminAppointmentsBoard() {
    const container = document.getElementById("adminAppointmentsGrid");
    if (!container) return;

    // Show loading state
    container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 20px 0;">Loading appointments...</p>`;

    try {
        if (!db) {
            container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:20px 0;">Database connection unavailable.</p>`;
            return;
        }

        const snap = await db.collection("appointments").get();
        container.innerHTML = "";

        if (snap.empty) {
            container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 20px 0;">No appointments have been scheduled yet.</p>`;
            return;
        }

        snap.forEach(doc => {
            const app = doc.data();
            const docId = doc.id;
            const status = app.status || "Pending";

            container.insertAdjacentHTML("beforeend", `
                <div class="admin-booking-card">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <strong style="font-size:0.95rem; color:#fff; display:block;">${app.name}</strong>
                            <span style="font-size:0.75rem; color:rgba(255,255,255,0.4);">${app.email} · ${app.phone}</span>
                        </div>
                        <span class="booking-status-badge ${status.toLowerCase()}">${status}</span>
                    </div>
                    <div style="font-size:0.82rem; color:rgba(255,255,255,0.6); padding:8px 0; border-top:1px solid rgba(255,255,255,0.03); border-bottom:1px solid rgba(255,255,255,0.03);">
                        <strong>Service:</strong> ${app.device}<br>
                        <strong>Date:</strong> ${app.date} @ ${app.time}<br>
                        <strong>Symptoms:</strong> "${app.issue}"
                    </div>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <button onclick="updateAppointmentStatus('${docId}', 'Confirmed')" class="btn-primary" style="flex:1; height:30px; font-size:0.72rem; padding:0; background:#00e5b4 !important;">Confirm</button>
                        <button onclick="updateAppointmentStatus('${docId}', 'Completed')" class="btn-secondary" style="flex:1; height:30px; font-size:0.72rem; padding:0; border-color:#00b8d9; color:#00b8d9;">Complete</button>
                        <button onclick="updateAppointmentStatus('${docId}', 'Cancelled')" class="cart-remove-btn" style="flex:1; height:30px; font-size:0.72rem; padding:0;">Cancel</button>
                    </div>
                </div>
            `);
        });

    } catch (e) { 
        console.error("Appointments load error:", e);
        container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:20px 0;">Unable to load appointments. Error: ${e.message || "Connection failed"}</p>`;
    }
}

async function renderAdminFeedbackList() {
    const container = document.getElementById("adminFeedbackGrid");
    if (!container) return;

    // Show loading state
    container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 20px 0;">Loading reviews...</p>`;

    try {
        if (!db) {
            container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:20px 0;">Database connection unavailable.</p>`;
            return;
        }

        const snap = await db.collection("feedback").get();
        container.innerHTML = "";

        if (snap.empty) {
            container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 20px 0;">No customer reviews have been submitted yet.</p>`;
            return;
        }

        snap.forEach(doc => {
            const feed = doc.data();
            const stars = Array(Math.min(feed.rating || 0, 5)).fill("★").join("");
            const emptyStars = Array(Math.max(0, 5 - (feed.rating || 0))).fill("☆").join("");

            container.insertAdjacentHTML("beforeend", `
                <div class="admin-booking-card" style="border-left:3px solid #00e5b4;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${feed.name || "Anonymous"}</strong>
                        <span style="font-family:'Space Mono', monospace; font-size:0.8rem; color:#00e5b4; font-weight:700;">${stars}${emptyStars} (${feed.rating || 0}/5)</span>
                    </div>
                    <p style="font-size:0.82rem; color:rgba(255,255,255,0.6); line-height:1.4;">"${feed.message || "No message"}"</p>
                    <span style="font-size:0.7rem; color:rgba(255,255,255,0.35); text-align:right;">Submitted: ${feed.createdDate || "Unknown date"}</span>
                </div>
            `);
        });

    } catch (e) { 
        console.error("Feedback loading error:", e);
        container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:20px 0;">Unable to load reviews. Error: ${e.message || "Connection failed"}</p>`;
    }
}

async function updateAppointmentStatus(docId, newStatus) {
    if (!db) {
        showToast("Database connection unavailable. Please refresh the page.");
        return;
    }
    try {
        await db.collection("appointments").doc(docId).update({ status: newStatus });
        showToast(`Appointment has been marked as: ${newStatus}`);
        await renderAdminAppointmentsBoard();
    } catch (e) {
        console.error("Appointment status update failed:", e);
        showToast(`Error updating appointment: ${e.message || "Unknown error"}`);
    }
}

/* ============================================================
   ADMIN CONSOLE - ORDERS & SHIPMENTS BOARD (Task 4)
   ============================================================ */
async function renderAdminOrdersBoard() {
    const container = document.getElementById("adminOrdersBoard");
    if (!container) return;
    if (!db) return;

    try {
        container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 40px 0;">Loading orders...</p>`;

        const snap = await db.collection("orders").get();
        allAdminOrders = [];
        snap.forEach(doc => allAdminOrders.push({ ...doc.data(), _docId: doc.id }));

        // Newest orders first
        allAdminOrders.sort((a, b) => {
            const aNum = parseInt((a.orderId || "").replace("RDX-", ""), 10) || 0;
            const bNum = parseInt((b.orderId || "").replace("RDX-", ""), 10) || 0;
            return bNum - aNum;
        });

        displayFilteredAdminOrders();
    } catch (e) {
        console.error("Admin orders load error:", e);
        container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:40px 0;">Error loading orders: ${e.message}</p>`;
    }
}

function setAdminStatusFilter(status) {
    activeAdminFilterStatus = status;
    document.getElementById("filterBtn-all")?.classList.toggle("active", status === "all");
    document.getElementById("filterBtn-pending")?.classList.toggle("active", status === "pending");
    document.getElementById("filterBtn-delivered")?.classList.toggle("active", status === "delivered");
    displayFilteredAdminOrders();
}

function displayFilteredAdminOrders() {
    const container = document.getElementById("adminOrdersBoard");
    if (!container) return;

    const searchTerm = (document.getElementById("adminSearchInput")?.value || "").toLowerCase().trim();

    let filtered = allAdminOrders.filter(o => {
        // Status filter
        const isDelivered = (o.shippingStatus || "").toLowerCase() === "delivered";
        if (activeAdminFilterStatus === "pending" && isDelivered) return false;
        if (activeAdminFilterStatus === "delivered" && !isDelivered) return false;

        // Search filter (Order ID, customer name, email, phone)
        if (!searchTerm) return true;
        const haystack = [
            o.orderId,
            o.customerName,
            o.userEmail,
            o.shippingDetails?.phone
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(searchTerm);
    });

    if (filtered.length === 0) {
        container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 40px 0;">No orders match this view.</p>`;
        return;
    }

    container.innerHTML = "";
    filtered.forEach(o => {
        const status = o.shippingStatus || "Processed";
        const isDelivered = status.toLowerCase() === "delivered";
        const pulseClass = isDelivered ? "in-stock" : "out-of-stock";
        const safeOrderId = o.orderId || o._docId;

        container.insertAdjacentHTML("beforeend", `
            <div class="admin-order-card">
                <div class="admin-order-header">
                    <div>
                        <strong style="font-family:'Space Mono', monospace; color:#fff;">${safeOrderId}</strong>
                        <span style="font-size:0.75rem; color:rgba(255,255,255,0.4); margin-left:10px;">${o.date || ""} · ${o.time || ""}</span>
                    </div>
                    <span style="font-size:0.78rem; color:${isDelivered ? "#00e5b4" : "#ff7a00"}; font-weight:600;">
                        <span class="status-pulse ${pulseClass}"></span> ${status}
                    </span>
                </div>
                <div style="font-size:0.85rem; color:rgba(255,255,255,0.7); line-height:1.6;">
                    <strong>${o.customerName || o.shippingDetails?.name || "Unknown Customer"}</strong><br>
                    ${o.userEmail || ""} · ${o.shippingDetails?.phone || "N/A"}<br>
                    ${o.shippingDetails?.address || "N/A"}
                </div>
                <div style="font-size:0.8rem; color:rgba(255,255,255,0.5); margin-top:8px;">
                    ${(o.items || []).length} item(s) · Total: $${o.total || "0.00"}
                </div>
                <div class="admin-control-row">
                    <input type="text" id="trackInput-${safeOrderId}" placeholder="Tracking number..." value="${o.trackingNumber && o.trackingNumber !== "Pending" ? o.trackingNumber : ""}" style="font-size:0.8rem; padding:8px 12px;">
                    <select id="statusSelect-${safeOrderId}" style="font-size:0.8rem; padding:8px 12px;">
                        <option value="Processed" ${status === "Processed" ? "selected" : ""}>Processed</option>
                        <option value="Received" ${status === "Received" ? "selected" : ""}>Received</option>
                        <option value="In Transit" ${status === "In Transit" ? "selected" : ""}>In Transit</option>
                        <option value="Delivered" ${status === "Delivered" ? "selected" : ""}>Delivered</option>
                    </select>
                    <button class="btn-primary" style="height:38px; font-size:0.75rem; padding:0 16px; background:#00e5b4; color:#000;" onclick="updateOrderShippingInfo('${safeOrderId}')">Update</button>
                </div>
            </div>
        `);
    });
}

async function updateOrderShippingInfo(orderId) {
    if (!db) return;
    const trackInput = document.getElementById(`trackInput-${orderId}`);
    const statusSelect = document.getElementById(`statusSelect-${orderId}`);
    if (!trackInput || !statusSelect) return;

    const newTracking = trackInput.value.trim() || "Pending";
    const newStatus = statusSelect.value;

    try {
        await db.collection("orders").doc(orderId).update({
            trackingNumber: newTracking,
            shippingStatus: newStatus
        });
        showToast(`Order ${orderId} updated.`);
        await renderAdminOrdersBoard();
    } catch (e) {
        console.error("Order update failed:", e);
        showToast("Error updating order.");
    }
}

/* ============================================================
   ADMIN MODAL SUB-TAB INITIALIZER WRAPPER
   ============================================================ */
async function initAdminPage() {
    const board = document.getElementById("adminOrdersBoard");
    if (!board) return;
    
    const s = localStorage.getItem("rdx_session");
    if (!s) { window.location.href = "index.html"; return; }
    
    try {
        const email = JSON.parse(s).email.toLowerCase().trim();
        const udoc = await db.collection("users").doc(email).get();
        
        if (!udoc.exists || udoc.data().role !== "admin") {
            board.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:40px 0;">Admin access required.</p>`;
            return;
        }
        
        // Initialize all admin panels
        renderAdminOrdersBoard();
        renderAdminAppointmentsBoard();
        renderAdminFeedbackList();
        renderAdminInventoryList();
    } catch (e) {
        console.error("Admin init failed:", e);
        board.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:40px 0;">Error: ${e.message}</p>`;
    }
}

function switchAdminSubTab(tabId) {
    document.getElementById("adminSection-orders").style.display = tabId === "orders" ? "block" : "none";
    document.getElementById("adminSection-inventory").style.display = tabId === "inventory" ? "block" : "none";
    document.getElementById("adminSection-bookings").style.display = tabId === "bookings" ? "block" : "none";
    document.getElementById("adminTabBtn-orders")?.classList.toggle("active", tabId === "orders");
    document.getElementById("adminTabBtn-inventory")?.classList.toggle("active", tabId === "inventory");
    document.getElementById("adminTabBtn-bookings")?.classList.toggle("active", tabId === "bookings");
    
    // Refresh content when tabs are switched
    if (tabId === "orders") renderAdminOrdersBoard();
    else if (tabId === "inventory") renderAdminInventoryList();
    else if (tabId === "bookings") {
        renderAdminAppointmentsBoard();
        renderAdminFeedbackList();
    }
}

async function handleAdminAddProduct(e) {
    e.preventDefault();
    if (!db) {
        showToast("Database connection unavailable. Please refresh the page.");
        return;
    }
    
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = "Saving..."; }

    const title = document.getElementById("addProdTitle").value.trim();
    const price = document.getElementById("addProdPrice").value.trim();
    const stock = parseInt(document.getElementById("addProdStock").value, 10);
    const category = document.getElementById("addProdCategory").value;
    const desc = document.getElementById("addProdDesc").value.trim();
    
    const specStorage = document.getElementById("addProdSpecStorage").value.trim();
    const specDisplay = document.getElementById("addProdSpecDisplay").value.trim();
    const specChip = document.getElementById("addProdSpecChip").value.trim();
    const specCamera = document.getElementById("addProdSpecCamera").value.trim();
    const specs = `Storage:${specStorage || ""};Display:${specDisplay || ""};Chip:${specChip || ""};Camera:${specCamera || ""}`;

    // Validation
    if (!title) {
        showToast("Please enter a product title.");
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
        return;
    }
    if (!price) {
        showToast("Please enter a price.");
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
        return;
    }
    if (isNaN(stock) || stock < 0) {
        showToast("Stock quantity must be a number of 0 or more.");
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
        return;
    }
    if (!category) {
        showToast("Please select a category.");
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
        return;
    }
    if (!desc) {
        showToast("Please enter a product description.");
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
        return;
    }

    const mainFile = document.getElementById("addProdFileMain").files[0];
    const altFile1 = document.getElementById("addProdFileAlt1").files[0];
    const altFile2 = document.getElementById("addProdFileAlt2").files[0];

    let imagePath = "/images_copy/logo.svg";
    let altImages = [];

    try {
        // Upload images if provided
        if (mainFile) {
            const formData = new FormData();
            if (mainFile) formData.append("imageFiles", mainFile);
            if (altFile1) formData.append("imageFiles", altFile1);
            if (altFile2) formData.append("imageFiles", altFile2);

            const uploadRes = await fetch("/api/upload-bulk", { method: "POST", body: formData });
            if (!uploadRes.ok) throw new Error("Image upload server error. Please try again.");
            
            const uploadData = await uploadRes.json();
            if (uploadData.error) throw new Error(uploadData.error);
            if (uploadData.imagePaths && uploadData.imagePaths.length > 0) {
                imagePath = uploadData.imagePaths[0];
                altImages = uploadData.imagePaths.slice(1);
            } else {
                throw new Error("Image upload failed. Please try again.");
            }
        }

        const docKey = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const newProduct = { 
            title, 
            price, 
            stock, 
            category, 
            imagePath, 
            desc, 
            specs, 
            altImages,
            createdAt: new Date().toISOString()
        };
        
        await db.collection("products").doc(docKey).set(newProduct);
        showToast(`Product "${title}" has been successfully added to the catalog.`);
        
        // Reset form
        e.target.reset();
        document.getElementById("labelMain").innerText = "Main Photo";
        document.getElementById("labelMain").style.color = "";
        document.getElementById("labelAlt1").innerText = "Inspect 1";
        document.getElementById("labelAlt1").style.color = "";
        document.getElementById("labelAlt2").innerText = "Inspect 2";
        document.getElementById("labelAlt2").style.color = "";
        
        renderAdminInventoryList();
    } catch (err) {
        console.error("Product add failed:", err);
        showToast(`Error adding product: ${err.message || "Unknown error"}`);
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Add to Inventory"; }
    }
}

async function renderAdminInventoryList() {
    const container = document.getElementById("adminInventoryGrid");
    if (!container) return;
    
    // Show loading state
    container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 40px 0;">Loading inventory...</p>`;
    
    try {
        if (!db) {
            container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:40px 0;">Database connection unavailable. Please refresh the page.</p>`;
            return;
        }

        const snap = await db.collection("products").get();
        container.innerHTML = "";
        
        if (snap.empty) {
            container.innerHTML = `<p style="color: rgba(255,255,255,0.45); text-align: center; padding: 40px 0;">No products in catalog. Use the form above to add the first item.</p>`;
            return;
        }

        snap.forEach(doc => {
            const p = doc.data();
            const docId = doc.id;
            const stock = parseInt(p.stock, 10) || 0;
            const isOut = stock <= 0;
            const isEditing = activeAdminEditProductId === docId;
            const specs = parseSpecsString(p.specs || "");

            dynamicStoreCatalogCache[docId] = p;

            if (isEditing) {
                container.insertAdjacentHTML("beforeend", `
                    <div class="inventory-feed-item" style="display:block;">
                        <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:10px;">
                            <input type="text" id="editProdTitle-${docId}" value="${escapeAttr(p.title || "")}" placeholder="Title" style="padding:8px; font-size:0.8rem;">
                            <input type="text" id="editProdPrice-${docId}" value="${escapeAttr(p.price || "")}" placeholder="Price" style="padding:8px; font-size:0.8rem;">
                            <input type="number" id="editProdStock-${docId}" value="${stock}" min="0" placeholder="Stock" style="padding:8px; font-size:0.8rem;">
                            <select id="editProdCategory-${docId}" style="padding:8px; font-size:0.8rem;">
                                <option value="smartphones" ${p.category === "smartphones" ? "selected" : ""}>Smartphones</option>
                                <option value="components" ${p.category === "components" ? "selected" : ""}>Components</option>
                                <option value="laptops" ${p.category === "laptops" ? "selected" : ""}>Laptops</option>
                            </select>
                            <input type="text" id="editProdSpecStorage-${docId}" value="${escapeAttr(specs.Storage || "")}" placeholder="Storage" style="padding:8px; font-size:0.8rem;">
                            <input type="text" id="editProdSpecDisplay-${docId}" value="${escapeAttr(specs.Display || "")}" placeholder="Display" style="padding:8px; font-size:0.8rem;">
                            <input type="text" id="editProdSpecChip-${docId}" value="${escapeAttr(specs.Chip || "")}" placeholder="Chip" style="padding:8px; font-size:0.8rem;">
                            <input type="text" id="editProdSpecCamera-${docId}" value="${escapeAttr(specs.Camera || "")}" placeholder="Camera" style="padding:8px; font-size:0.8rem;">
                        </div>
                        <textarea id="editProdDesc-${docId}" placeholder="Description" style="width:100%; height:70px; padding:8px; font-size:0.8rem; margin-bottom:10px;">${escapeHtml(p.desc || "")}</textarea>
                        <div style="display:flex; gap:8px; justify-content:flex-end;">
                            <button onclick="cancelProductEdit()" style="background:none; border:1px solid rgba(255,255,255,0.15); color:#fff; border-radius:8px; padding:7px 12px; cursor:pointer; font-size:0.75rem;">Cancel</button>
                            <button onclick="saveProductEdit('${docId}')" class="btn-primary" style="width:auto; padding:7px 14px; font-size:0.75rem; background:#00e5b4; color:#000;">Save Item</button>
                        </div>
                    </div>
                `);
                return;
            }

            container.insertAdjacentHTML("beforeend", `
                <div class="inventory-feed-item">
                    <img src="${p.imagePath || '/images_copy/logo.svg'}" style="width: 44px; height: 44px; object-fit: contain; border-radius: 8px; background: #000;">
                    <div style="flex-grow: 1; min-width: 0;">
                        <strong style="font-size:0.88rem; color:#fff; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.title}</strong>
                        <div style="display: flex; align-items: center; gap: 6px; font-size:0.75rem; color:${isOut ? '#ff7a00' : 'rgba(255,255,255,0.4)'}; margin-top:2px;">
                            <span class="status-pulse ${isOut ? 'out-of-stock' : 'in-stock'}"></span>
                            ${isOut ? 'SOLD OUT' : `${stock} in stock`}
                        </div>
                    </div>
                    <div style="display:flex; gap:6px; align-items:center; flex-shrink: 0;">
                        <input type="number" id="updateStockInput-${docId}" value="${stock}" style="width:65px; padding:6px; font-size:0.8rem; text-align:center; margin-bottom: 0;">
                        <button onclick="updateStockLevel('${docId}')" class="btn-primary" style="width:auto; padding:6px 12px; font-size:0.75rem; background:#00e5b4; color:#000;">Set</button>
                        <button onclick="editProduct('${docId}')" style="background:none; border:1px solid #00e5b4; color:#00e5b4; border-radius:8px; padding:6px 12px; cursor:pointer; font-size:0.75rem;">Edit</button>
                        <button onclick="deleteProduct('${docId}')" style="background: none; border: 1px solid #ff7a00; color: #ff7a00; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 0.75rem;">Delete</button>
                    </div>
                </div>
            `);
        });
    } catch (e) { 
        console.error("Inventory load error:", e);
        container.innerHTML = `<p style="color:#ff7a00; text-align:center; padding:40px 0;">Unable to load inventory. Error: ${e.message || "Connection failed"}. Please check your internet connection and try again.</p>`;
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
    }[ch]));
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
}

function parseSpecsString(specsString) {
    const specs = {};
    specsString.split(";").forEach(part => {
        const idx = part.indexOf(":");
        if (idx > -1) specs[part.slice(0, idx)] = part.slice(idx + 1);
    });
    return specs;
}

function editProduct(docId) {
    activeAdminEditProductId = docId;
    renderAdminInventoryList();
}

function cancelProductEdit() {
    activeAdminEditProductId = null;
    renderAdminInventoryList();
}

async function saveProductEdit(docId) {
    if (!db) {
        showToast("Database connection unavailable. Please refresh the page.");
        return;
    }

    const title = document.getElementById(`editProdTitle-${docId}`)?.value.trim();
    const price = document.getElementById(`editProdPrice-${docId}`)?.value.trim();
    const stock = parseInt(document.getElementById(`editProdStock-${docId}`)?.value, 10);
    const category = document.getElementById(`editProdCategory-${docId}`)?.value;
    const desc = document.getElementById(`editProdDesc-${docId}`)?.value.trim();
    const specStorage = document.getElementById(`editProdSpecStorage-${docId}`)?.value.trim();
    const specDisplay = document.getElementById(`editProdSpecDisplay-${docId}`)?.value.trim();
    const specChip = document.getElementById(`editProdSpecChip-${docId}`)?.value.trim();
    const specCamera = document.getElementById(`editProdSpecCamera-${docId}`)?.value.trim();

    // Validation with specific error messages
    if (!title) {
        showToast("Please enter a product title.");
        return;
    }
    if (!price) {
        showToast("Please enter a price.");
        return;
    }
    if (isNaN(stock) || stock < 0) {
        showToast("Stock must be a number of 0 or more.");
        return;
    }
    if (!category) {
        showToast("Please select a category.");
        return;
    }
    if (!desc) {
        showToast("Please enter a product description.");
        return;
    }

    const specs = `Storage:${specStorage || ""};Display:${specDisplay || ""};Chip:${specChip || ""};Camera:${specCamera || ""}`;
    const newDocId = title.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

    try {
        const currentDoc = await db.collection("products").doc(docId).get();
        if (!currentDoc.exists) throw new Error("Product no longer exists in the database. Please refresh and try again.");

        const updatedProduct = {
            ...currentDoc.data(),
            title,
            price,
            stock,
            category,
            desc,
            specs
        };

        await db.collection("products").doc(newDocId).set(updatedProduct);
        if (newDocId !== docId) await db.collection("products").doc(docId).delete();

        activeAdminEditProductId = null;
        showToast(`Item "${title}" has been successfully updated.`);
        renderAdminInventoryList();
    } catch (e) {
        console.error("Product edit failed:", e);
        showToast(`Error updating product: ${e.message || "Unknown error"}`);
    }
}

async function updateStockLevel(docId) {
    const input = document.getElementById(`updateStockInput-${docId}`);
    if (!input) return;
    
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) { 
        showToast("Please enter a valid quantity (0 or more).");
        return; 
    }
    
    try {
        if (!db) {
            showToast("Database connection unavailable. Please refresh the page.");
            return;
        }
        
        await db.collection("products").doc(docId).update({ stock: val });
        showToast(`Stock updated to ${val} item${val !== 1 ? "s" : ""}.`);
        renderAdminInventoryList();
        
        // Trigger cart stock watchers
        if (stockWatcherUnsubscribe) setupStockWatcher();
    } catch (e) { 
        console.error("Stock update failed:", e);
        showToast(`Error updating stock: ${e.message || "Unknown error"}`);
    }
}

async function deleteProduct(docId) {
    const title = dynamicStoreCatalogCache[docId]?.title || "this item";
    if (!confirm(`Are you sure you want to permanently delete "${title}"? This action cannot be undone.`)) return;
    
    try {
        if (!db) {
            showToast("Database connection unavailable. Please refresh the page.");
            return;
        }
        
        await db.collection("products").doc(docId).delete();
        showToast(`Item "${title}" has been deleted.`);
        renderAdminInventoryList();
    } catch (e) { 
        console.error("Product deletion failed:", e);
        showToast(`Error deleting product: ${e.message || "Unknown error"}`);
    }
}

/* ============================================================
   TRACKING LOADER & TIMELINE ENGINE
   ============================================================ */
async function initAutoTracking() {
    const urlParams = new URLSearchParams(window.location.search);
    const trackingId = urlParams.get('id');
    if (trackingId && document.getElementById("trackingQuery")) {
        document.getElementById("trackingQuery").value = trackingId;
        findShipment();
    }
}

async function findShipment() {
    const query = document.getElementById("trackingQuery").value.trim();
    const wrapper = document.getElementById("timelineWrapper");
    const err = document.getElementById("trackingError");
    if (!query || !wrapper || !err) return;

    wrapper.style.display = "none";
    err.style.display = "none";

    try {
        let trackingNumber = query;
        let orderId = "";
        let orderDoc = null;

        if (db) {
            if (query.startsWith("RDX-")) {
                const doc = await db.collection("orders").doc(query).get();
                if (doc.exists) {
                    orderDoc = doc.data();
                    trackingNumber = orderDoc.trackingNumber;
                    orderId = query;
                }
            } else {
                const snap = await db.collection("orders").where("trackingNumber", "==", query).get();
                if (!snap.empty) {
                    orderDoc = snap.docs[0].data();
                    orderId = orderDoc.orderId;
                }
            }
        }

        if (trackingNumber === "Pending") {
            wrapper.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <h4 style="color:#ff7a00; font-family:'Syne', sans-serif; margin-bottom:10px;">Shipment Preparing</h4>
                    <p style="color:rgba(255,255,255,0.6); font-size:0.85rem;">The merchant is packaging your order. A carrier tracking number will be posted soon.</p>
                </div>
            `;
            wrapper.style.display = "block";
            return;
        }

        // Pull real-time details from Shippo Proxy API
        const res = await fetch(`/api/track/usps/${trackingNumber}`);
        if (!res.ok) throw new Error("Tracking fetch failed");

        const trackData = await res.json();
        if (trackData.error || !trackData.tracking_status) {
            err.style.display = "block";
            return;
        }

        const status = trackData.tracking_status.status;
        let stepIndex = 1; // 1 = Processed, 2 = Accepted, 3 = In Transit, 4 = Delivered
        let progressFillWidth = "0%";

        if (status === "DELIVERED") {
            stepIndex = 4;
            progressFillWidth = "100%";
        } else if (status === "TRANSIT" || status === "IN_TRANSIT") {
            stepIndex = 3;
            progressFillWidth = "66%";
        } else if (status === "PRE_TRANSIT") {
            stepIndex = 2;
            progressFillWidth = "33%";
        }

        // Update database dynamically when queried (Task 4)
        if (db && orderId) {
            let dbStatus = "Processed";
            if (stepIndex === 2) dbStatus = "Received";
            if (stepIndex === 3) dbStatus = "In Transit";
            if (stepIndex === 4) dbStatus = "Delivered";

            if (orderDoc && orderDoc.shippingStatus !== dbStatus) {
                await db.collection("orders").doc(orderId).update({ shippingStatus: dbStatus });
            }
        }

        wrapper.innerHTML = `
            <div style="position: relative; display: flex; justify-content: space-between; margin: 40px 0 20px;">
                <div class="timeline-bar">
                    <div class="timeline-progress-fill" style="width: ${progressFillWidth};"></div>
                </div>
                <div class="timeline-step ${stepIndex >= 1 ? 'complete' : ''} ${stepIndex === 1 ? 'active' : ''}">
                    <div class="timeline-dot">1</div>
                    <div class="timeline-label">Processed</div>
                </div>
                <div class="timeline-step ${stepIndex >= 2 ? 'complete' : ''} ${stepIndex === 2 ? 'active' : ''}">
                    <div class="timeline-dot">2</div>
                    <div class="timeline-label">Accepted</div>
                </div>
                <div class="timeline-step ${stepIndex >= 3 ? 'complete' : ''} ${stepIndex === 3 ? 'active' : ''}">
                    <div class="timeline-dot">3</div>
                    <div class="timeline-label">In Transit</div>
                </div>
                <div class="timeline-step ${stepIndex >= 4 ? 'complete' : ''} ${stepIndex === 4 ? 'active' : ''}">
                    <div class="timeline-dot">4</div>
                    <div class="timeline-label">Delivered</div>
                </div>
            </div>
            <div style="background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.05); padding: 20px; border-radius: 14px; text-align: left; margin-top: 30px;">
                <h4 style="font-family:'Syne', sans-serif; font-size:1.1rem; margin-bottom:8px; color:#00e5b4;">Live Carrier Activity</h4>
                <p style="font-size:0.85rem; color:#fff; font-weight:600; margin-bottom:4px;">${trackData.tracking_status.status_details || "No details provided."}</p>
                <p style="font-size:0.75rem; color:rgba(255,255,255,0.4);">Updated: ${new Date(trackData.tracking_status.status_date).toLocaleString()}</p>
            </div>
        `;
        wrapper.style.display = "block";

    } catch (e) {
        console.error("Find shipment error:", e);
        err.style.display = "block";
    }
}

function toggleChatWidget() {
    document.getElementById("chatPanel")?.classList.toggle("active");
}

async function sendChatMessage() {
    const input = document.getElementById("chatInput");
    const messagesEl = document.getElementById("chatMessages");
    const userText = input.value.trim();
    if (!userText) return;

    const session = localStorage.getItem("rdx_session");
    if (!session && getGuestChatCount() >= GUEST_MESSAGE_LIMIT) {
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-user">${userText}</div>`);
        input.value = "";
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">Sign in to continue chatting!</div>`);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        toggleChatWidget();
        openSigninDrawer();
        return;
    }

    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-user">${userText}</div>`);
    input.value = "";
    messagesEl.scrollTop = messagesEl.scrollHeight;

    chatHistory.push({ role: "user", content: userText });

    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot chat-msg-loading"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: chatHistory })
        });

        const data = await response.json();
        messagesEl.querySelector(".chat-msg-loading")?.remove();

        if (data.reply) {
            chatHistory.push({ role: "assistant", content: data.reply });
            messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">${data.reply}</div>`);
            if (!session) {
                localStorage.setItem("rdx_guest_chat_count", getGuestChatCount() + 1);
            }
        } else {
            messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">Oops, something went wrong. Try again!</div>`);
        }
    } catch (err) {
        messagesEl.querySelector(".chat-msg-loading")?.remove();
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">Can't reach the server. Make sure it's running!</div>`);
        console.error("Chat error:", err);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getGuestChatCount() {
    return parseInt(localStorage.getItem("rdx_guest_chat_count") || "0", 10);
}