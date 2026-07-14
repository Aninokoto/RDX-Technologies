/* ============================================================
   1. GOOGLE FIREBASE CLOUD DATABASE SAFETY & STATE
   ============================================================ */
let db = null; // Instantiated dynamically on startup

/* ============================================================
   2. UNIVERSAL PARALLAX (Mouse Follow)
   ============================================================ */
document.addEventListener('mousemove', function(e) {
    const target = document.querySelector('.hero-content, .header-content, .contact-header, .services-intro');
    if (target) {
        const x = (window.innerWidth / 2 - e.clientX) * 0.005; 
        const y = (window.innerHeight / 2 - e.clientY) * 0.005;
        target.style.transform = `translateX(${-x}px) translateY(${-y}px)`;
    }
});

/* ============================================================
   3. REVEAL SYSTEM (Scroll/Load Animation)
   ============================================================ */
const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px" 
};

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
        } else {
            entry.target.classList.remove('active');
        }
    });
}, observerOptions);

function initReveals() {
    const revealElements = document.querySelectorAll('.reveal');
    revealElements.forEach(el => revealObserver.observe(el));

    setTimeout(() => {
        revealElements.forEach(el => el.classList.add('active'));
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
   4. SPECS QUICK VIEW MODAL & SLIDESHOW LOGIC
   ============================================================ */
let activeSlideImages = [];
let currentSlideIndex = 0;

function openProductSpecs(title, price, desc, mainImage, altImages, specsString) {
    const modal = document.getElementById('specsModal');
    if (!modal) return;

    trackRecentlyViewed(title, price, mainImage);

    activeSlideImages = [mainImage, ...altImages];
    currentSlideIndex = 0;

    document.getElementById('specsTitle').innerText = title;
    document.getElementById('specsPrice').innerText = price;
    document.getElementById('specsDesc').innerText = desc;
    
    updateSlideshowUI();

    const gridContainer = document.getElementById('specsListGrid');
    if (gridContainer && specsString) {
        gridContainer.innerHTML = "";
        
        const items = specsString.split(';');
        items.forEach(item => {
            const parts = item.split(':');
            if (parts.length === 2) {
                const specItemHTML = `
                    <div class="specs-list-item">
                        <strong>${parts[0]}</strong>
                        <span>${parts[1]}</span>
                    </div>
                `;
                gridContainer.insertAdjacentHTML('beforeend', specItemHTML);
            }
        });
    }

    const actionBtn = document.getElementById('specsModalAddBtn');
    actionBtn.onclick = () => {
        addToCart(title, price, 'Hardware', desc, mainImage);
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
        const isActive = index === currentSlideIndex ? "active" : "";
        const thumbHTML = `
            <div class="specs-thumb ${isActive}" onclick="setSlide(${index})">
                <img src="${imgSrc}" alt="Thumbnail View">
            </div>
        `;
        thumbContainer.insertAdjacentHTML('beforeend', thumbHTML);
    });
}

function setSlide(index) {
    currentSlideIndex = index;
    updateSlideshowUI();
}

function changeSlide(direction) {
    currentSlideIndex += direction;
    if (currentSlideIndex >= activeSlideImages.length) {
        currentSlideIndex = 0;
    } else if (currentSlideIndex < 0) {
        currentSlideIndex = activeSlideImages.length - 1;
    }
    updateSlideshowUI();
}

function closeProductSpecs() {
    const modal = document.getElementById('specsModal');
    if (modal) {
        modal.classList.remove('active');
        checkScrollUnlock();
    }
}

/* ============================================================
   5. PERSISTENT CLOUD CART SYSTEM (FIREBASE)
   ============================================================ */
let localCartState = [];

async function syncCartToDatabase() {
    if (!db) return;
    const session = localStorage.getItem("rdx_session");
    if (!session) return;

    const user = JSON.parse(session);
    try {
        await db.collection("users").doc(user.email).update({
            cart: localCartState
        });
    } catch (err) {
        console.error("Failed to sync cart:", err);
    }
}

async function fetchCartFromDatabase() {
    if (!db) return [];
    const session = localStorage.getItem("rdx_session");
    if (!session) return [];

    const user = JSON.parse(session);
    try {
        const doc = await db.collection("users").doc(user.email).get();
        if (doc.exists) {
            return doc.data().cart || [];
        }
    } catch (err) {
        console.error("Failed to load cloud cart:", err);
    }
    return [];
}

function getCart() {
    return localCartState;
}

async function addToCart(title, price, type, details, imagePath = null) {
    const session = localStorage.getItem("rdx_session");
    if (!session) {
        showToast("Access Restricted. Please sign in first.");
        openSigninDrawer();
        return;
    }

    if (type === "Subscription") {
        localCartState = localCartState.filter(item => item.type !== "Subscription");
        localCartState.push({
            title: title,
            price: price,
            numericPrice: parseFloat(price.replace(/[^0-9.]/g, '')),
            type: type,
            details: details,
            imagePath: imagePath,
            quantity: 1
        });
    } else {
        const existingItemIndex = localCartState.findIndex(item => item.title === title);
        if (existingItemIndex > -1) {
            localCartState[existingItemIndex].quantity += 1;
        } else {
            localCartState.push({
                title: title,
                price: price,
                numericPrice: parseFloat(price.replace(/[^0-9.]/g, '')),
                type: type,
                details: details,
                imagePath: imagePath,
                quantity: 1
            });
        }
    }

    updateCartUI();
    showToast(`${title} added to cart!`);
    await syncCartToDatabase();
}

async function changeQuantity(index, delta) {
    if (!localCartState[index]) return;

    localCartState[index].quantity += delta;
    if (localCartState[index].quantity <= 0) {
        localCartState.splice(index, 1);
    }

    updateCartUI();
    await syncCartToDatabase();

    if (window.location.pathname.includes("checkout.html")) {
        renderCheckoutPage();
    }
}

function updateCartUI() {
    const totalItems = localCartState.reduce((total, item) => total + item.quantity, 0);
    const cartCountElement = document.getElementById("cart-count");
    if (cartCountElement) {
        cartCountElement.innerText = totalItems;
    }

    const itemsContainer = document.getElementById("cartDrawerItems");
    if (!itemsContainer) return;

    itemsContainer.innerHTML = "";

    if (localCartState.length === 0) {
        itemsContainer.innerHTML = `<p style="color: rgba(255,255,255,0.4); text-align: center; margin-top: 40px; font-size: 0.9rem;">Your cart is empty.</p>`;
        document.getElementById("cartDrawerSubtotal").innerText = "$0.00";
        return;
    }

    let subtotal = 0;
    localCartState.forEach((item, index) => {
        const itemTotal = item.numericPrice * item.quantity;
        subtotal += itemTotal;

        const imgTag = item.imagePath ? `<img class="cart-item-img" src="${item.imagePath}" alt="${item.title}">` : '';
        let qtyControlsHTML = "";
        let qtyStyles = "";

        if (item.type === "Subscription") {
            qtyControlsHTML = `<button class="cart-remove-btn" onclick="changeQuantity(${index}, -1)">Remove</button>`;
            qtyStyles = `background: none; border: none; padding: 0;`;
        } else {
            qtyControlsHTML = `
                <button class="cart-qty-btn" onclick="changeQuantity(${index}, -1)">-</button>
                <span class="cart-qty-val">${item.quantity}</span>
                <button class="cart-qty-btn" onclick="changeQuantity(${index}, 1)">+</button>
            `;
        }

        const itemHTML = `
            <div class="cart-drawer-item">
                ${imgTag}
                <div class="cart-item-info">
                    <h4>${item.title}</h4>
                    <span class="price">${item.price}</span>
                </div>
                <div class="cart-item-qty" style="${qtyStyles}">
                    ${qtyControlsHTML}
                </div>
            </div>
        `;
        itemsContainer.insertAdjacentHTML("beforeend", itemHTML);
    });

    document.getElementById("cartDrawerSubtotal").innerText = `$${subtotal.toFixed(2)}`;
}

function showToast(message) {
    const toast = document.getElementById("cartToast");
    const toastMessage = document.getElementById("cartToastMessage");
    
    if (toast && toastMessage) {
        toastMessage.innerText = message;
        toast.classList.add("active");
        
        setTimeout(() => {
            toast.classList.remove("active");
        }, 2500);
    }
}

function openCartDrawer(event = null) {
    if (event) event.preventDefault();
    const drawer = document.getElementById("cartDrawer");
    const overlay = document.getElementById("cartDrawerOverlay");
    if (drawer && overlay) {
        drawer.classList.add("active");
        overlay.classList.add("active");
        document.body.classList.add("scroll-locked");
    }
}

function closeCartDrawer() {
    const drawer = document.getElementById("cartDrawer");
    const overlay = document.getElementById("cartDrawerOverlay");
    if (drawer && overlay) {
        drawer.classList.remove("active");
        overlay.classList.remove("active");
        checkScrollUnlock();
    }
}

function navigateToCheckout() {
    closeCartDrawer();
    window.location.href = "checkout.html";
}

function checkScrollUnlock() {
    const cartActive = document.getElementById("cartDrawer")?.classList.contains("active");
    const specsActive = document.getElementById("specsModal")?.classList.contains("active");
    const signinActive = document.getElementById("signinDrawer")?.classList.contains("active");
    
    if (!cartActive && !specsActive && !signinActive) {
        document.body.classList.remove("scroll-locked");
    }
}

/* ============================================================
   6. GOOGLE POPUP SIGN-IN LOGIC
   ============================================================ */
function openSigninDrawer() {
    const drawer = document.getElementById("signinDrawer");
    const overlay = document.getElementById("signinDrawerOverlay");
    if (drawer && overlay) {
        drawer.classList.add("active");
        overlay.classList.add("active");
        document.body.classList.add("scroll-locked");
    }
}

function closeSigninDrawer() {
    const drawer = document.getElementById("signinDrawer");
    const overlay = document.getElementById("signinDrawerOverlay");
    if (drawer && overlay) {
        drawer.classList.remove("active");
        overlay.classList.remove("active");
        checkScrollUnlock();
    }
}

function handleProfileNavClick(event) {
    if (event) event.preventDefault();
    const session = localStorage.getItem("rdx_session");
    
    if (session) {
        window.location.href = "settings.html";
    } else {
        openSigninDrawer();
    }
}

function updateProfileNavUI() {
    const profileBtn = document.getElementById("navProfileBtn");
    if (profileBtn) {
        const session = localStorage.getItem("rdx_session");
        if (session) {
            const userData = JSON.parse(session);
            profileBtn.innerText = userData.name.split(' ')[0];
        } else {
            profileBtn.innerText = "Sign In";
        }
    }
    updateNavForSession();
}

function updateNavForSession() {
    const session = localStorage.getItem("rdx_session");
    document.querySelectorAll('.nav-center-pill a[href="index.html"]').forEach(link => {
        link.href = session ? "dashboard.html" : "index.html";
    });

    document.querySelectorAll('.nav-center-pill a[href="index.html#story"], .nav-center-pill a[href="#story"]').forEach(link => {
        const li = link.closest("li");
        if (li) li.style.display = session ? "none" : "";
    });
}

// Global Google Sign-In Handler
async function handleGoogleSignIn() {
    if (typeof firebase === 'undefined' || !db) {
        alert("Database is currently offline.");
        return;
    }

    const provider = new firebase.auth.GoogleAuthProvider();

    try {
        const result = await firebase.auth().signInWithPopup(provider);
        const user = result.user;

        const email = user.email.toLowerCase().trim();
        const name = user.displayName || "RDX User";

        const userDoc = await db.collection("users").doc(email).get();

        if (!userDoc.exists) {
            await db.collection("users").doc(email).set({
                name: name,
                email: email,
                activeSubscription: "",
                cart: []
            });
            console.log("Registered new user profile via Google.");
        }

        const userData = userDoc.exists ? userDoc.data() : { name, email, activeSubscription: "", cart: [] };

        localStorage.setItem("rdx_session", JSON.stringify({ name: userData.name, email: userData.email }));
        if (userData.activeSubscription) {
            const activeSubKey = "rdx_active_subscription" + getActiveUserSuffix();
            localStorage.setItem(activeSubKey, userData.activeSubscription);
        }

        localCartState = userData.cart || [];
        updateProfileNavUI();
        updateCartUI();
        checkActiveSubscriptionButtons();
        closeSigninDrawer();
        showToast(`Welcome back, ${userData.name}!`);

        setTimeout(() => {
            window.location.href = "dashboard.html";
        }, 700);

    } catch (err) {
        console.error("Google Sign-In Error:", err);
        alert(err.message || "Failed to log in with Google.");
    }
}

function getActiveUserSuffix() {
    const session = localStorage.getItem("rdx_session");
    if (session) {
        try {
            const user = JSON.parse(session);
            if (user && user.email) {
                return `_user_${user.email.replace(/[^a-zA-Z0-9]/g, "")}`;
            }
        } catch (err) {
            localStorage.removeItem("rdx_session");
        }
    }
    return "";
}

function logUserOut() {
    localStorage.removeItem("rdx_session");
    if (typeof firebase !== 'undefined') {
        firebase.auth().signOut().catch(err => console.error("Logout error:", err));
    }
    window.location.href = "index.html";
}
/* ============================================================
   7. INITIALIZATION AND MODAL DRAWERS INJECTION
   ============================================================ */
async function initializeCloudDataSync() {
    const session = localStorage.getItem("rdx_session");
    if (session) {
        // 1. Await the cloud database download
        localCartState = await fetchCartFromDatabase();
        
        // 2. Update your drawer interface
        updateCartUI();
        checkActiveSubscriptionButtons();

        // 3. If we are on the checkout page, rebuild the layout once data is loaded!
        if (window.location.pathname.includes("checkout.html")) {
            renderCheckoutPage();
        }
    }
}

// Master initialization routine — fetches keys and boots both Firebase and Stripe
async function initializeEcosystem() {
    try {
        // Fetch variables from our secure backend config endpoint
        const configResponse = await fetch("http://localhost:3000/api/config");
        const config = await configResponse.json();

        // Initialize Firebase connection dynamically
        if (typeof firebase !== 'undefined' && config.firebaseConfig) {
            firebase.initializeApp(config.firebaseConfig);
            db = firebase.firestore();
            console.log("✅ Firebase Cloud Firestore integrated successfully.");
        }

        // Initialize Stripe elements dynamically if we are on checkout page
        if (window.location.pathname.includes("checkout.html") && config.stripePublishableKey) {
            initStripeElements(config.stripePublishableKey);
        }

        // If we are loading tracking.html, run the auto-load tracker logic
        if (window.location.pathname.includes("tracking.html")) {
            initAutoTracking();
        }

        // Once database is initialized, safe to boot normal data bindings
        updateCartUI();
        updateProfileNavUI();
        initCategoryFilters();
        checkActiveSubscriptionButtons();
        await initializeCloudDataSync();

    } catch (err) {
        console.error("Ecosystem initialization failed:", err);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const uiInjections = `
        <!-- Cart Drawer -->
        <div id="cartDrawerOverlay" class="cart-drawer-overlay" onclick="closeCartDrawer()"></div>
        <div id="cartDrawer" class="cart-drawer">
            <div class="cart-drawer-header">
                <h3>Your Cart</h3>
                <button class="cart-drawer-close" onclick="closeCartDrawer()">&times;</button>
            </div>
            <div id="cartDrawerItems" class="cart-drawer-items"></div>
            <div class="cart-drawer-footer">
                <div class="cart-drawer-subtotal">
                    <span>Subtotal</span>
                    <span id="cartDrawerSubtotal">$0.00</span>
                </div>
                <button class="btn-cart-checkout" onclick="navigateToCheckout()">Proceed to Checkout</button>
            </div>
        </div>

        <!-- Specs Popup Modal -->
        <div id="specsModal" class="specs-modal" onclick="closeProductSpecs()">
            <div class="specs-modal-content" onclick="event.stopPropagation()">
                <button class="checkout-close" onclick="closeProductSpecs()">&times;</button>
                <div class="specs-grid">
                    <div class="specs-visual-container">
                        <div class="specs-visual">
                            <span class="specs-arrow prev" onclick="changeSlide(-1)">&lsaquo;</span>
                            <img id="specsImage" src="" alt="Product Detail">
                            <span class="specs-arrow next" onclick="changeSlide(1)">&rsaquo;</span>
                        </div>
                        <div class="specs-thumbnails" id="specsThumbnailsRow"></div>
                    </div>
                    <div class="specs-info">
                        <div class="stock-badge">
                            <div class="stock-dot"></div>
                            <span>In Stock - Ready to Ship</span>
                        </div>
                        <h2 id="specsTitle">Product Title</h2>
                        <div id="specsPrice" class="price">$0.00</div>
                        <p id="specsDesc">Description content will render here.</p>
                        <div id="specsListGrid" class="specs-list-grid"></div>
                        <button id="specsModalAddBtn" class="btn-primary" style="background:#00e5b4; color:#000; width:100%; padding:12px;">Add to Cart</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Dynamic Google Sign-In Dropdown -->
        <div id="signinDrawerOverlay" class="signin-drawer-overlay" onclick="closeSigninDrawer()"></div>
        <div id="signinDrawer" class="signin-drawer">
            <div class="cart-drawer-header">
                <h3>Access Profile</h3>
                <button class="cart-drawer-close" onclick="closeSigninDrawer()">&times;</button>
            </div>
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 20px;">
                <p style="font-size:0.88rem; color:rgba(255,255,255,0.4); text-align:center;">Sign in instantly to access your RDX dashboard, synchronized shopping cart, and premium repair plans.</p>
                <button class="btn-checkout-submit" onclick="handleGoogleSignIn()" style="background:#00e5b4; color:#000; display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.24 10.285V13.4h6.887C18.2 15.614 15.645 18 12.24 18c-3.86 0-7-3.14-7-7s3.14-7 7-7c1.7 0 3.3.6 4.5 1.7l2.4-2.4C17.3 1.5 14.9 1 12.24 1 6.58 1 2 5.58 2 11.24s4.58 10.24 10.24 10.24c5.79 0 10.24-4.07 10.24-10.24 0-.69-.06-1.35-.18-1.95H12.24z"/></svg>
                    Sign In with Google
                </button>
            </div>
        </div>

        <!-- Toast Notifications -->
        <div id="cartToast" class="cart-toast">
            <div class="toast-dot"></div>
            <span id="cartToastMessage">Item added to cart</span>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', uiInjections);

    document.querySelectorAll(".nav-cart-btn").forEach(link => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            openCartDrawer();
        });
    });

    // Boot everything safely through the configuration pipeline
    initializeEcosystem();
});

function switchContactTab(tab) {
    const isBooking = tab === "booking";
    document.getElementById("contactPanelBooking").classList.toggle("active", isBooking);
    document.getElementById("contactPanelGeneral").classList.toggle("active", !isBooking);

    const bookingBtn = document.getElementById("contactTabBtnBooking");
    const generalBtn = document.getElementById("contactTabBtnGeneral");
    bookingBtn.classList.toggle("active", isBooking);
    bookingBtn.setAttribute("aria-selected", isBooking);
    generalBtn.classList.toggle("active", !isBooking);
    generalBtn.setAttribute("aria-selected", !isBooking);
}

function handleBookingSubmit(event) {
    event.preventDefault();
    event.target.reset();
    showToast("Appointment requested! We'll confirm your slot by email.");
}

function handleGeneralContactSubmit(event) {
    event.preventDefault();
    event.target.reset();
    showToast("Transmission received. We'll be in touch soon.");
}

document.addEventListener("DOMContentLoaded", () => {
    const bookDate = document.getElementById("bookDate");
    if (bookDate) {
        bookDate.min = new Date().toISOString().split("T")[0];
    }
});
/* ============================================================
   8. DYNAMIC STORE FILTER CONTROLS
   ============================================================ */
function initCategoryFilters() {
    const chips = document.querySelectorAll('.filter-chip');
    const cards = document.querySelectorAll('.gallery-card');

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            chips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            const filterValue = chip.dataset.filter;
            cards.forEach(card => {
                const cardCategory = card.getAttribute('data-category');
                if (filterValue === 'all' || cardCategory === filterValue) {
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

/* ============================================================
   9. SERVICES PAGE DEACTIVATION LOGIC
   ============================================================ */
function checkActiveSubscriptionButtons() {
    document.querySelectorAll(".service-card").forEach(card => {
        const btn = card.querySelector("button");
        if (btn) {
            btn.innerText = "Select Plan";
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
            btn.style.cursor = "pointer";
        }
    });

    const session = localStorage.getItem("rdx_session");
    if (session) {
        const activeSubKey = "rdx_active_subscription" + getActiveUserSuffix();
        const activeSub = localStorage.getItem(activeSubKey);
        
        if (activeSub) {
            document.querySelectorAll(".service-card").forEach(card => {
                const heading = card.querySelector("h3");
                if (!heading) return;

                const planTitle = heading.innerText + " Plan";
                const btn = card.querySelector("button");

                if (planTitle.toLowerCase() === activeSub.toLowerCase()) {
                    btn.innerText = "Plan Active";
                    btn.disabled = true;
                    btn.style.opacity = "0.5";
                    btn.style.pointerEvents = "none";
                    btn.style.cursor = "not-allowed";
                }
            });
        }
    }
}

/* ============================================================
   10. MAIN CHECKOUT PAGE LOGIC (checkout.html) & STRIPE
   ============================================================ */
let checkoutCurrentStep = 1;
let stripeInstance = null;
let cardNumElement = null;
let cardExpiryElement = null;
let cardCvcElement = null;

// Sets up secure card element instances with passed Publishable Key
function initStripeElements(publishableKey) {
    stripeInstance = Stripe(publishableKey);

    const elements = stripeInstance.elements();

    const elementStyles = {
        base: {
            color: '#ffffff',
            fontFamily: 'Inter, sans-serif',
            fontSize: '14.4px',
            '::placeholder': {
                color: 'rgba(255, 255, 255, 0.25)',
            },
        },
        invalid: {
            color: '#ff7a00',
        },
    };

    cardNumElement = elements.create('cardNumber', { style: elementStyles });
    cardExpiryElement = elements.create('cardExpiry', { style: elementStyles });
    cardCvcElement = elements.create('cardCvc', { style: elementStyles });

    if (document.getElementById('stripe-card-number')) {
        cardNumElement.mount('#stripe-card-number');
        cardExpiryElement.mount('#stripe-card-expiry');
        cardCvcElement.mount('#stripe-card-cvc');

        // Dynamically add focus class to parents so standard input borders animate
        [cardNumElement, cardExpiryElement, cardCvcElement].forEach(el => {
            el.on('focus', () => {
                const parent = document.getElementById(el._parent.id);
                if (parent) parent.classList.add('stripe-input-container--focus');
            });
            el.on('blur', () => {
                const parent = document.getElementById(el._parent.id);
                if (parent) parent.classList.remove('stripe-input-container--focus');
            });
        });
    }
}

function renderCheckoutPage() {
    const mainFlow = document.getElementById("checkoutMainFlow");
    const successFlow = document.getElementById("checkoutSuccessFlow");
    const stepsNav = document.getElementById("checkoutStepsNav");
    const emptyState = document.getElementById("checkoutEmptyState");

    if (!mainFlow) return;

    successFlow.style.display = "none";
    if (localCartState.length === 0) {
        mainFlow.style.display = "none";
        stepsNav.style.display = "none";
        emptyState.style.display = "block";
        return;
    }

    emptyState.style.display = "none";
    mainFlow.style.display = "grid";
    stepsNav.style.display = "flex";

    renderCheckoutSidebar();
}

function renderCheckoutSidebar() {
    const itemsContainer = document.getElementById("checkoutSidebarItems");
    if (!itemsContainer) return;

    itemsContainer.innerHTML = "";
    let subtotal = 0;

    localCartState.forEach((item, index) => {
        const itemTotal = item.numericPrice * item.quantity;
        subtotal += itemTotal;

        const imgTag = item.imagePath ? `<img src="${item.imagePath}" alt="${item.title}" class="checkout-item-img">` : '';
        let qtyControlsHTML = "";
        if (item.type === "Subscription") {
            qtyControlsHTML = `<button class="cart-remove-btn" onclick="changeQuantity(${index}, -1)">Remove</button>`;
        } else {
            qtyControlsHTML = `
                <div class="cart-item-qty">
                    <button class="cart-qty-btn" onclick="changeQuantity(${index}, -1)">-</button>
                    <span class="cart-qty-val">${item.quantity}</span>
                    <button class="cart-qty-btn" onclick="changeQuantity(${index}, 1)">+</button>
                </div>
            `;
        }

        itemsContainer.insertAdjacentHTML('beforeend', `
            <div class="checkout-sidebar-item">
                ${imgTag}
                <div class="checkout-sidebar-item-info">
                    <h4>${item.title}</h4>
                    <span class="price">$${itemTotal.toFixed(2)}</span>
                    ${qtyControlsHTML}
                </div>
            </div>
        `);
    });

    document.getElementById("checkoutSubtotalVal").innerText = `$${subtotal.toFixed(2)}`;
    document.getElementById("checkoutGrandTotalVal").innerText = `$${subtotal.toFixed(2)}`;
}

function goToStep(step) {
    if (step > checkoutCurrentStep) {
        const currentPanel = document.getElementById('stepPanel' + checkoutCurrentStep);
        const requiredInputs = currentPanel.querySelectorAll('input[required]');
        for (const input of requiredInputs) {
            if (!input.reportValidity()) return;
        }
    }

    document.querySelectorAll('.checkout-step-panel').forEach(panel => panel.classList.remove('active'));
    document.getElementById('stepPanel' + step).classList.add('active');

    document.querySelectorAll('.step-node').forEach(node => {
        const nodeStep = parseInt(node.dataset.step, 10);
        node.classList.remove('active', 'complete');
        if (nodeStep < step) node.classList.add('complete');
        if (nodeStep === step) node.classList.add('active');
    });

    checkoutCurrentStep = step;
    if (step === 3) populateReviewStep();

    const shell = document.querySelector('.checkout-shell');
    if (shell) {
        window.scrollTo({ top: shell.getBoundingClientRect().top + window.scrollY - 40, behavior: 'smooth' });
    }
}

function populateReviewStep() {
    const name = document.getElementById('shipName').value;
    const address = document.getElementById('shipAddress').value;
    const apt = document.getElementById('shipApt').value;
    const city = document.getElementById('shipCity').value;
    const state = document.getElementById('shipState').value;
    const zip = document.getElementById('shipZip').value;
    const phone = document.getElementById('shipPhone').value;

    const aptText = apt ? `, ${apt}` : '';
    document.getElementById('reviewShippingText').innerText =
        `${name} — ${address}${aptText}, ${city}, ${state} ${zip} · ${phone}`;

    const cardName = document.getElementById('checkoutName').value || 'Card Holder';
    document.getElementById('reviewPaymentText').innerText = `Card under name: ${cardName}`;
}

// Complete checkout with secure Stripe payment intent creation
async function handleCheckoutSubmit() {
    if (!db) {
        alert("Database is currently offline.");
        return;
    }
    const session = localStorage.getItem("rdx_session");
    if (!session || localCartState.length === 0) return;

    const user = JSON.parse(session);
    const mainFlow = document.getElementById("checkoutMainFlow");
    const successFlow = document.getElementById("checkoutSuccessFlow");
    const stepsNav = document.getElementById("checkoutStepsNav");
    const checkoutSubmitBtn = document.getElementById("checkoutSubmitBtn");

    const email = document.getElementById("checkoutEmail").value;
    const cardName = document.getElementById("checkoutName").value;
    const orderTotal = localCartState.reduce((sum, item) => sum + (item.numericPrice * item.quantity), 0);

    // Disable button to prevent double-charging
    checkoutSubmitBtn.disabled = true;
    checkoutSubmitBtn.innerText = "Processing secure transaction...";

    try {
        // 1. Call backend server to initiate Stripe payment intent
        const response = await fetch("http://localhost:3000/api/create-payment-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                amount: orderTotal,
                currency: "usd",
                email: email
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        // 2. Instruct Stripe browser SDK to confirm credit card processing safely
        const stripeResult = await stripeInstance.confirmCardPayment(data.clientSecret, {
            payment_method: {
                card: cardNumElement,
                billing_details: {
                    name: cardName,
                    email: email
                }
            }
        });

        if (stripeResult.error) {
            throw new Error(stripeResult.error.message);
        }

        // 3. Confirm checkout succeeded
        if (stripeResult.paymentIntent.status === 'succeeded') {
            const orderId = "RDX-" + Date.now();
            const subscriptionItem = localCartState.find(item => item.type === "Subscription");
            const activeSubscriptionName = subscriptionItem ? subscriptionItem.title : "";

            // Save completed order details into cloud database
            await db.collection("orders").doc(orderId).set({
                orderId: orderId,
                userEmail: user.email,
                date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
                items: localCartState,
                total: orderTotal,
                paymentStatus: "Paid",
                trackingNumber: "Pending",     // Default status
                shippingStatus: "Processed"    // Default status
            });

            // Reset shopping cart on server
            const updateData = { cart: [] };
            if (activeSubscriptionName) {
                updateData.activeSubscription = activeSubscriptionName;
            }
            await db.collection("users").doc(user.email).update(updateData);

            if (activeSubscriptionName) {
                const activeSubKey = "rdx_active_subscription" + getActiveUserSuffix();
                localStorage.setItem(activeSubKey, activeSubscriptionName);
            }

            localCartState = []; // Reset local cart states
            updateCartUI();

            document.getElementById("successTitle").innerText = "Order Complete!";
            document.getElementById("successMessage").innerText = `Thank you for your purchase! Your payment has been secured via Stripe, and your order has been stored inside the cloud database.`;

            mainFlow.style.display = "none";
            stepsNav.style.display = "none";
            successFlow.style.display = "block";
        }
    } catch (err) {
        console.error("Database or payment submit error:", err);
        alert(err.message || "Failed to process payment successfully.");
        checkoutSubmitBtn.disabled = false;
        checkoutSubmitBtn.innerText = "Place Order";
    }
}

/* ============================================================
   11. ECOSYSTEM DASHBOARD (logged-in "home")
   ============================================================ */
async function renderDashboardPage() {
    const session = localStorage.getItem("rdx_session");
    if (!session) {
        window.location.href = "index.html";
        return;
    }

    const userData = JSON.parse(session);
    const firstName = userData.name.split(' ')[0];

    document.getElementById("welcomeGreeting").innerText = `Hey, ${firstName}.`;
    document.getElementById("userName").innerText = userData.name;
    document.getElementById("userEmail").innerText = userData.email;
    document.getElementById("avatarInitial").innerText = userData.name.charAt(0).toUpperCase();

    const activeSubKey = "rdx_active_subscription" + getActiveUserSuffix();
    const activeSub = localStorage.getItem(activeSubKey);
    const tierInfo = activeSub ? DASHBOARD_TIER_INFO[activeSub.toLowerCase()] : null;

    const planEl = document.getElementById("kpiPlanVal");
    const gaugeVal = tierInfo ? tierInfo.gauge : 15;
    if (activeSub) {
        planEl.innerText = activeSub;
        planEl.style.color = tierInfo.color;
    } else {
        planEl.innerText = "No Active Plan";
        planEl.style.color = "rgba(255,255,255,0.5)";
    }
    document.getElementById("gaugePercentText").innerText = `${gaugeVal}%`;
    document.getElementById("circularGauge").style.background =
        `radial-gradient(closest-side, #141414 78%, transparent 80% 100%), conic-gradient(#00e5b4 ${gaugeVal}%, rgba(255,255,255,0.06) 0)`;

    // Retrieve database metrics asynchronously
    const orders = await getOrderHistory();
    const now = new Date();
    const spentThisMonth = orders
        .filter(order => {
            const d = new Date(order.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        })
        .reduce((sum, order) => sum + order.total, 0);

    document.getElementById("kpiSpentVal").innerText = `$${spentThisMonth.toFixed(2)}`;
    document.getElementById("kpiOrdersVal").innerText = orders.length;
    document.getElementById("kpiEwasteVal").innerText = `${(orders.length * 0.9).toFixed(2)} kg`;
    document.getElementById("chartDivertedVal").innerText = `${(orders.length * 0.9).toFixed(2)} kg`;

    document.getElementById("cntOrders").innerText = orders.length;
    document.getElementById("cntWeight").innerText = (orders.length * 0.9).toFixed(2);

    renderDashboardTransmissions(orders);
    renderRecentlyViewedShelf();
}

function renderDashboardTransmissions(orders) {
    const container = document.getElementById("dashboardTransmissions");
    if (!container) return;

    if (orders.length === 0) {
        container.innerHTML = `<div class="order-history-empty">No orders yet. Anything you check out will show up here.</div>`;
        return;
    }

    container.innerHTML = "";
    orders.slice(0, 4).forEach(order => {
        container.insertAdjacentHTML("beforeend", `
            <div class="order-history-item">
                <div class="order-history-item-header">
                    <span class="order-date">${order.date} · ${order.orderId}</span>
                    <span class="order-total">$${order.total.toFixed(2)}</span>
                </div>
                <!-- Interactive Tracking Link -->
                <a href="tracking.html?id=${order.orderId}" class="review-edit-link" style="text-decoration:none; display:inline-block; font-weight:600; margin-top:8px;">Track Shipment</a>
            </div>
        `);
    });
}

function renderRecentlyViewedShelf() {
    const container = document.getElementById("viewedRow");
    const countEl = document.getElementById("cntViewed");
    if (!container) return;

    const viewed = getRecentlyViewed();
    if (countEl) countEl.innerText = viewed.length;

    if (viewed.length === 0) {
        container.innerHTML = `<div class="viewed-empty-state">Browse the store and inspect a few products — they'll show up here.</div>`;
        return;
    }

    container.innerHTML = "";
    viewed.forEach(item => {
        container.insertAdjacentHTML("beforeend", `
            <div class="viewed-item-card">
                <img class="viewed-item-img" src="${item.imagePath}" alt="${item.title}">
                <div class="viewed-item-info">
                    <h5>${item.title}</h5>
                    <span>${item.price}</span>
                </div>
            </div>
        `);
    });
}

/* ============================================================
   12. SETTINGS PANEL LOGIC
   ============================================================ */
async function renderSettingsPage() {
    const session = localStorage.getItem("rdx_session");
    if (!session) {
        window.location.href = "index.html";
        return;
    }

    const userData = JSON.parse(session);
    document.getElementById("profileName").innerText = userData.name;
    document.getElementById("profileEmail").innerText = userData.email;
    document.getElementById("sidebarUserName").innerText = userData.name;
    document.getElementById("sidebarUserEmail").innerText = userData.email;
    document.getElementById("accountAvatarInitial").innerText = userData.name.charAt(0).toUpperCase();

    const activeSubKey = "rdx_active_subscription" + getActiveUserSuffix();
    const activeSub = localStorage.getItem(activeSubKey);
    const profileTierEl = document.getElementById("profileTier");

    const tierColors = {
        "regular plan": "#00b8d9",
        "dynamic plan": "#00e5b4",
        "xtreme plan": "#ff7a00"
    };

    if (activeSub) {
        profileTierEl.innerText = `${activeSub} - Active`;
        profileTierEl.style.color = tierColors[activeSub.toLowerCase()] || "#00e5b4";
    } else {
        profileTierEl.innerText = "Basic Ecosystem (No Paid Service Plan)";
        profileTierEl.style.color = "rgba(255, 255, 255, 0.5)";
    }

    await renderOrderHistory();

    const requestedPanel = window.location.hash.replace("#", "");
    if (requestedPanel && document.getElementById("panel" + requestedPanel.charAt(0).toUpperCase() + requestedPanel.slice(1))) {
        switchSettingsPanel(requestedPanel);
    }
}

function switchSettingsPanel(panelName) {
    document.querySelectorAll(".account-panel").forEach(panel => panel.classList.remove("active"));
    document.querySelectorAll(".account-nav-item").forEach(item => item.classList.remove("active"));

    const panelId = "panel" + panelName.charAt(0).toUpperCase() + panelName.slice(1);
    const panel = document.getElementById(panelId);
    const navItem = document.querySelector(`.account-nav-item[data-panel="${panelName}"]`);

    if (panel) panel.classList.add("active");
    if (navItem) navItem.classList.add("active");
}

// Pulls order list straight from Firestore instead of localStorage cache
async function getOrderHistory() {
    if (!db) return [];
    const session = localStorage.getItem("rdx_session");
    if (!session) return [];

    const user = JSON.parse(session);
    try {
        const snapshot = await db.collection("orders")
            .where("userEmail", "==", user.email)
            .get();
        
        const orders = [];
        snapshot.forEach(doc => {
            orders.push(doc.data());
        });
        return orders;
    } catch (err) {
        console.error("Failed to query order history from database:", err);
    }
    return [];
}

async function renderOrderHistory() {
    const container = document.getElementById("orderHistoryList");
    if (!container) return;

    const orders = await getOrderHistory();
    if (orders.length === 0) {
        container.innerHTML = `<div class="order-history-empty">No past orders yet. Once you check out, your orders will show up here.</div>`;
        return;
    }

    container.innerHTML = "";
    orders.forEach(order => {
        let productsHTML = "";
        order.items.forEach(item => {
            productsHTML += `
                <div class="order-history-product-row">
                    <span>${item.title} (x${item.quantity})</span>
                    <span>$${(item.numericPrice * item.quantity).toFixed(2)}</span>
                </div>
            `;
        });

        container.insertAdjacentHTML("beforeend", `
            <div class="order-history-item">
                <div class="order-history-item-header">
                    <span class="order-date">${order.date} · ${order.orderId}</span>
                    <span class="order-total">$${order.total.toFixed(2)}</span>
                </div>
                <div class="order-history-products">
                    ${productsHTML}
                </div>
                <!-- Interactive Tracking Link -->
                <div style="margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 10px;">
                    <a href="tracking.html?id=${order.orderId}" class="review-edit-link" style="text-decoration:none; display:inline-block; font-weight:600;">Track Shipment with USPS</a>
                </div>
            </div>
        `);
    });
}

function getRecentlyViewed() {
    const suffix = getActiveUserSuffix();
    if (!suffix) return [];

    const key = "rdx_recently_viewed" + suffix;
    const viewed = localStorage.getItem(key);
    return viewed ? JSON.parse(viewed) : [];
}

function trackRecentlyViewed(title, price, imagePath) {
    const suffix = getActiveUserSuffix();
    if (!suffix) return;

    const key = "rdx_recently_viewed" + suffix;
    let viewed = getRecentlyViewed();

    viewed = viewed.filter(item => item.title !== title);
    viewed.unshift({ title, price, imagePath });
    viewed = viewed.slice(0, 8);

    localStorage.setItem(key, JSON.stringify(viewed));
}

function clearRecentlyViewed() {
    const suffix = getActiveUserSuffix();
    if (!suffix) return;

    const key = "rdx_recently_viewed" + suffix;
    localStorage.removeItem(key);
    renderRecentlyViewedShelf();
}

/* ============================================================
   13. AI CONVERSATIONAL ASSISTANT WIDGET (SITE-WIDE PROXY)
   ============================================================ */
let chatHistory = [];
const GUEST_MESSAGE_LIMIT = 3;

function toggleChatWidget() {
    document.getElementById("chatPanel").classList.toggle("active");
}

function getGuestChatCount() {
    return parseInt(localStorage.getItem("rdx_guest_chat_count") || "0", 10);
}

async function sendChatMessage() {
    const input = document.getElementById("chatInput");
    const messagesEl = document.getElementById("chatMessages");
    const userText = input.value.trim();
    if (!userText) return;

    const session = localStorage.getItem("rdx_session");

    if (!session && getGuestChatCount() >= GUEST_MESSAGE_LIMIT) {
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-user"></div>`);
        messagesEl.lastElementChild.innerText = userText;
        input.value = "";
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">You've used your ${GUEST_MESSAGE_LIMIT} free questions. Sign in or create a free account to keep chatting!</div>`);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        toggleChatWidget();
        openSigninDrawer();
        return;
    }

    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-user"></div>`);
    messagesEl.lastElementChild.innerText = userText;
    input.value = "";
    messagesEl.scrollTop = messagesEl.scrollHeight;

    chatHistory.push({ role: "user", content: userText });

    messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot chat-msg-loading" id="chatLoadingMsg"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
        const response = await fetch("http://localhost:3000/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: chatHistory })
        });

        const data = await response.json();
        document.getElementById("chatLoadingMsg")?.remove();

        if (data.reply) {
            chatHistory.push({ role: "assistant", content: data.reply });
            messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot"></div>`);
            messagesEl.lastElementChild.innerText = data.reply;

            if (!session) {
                localStorage.setItem("rdx_guest_chat_count", getGuestChatCount() + 1);
            }
        } else {
            messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">Sorry, something went wrong: ${data.error || "unknown error"}</div>`);
        }
    } catch (err) {
        document.getElementById("chatLoadingMsg")?.remove();
        messagesEl.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-msg-bot">Can't reach the local server. Make sure you ran "node server.js" in Terminal and left it running.</div>`);
        console.error("Chat widget error:", err);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ============================================================
   14. DYNAMIC PORTAL TRACKING LOGIC (tracking.html)
   ============================================================ */

// Auto-loads a signed-in user's latest package status or parses URL search terms
async function initAutoTracking() {
    // 1. Check if there is an Order ID in the URL parameters (e.g., ?id=RDX-12345)
    const urlParams = new URLSearchParams(window.location.search);
    const urlOrderId = urlParams.get('id');
    const urlTracking = urlParams.get('tracking');
    const targetQuery = urlOrderId || urlTracking;

    if (targetQuery) {
        // Pre-fill input value for user reference
        document.getElementById("trackingQuery").value = targetQuery;

        try {
            // Search Firestore by Order ID first
            let snapshot = await db.collection("orders")
                .where("orderId", "==", targetQuery)
                .get();

            // Fallback: Search by Tracking Number
            if (snapshot.empty) {
                snapshot = await db.collection("orders")
                    .where("trackingNumber", "==", targetQuery)
                    .get();
            }

            if (!snapshot.empty) {
                const order = snapshot.docs[0].data();
                renderTrackingTimeline(order);
                return; // Completed dynamic load via URL
            }
        } catch (err) {
            console.error("Direct URL parameters tracking lookup failed:", err);
        }
    }

    // 2. Fallback: Automatically load current logged-in user's latest order if no query parameters
    const session = localStorage.getItem("rdx_session");
    if (!session) return; // Leave page empty for manual guest query

    const user = JSON.parse(session);
    try {
        const snapshot = await db.collection("orders")
            .where("userEmail", "==", user.email)
            .get();

        if (snapshot.empty) return;

        const orders = [];
        snapshot.forEach(doc => orders.push(doc.data()));

        // Sort orders by timestamp extraction to get the newest order first
        orders.sort((a, b) => b.orderId.replace("RDX-", "") - a.orderId.replace("RDX-", ""));

        const latestOrder = orders[0];
        renderTrackingTimeline(latestOrder);

        // Pre-fill input value for user reference
        document.getElementById("trackingQuery").value = 
            latestOrder.trackingNumber !== "Pending" ? latestOrder.trackingNumber : latestOrder.orderId;

    } catch (err) {
        console.error("Dynamic auto-tracking fetch failed:", err);
    }
}

// Queries Firestore via custom search string input (Tracking Number or Order ID)
async function findShipment() {
    const query = document.getElementById("trackingQuery").value.trim();
    const errorEl = document.getElementById("trackingError");
    const timelineEl = document.getElementById("timelineWrapper");

    if (!query) return;
    errorEl.style.display = "none";
    timelineEl.style.display = "none";

    try {
        // Query by Order ID first
        let snapshot = await db.collection("orders")
            .where("orderId", "==", query)
            .get();

        // Fallback: Query by USPS Tracking Number
        if (snapshot.empty) {
            snapshot = await db.collection("orders")
                .where("trackingNumber", "==", query)
                .get();
        }

        if (snapshot.empty) {
            errorEl.style.display = "block";
            return;
        }

        const order = snapshot.docs[0].data();
        renderTrackingTimeline(order);

    } catch (err) {
        console.error("Direct manual tracking lookup failed:", err);
        errorEl.style.display = "block";
    }
}

// Configures timeline active statuses and maps official USPS external tracking anchor
function renderTrackingTimeline(order) {
    const timelineEl = document.getElementById("timelineWrapper");
    const statusText = document.getElementById("shipmentStatusText");
    const fill = document.getElementById("timelineProgressFill");
    const link = document.getElementById("uspsDirectLink");

    const trackingNum = order.trackingNumber || "Pending";
    const status = (order.shippingStatus || (trackingNum !== "Pending" ? "In Transit" : "Processed")).toLowerCase();

    // Reset visual timeline states first
    document.querySelectorAll(".timeline-step").forEach(el => el.classList.remove("active", "complete"));

    let progressWidth = "0%";

    if (status === "processed") {
        document.getElementById("step1").classList.add("active");
        progressWidth = "10%";
        statusText.innerText = "Order Processed";
    } else if (status === "received") {
        document.getElementById("step1").classList.add("complete");
        document.getElementById("step2").classList.add("active");
        progressWidth = "33%";
        statusText.innerText = "Received by USPS";
    } else if (status === "in transit") {
        document.getElementById("step1").classList.add("complete");
        document.getElementById("step2").classList.add("complete");
        document.getElementById("step3").classList.add("active");
        progressWidth = "66%";
        statusText.innerText = "In Transit within USPS Network";
    } else if (status === "delivered") {
        document.getElementById("step1").classList.add("complete");
        document.getElementById("step2").classList.add("complete");
        document.getElementById("step3").classList.add("complete");
        document.getElementById("step4").classList.add("active");
        progressWidth = "100%";
        statusText.innerText = "Delivered & Received";
    }

    fill.style.width = progressWidth;

    // If shipment has left, provide official external USPS link
    if (trackingNum !== "Pending") {
        link.href = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNum}`;
        link.style.display = "inline-block";
    } else {
        link.style.display = "none";
    }

    timelineEl.style.display = "block";
}