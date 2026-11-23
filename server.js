// TipTap - Real-Time Multi-Restaurant SaaS Platform Server
// Zero external dependencies - uses pure Node.js standard modules!
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3030;
const DB_PATH = path.join(__dirname, 'data', 'tiptap-db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data folder exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Starter template for a newly onboarded restaurant
function createDefaultRestaurant(id, name, phone, address, gstin, tableCount = 8, isSample = false) {
  const tables = [];
  for (let i = 1; i <= tableCount; i++) {
    tables.push({
      id: i,
      name: `Table ${i}`,
      capacity: i <= 2 ? 2 : (i <= 6 ? 4 : 6),
      status: isSample ? (i === 2 ? 'occupied' : (i === 5 ? 'cleaning' : 'free')) : 'free',
      currentOrderId: isSample && i === 2 ? `ORD-${id}-101` : null,
      seatingTime: isSample && i === 2 ? new Date(Date.now() - 15 * 60000).toISOString() : null
    });
  }

  return {
    id,
    name: name || 'New Restaurant',
    tagline: 'Smart NFC Table Dining',
    phone: phone || '+91 98765 43210',
    gstin: gstin || '07AAAAA0000A1Z5',
    address: address || 'Main Road, City Center',
    gstPercent: 5,
    rushMode: false,
    pin: '1234',
    kitchenPin: '5678',
    plan: 'Pro Plan (Active)',
    createdAt: new Date().toISOString(),
    tables,
    menu: [
      {
        id: `${id}_m1`,
        name: 'Paneer Butter Masala',
        category: 'Main Course',
        type: 'veg',
        isJain: true,
        price: 280,
        image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=600&q=80',
        description: 'Rich, creamy cottage cheese curry cooked with aromatic butter & royal spices.',
        inStock: true,
        variants: [{ name: 'Half', price: 160 }, { name: 'Full', price: 280 }],
        addons: [{ name: 'Extra Butter Cube', price: 20 }, { name: 'Garlic Toss', price: 30 }]
      },
      {
        id: `${id}_m2`,
        name: 'Butter Chicken Special',
        category: 'Main Course',
        type: 'nonveg',
        isJain: false,
        price: 340,
        image: 'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?auto=format&fit=crop&w=600&q=80',
        description: 'Smoked tandoori chicken cooked in velvety tomato-cashew makhani gravy.',
        inStock: true,
        variants: [{ name: 'Half', price: 210 }, { name: 'Full', price: 340 }],
        addons: [{ name: 'Extra Chicken Piece', price: 60 }]
      },
      {
        id: `${id}_m3`,
        name: 'Crispy Veg Spring Rolls',
        category: 'Starters',
        type: 'veg',
        isJain: false,
        price: 180,
        image: 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=600&q=80',
        description: 'Golden fried crispy rolls stuffed with shredded veggies, served with chili dip.',
        inStock: true,
        variants: [],
        addons: [{ name: 'Cheesy Dip', price: 30 }]
      },
      {
        id: `${id}_m4`,
        name: 'Amritsari Fish Tikka',
        category: 'Starters',
        type: 'nonveg',
        isJain: false,
        price: 320,
        image: 'https://images.unsplash.com/photo-1599488615731-7e5c2823ff28?auto=format&fit=crop&w=600&q=80',
        description: 'Carom seed-flavored crispy fried fish served with tangy mint chutney.',
        inStock: true,
        variants: [],
        addons: []
      },
      {
        id: `${id}_m5`,
        name: 'Butter Naan / Garlic Naan',
        category: 'Breads',
        type: 'veg',
        isJain: true,
        price: 55,
        image: 'https://images.unsplash.com/photo-1626074353765-517a681e40be?auto=format&fit=crop&w=600&q=80',
        description: 'Clay oven baked Indian flatbread brushed with fresh creamy butter.',
        inStock: true,
        variants: [{ name: 'Butter Naan', price: 55 }, { name: 'Garlic Naan', price: 75 }],
        addons: []
      },
      {
        id: `${id}_m6`,
        name: 'Blueberry Cheesecake',
        category: 'Desserts',
        type: 'veg',
        isJain: true,
        price: 195,
        image: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&w=600&q=80',
        description: 'Silky smooth New York style cheesecake topped with wild blueberry glaze.',
        inStock: true,
        variants: [],
        addons: []
      },
      {
        id: `${id}_m7`,
        name: 'Sky Blue Lagoon Mojito',
        category: 'Beverages',
        type: 'veg',
        isJain: true,
        price: 140,
        image: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=600&q=80',
        description: 'Refreshing blue curacao cooler with fresh mint leaves and sparkling soda.',
        inStock: true,
        variants: [],
        addons: []
      },
      {
        id: `${id}_m8`,
        name: 'Cold Coffee with Ice Cream',
        category: 'Beverages',
        type: 'veg',
        isJain: true,
        price: 160,
        image: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=600&q=80',
        description: 'Rich blended espresso coffee served chilled with a scoop of vanilla ice cream.',
        inStock: true,
        variants: [],
        addons: [{ name: 'Extra Chocolate Drizzle', price: 20 }]
      },
      {
        id: `${id}_m9`,
        name: 'Packaged Mineral Water Bottle (1L)',
        category: 'Beverages',
        type: 'veg',
        isJain: true,
        price: 20,
        image: 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?auto=format&fit=crop&w=600&q=80',
        description: 'Sealed 1 Litre chilled / room temperature mineral drinking water bottle.',
        inStock: true,
        variants: [
          { name: 'Chilled', price: 20 },
          { name: 'Room Temp', price: 20 }
        ],
        addons: []
      },
      {
        id: `${id}_m10`,
        name: 'Tandoori Butter Roti',
        category: 'Breads',
        type: 'veg',
        isJain: true,
        price: 25,
        image: 'https://images.unsplash.com/photo-1626074353765-517a681e40be?auto=format&fit=crop&w=600&q=80',
        description: 'Fresh crisp tandoor-baked whole wheat roti brushed with pure desi butter.',
        inStock: true,
        variants: [],
        addons: []
      }
    ],
    orders: isSample ? [
      {
        id: `ORD-${id}-101`,
        tableId: 2,
        tableName: 'Table 2',
        items: [
          { id: `${id}_m1`, name: 'Paneer Butter Masala', variant: 'Full', price: 280, qty: 1, addons: [], itemTotal: 280 },
          { id: `${id}_m4`, name: 'Butter Naan', variant: 'Butter Naan', price: 55, qty: 2, addons: [], itemTotal: 110 }
        ],
        notes: 'Make curry medium spicy',
        subtotal: 390,
        gst: 19.5,
        total: 409.5,
        status: 'preparing',
        paymentMethod: null,
        createdAt: new Date(Date.now() - 12 * 60000).toISOString(),
        updatedAt: new Date(Date.now() - 8 * 60000).toISOString()
      }
    ] : [],
    serviceRequests: isSample ? [
      { id: `SR-${id}-1`, tableId: 2, tableName: 'Table 2', type: 'water', status: 'pending', time: new Date(Date.now() - 3 * 60000).toISOString() }
    ] : [],
    completedOrders: [],
    promoCodes: [
      { code: 'WELCOME10', type: 'percent', value: 10, minOrder: 200, description: '10% OFF on orders above ₹200' },
      { code: 'FLAT50', type: 'flat', value: 50, minOrder: 400, description: 'Flat ₹50 OFF on orders above ₹400' }
    ],
    customers: isSample ? [
      { phone: '9876543210', name: 'Rahul Sharma', visits: 4, totalSpent: 2850, loyaltyPoints: 285, lastVisit: new Date().toISOString() },
      { phone: '9811122233', name: 'Priya Verma', visits: 2, totalSpent: 1420, loyaltyPoints: 142, lastVisit: new Date().toISOString() }
    ] : [],
    reviews: isSample ? [
      { id: 'rev-1', tableId: 2, customerName: 'Rahul Sharma', rating: 5, comment: 'Paneer Butter Masala was super fresh and creamy! 10/10.', time: new Date(Date.now() - 25 * 60000).toISOString() }
    ] : []
  };
}

// Multi-restaurant Database Structure
function createInitialMultiDb() {
  return {
    superAdmin: {
      name: 'TipTap HQ Platform Admin',
      pin: '0000'
    },
    restaurants: {
      'tiptap-bistro': createDefaultRestaurant(
        'tiptap-bistro',
        'TipTap Bistro & Cafe',
        '+91 98765 43210',
        'Shop 12, Galleria Market, Cyber City',
        '07AAAAA0000A1Z5',
        8
      ),
      'sharma-dhaba': createDefaultRestaurant(
        'sharma-dhaba',
        'Sharma Ji Shuddh Shakahari Dhaba',
        '+91 98111 22233',
        'Highway 44, Near Toll Plaza',
        '07BBBBB1111B2Z6',
        10
      )
    }
  };
}

// Load or upgrade DB
function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // If old single-restaurant structure, upgrade to multi-restaurant
      if (data.restaurant && !data.restaurants) {
        const upgraded = {
          superAdmin: { name: 'TipTap Platform Admin', pin: '0000' },
          restaurants: {
            'tiptap-bistro': {
              id: 'tiptap-bistro',
              ...data.restaurant,
              tables: data.tables || [],
              menu: data.menu || [],
              orders: data.orders || [],
              serviceRequests: data.serviceRequests || [],
              completedOrders: data.completedOrders || []
            }
          }
        };
        saveDb(upgraded);
        return upgraded;
      }
      if (data.restaurants) {
        if (!data.restaurants['sharma-dhaba']) {
          data.restaurants['sharma-dhaba'] = createDefaultRestaurant(
            'sharma-dhaba',
            'Sharma Ji Shuddh Shakahari Dhaba',
            '+91 98111 22233',
            'Highway 44, Near Toll Plaza',
            '07BBBBB1111B2Z6',
            10
          );
        }
        Object.values(data.restaurants).forEach(r => {
          if (!r.plan) r.plan = 'Pro Plan (Active)';
          if (!r.pin) r.pin = '1234';
          if (!r.kitchenPin) r.kitchenPin = '5678';
          if (!r.orders) r.orders = [];
          if (!r.completedOrders) r.completedOrders = [];
          if (!r.serviceRequests) r.serviceRequests = [];
          if (r.menu) {
            const sampleImages = {
              'Paneer Butter Masala': 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=600&q=80',
              'Butter Chicken Special': 'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?auto=format&fit=crop&w=600&q=80',
              'Crispy Veg Spring Rolls': 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=600&q=80',
              'Amritsari Fish Tikka': 'https://images.unsplash.com/photo-1599488615731-7e5c2823ff28?auto=format&fit=crop&w=600&q=80',
              'Butter Naan / Garlic Naan': 'https://images.unsplash.com/photo-1626074353765-517a681e40be?auto=format&fit=crop&w=600&q=80',
              'Blueberry Cheesecake': 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&w=600&q=80',
              'Sky Blue Lagoon Cooler': 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=600&q=80',
              'Sky Blue Lagoon Mojito': 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=600&q=80',
              'Cold Coffee with Ice Cream': 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=600&q=80'
            };
            r.menu.forEach(m => {
              if (!m.image && sampleImages[m.name]) {
                m.image = sampleImages[m.name];
              } else if (!m.image) {
                m.image = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80';
              }
            });
            const hasWater = r.menu.some(m => m.name.toLowerCase().includes('water bottle') || m.name.toLowerCase().includes('mineral water'));
            if (!hasWater) {
              r.menu.push({
                id: `${r.id}_m_water`,
                name: 'Packaged Mineral Water Bottle (1L)',
                category: 'Beverages',
                type: 'veg',
                isJain: true,
                price: 20,
                image: 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?auto=format&fit=crop&w=600&q=80',
                description: 'Sealed 1 Litre chilled / room temperature mineral drinking water bottle.',
                inStock: true,
                variants: [
                  { name: 'Chilled', price: 20 },
                  { name: 'Room Temp', price: 20 }
                ],
                addons: []
              });
            }
          }
          if (!r.promoCodes) {
            r.promoCodes = [
              { code: 'WELCOME10', type: 'percent', value: 10, minOrder: 200, description: '10% OFF on orders above ₹200' },
              { code: 'FLAT50', type: 'flat', value: 50, minOrder: 400, description: 'Flat ₹50 OFF on orders above ₹400' }
            ];
          }
          if (!r.customers) {
            r.customers = [
              { phone: '9876543210', name: 'Rahul Sharma', visits: 4, totalSpent: 2850, loyaltyPoints: 285, lastVisit: new Date().toISOString() },
              { phone: '9811122233', name: 'Priya Verma', visits: 2, totalSpent: 1420, loyaltyPoints: 142, lastVisit: new Date().toISOString() }
            ];
          }
          if (!r.reviews) {
            r.reviews = [
              { id: 'rev-1', tableId: 2, customerName: 'Rahul Sharma', rating: 5, comment: 'Paneer Butter Masala was super fresh and creamy! 10/10.', time: new Date(Date.now() - 25 * 60000).toISOString() }
            ];
          }
        });
      }
      return data;
    }
  } catch (err) {
    console.error('Error reading DB, re-initializing:', err.message);
  }

  const initial = createInitialMultiDb();
  saveDb(initial);
  return initial;
}

let db = loadDb();

// ====================================================
// CLOUD DATABASE PERSISTENCE (MongoDB Atlas / Supabase)
// ====================================================
let mongoClient = null;
let mongoDb = null;
let isMongoConnected = false;
let mongoCollection = null;
let mongoDbError = null;

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.DATABASE_URL;

// Helper: Strip test orders, test customers, and test service calls when initializing fresh database
function cleanProductionSeed(sourceDb) {
  const clean = JSON.parse(JSON.stringify(sourceDb || {}));
  clean.leads = [];
  if (clean.restaurants) {
    Object.values(clean.restaurants).forEach(r => {
      r.orders = [];
      r.completedOrders = [];
      r.serviceRequests = [];
      r.customers = [];
      if (r.tables) {
        r.tables.forEach(t => {
          t.status = 'free';
          t.currentOrderId = null;
          t.seatingTime = null;
          t.reservedFor = null;
          t.reservedTime = null;
        });
      }
    });
  }
  return clean;
}

async function initCloudDatabase() {
  if (!MONGODB_URI) {
    console.log('ℹ️  [TipTap DB] MONGODB_URI not set. Running in Persistent Local File Mode (data/tiptap-db.json).');
    console.log('💡 [TipTap DB Tip] Set MONGODB_URI in Render Environment Variables for 100% permanent cloud persistence across redeployments!');
    return;
  }

  try {
    const { MongoClient } = require('mongodb');
    const timeoutMs = parseInt(process.env.MONGODB_TIMEOUT_MS, 10) || 3000;
    mongoClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs
    });

    await mongoClient.connect();
    isMongoConnected = true;
    mongoDbError = null;
    mongoDb = mongoClient.db('tiptap');
    mongoCollection = mongoDb.collection('system_store');

    console.log('✅ [TipTap Cloud DB] Successfully connected to MongoDB Atlas Cloud Cluster!');

    // Check if cloud database already has saved state
    const cloudRecord = await mongoCollection.findOne({ _id: 'tiptap_main_store' });

    if (cloudRecord && cloudRecord.restaurants && Object.keys(cloudRecord.restaurants).length > 0) {
      console.log('🔄 [TipTap Cloud DB] Loaded persistent restaurants & orders from MongoDB Atlas!');
      const { _id, ...cleanData } = cloudRecord;
      db = cleanData;
      try {
        fs.writeFileSync(DB_PATH, JSON.stringify(cleanData, null, 2), 'utf8');
      } catch (e) {}
    } else {
      console.log('📤 [TipTap Cloud DB] Initializing fresh MongoDB collection with clean seed (zero test data)...');
      const seedData = cleanProductionSeed(db);
      db = seedData;
      await mongoCollection.updateOne(
        { _id: 'tiptap_main_store' },
        { $set: seedData },
        { upsert: true }
      );
      console.log('✅ [TipTap Cloud DB] Clean restaurant catalogs and floor layouts uploaded to MongoDB Atlas.');
    }
  } catch (err) {
    console.error('⚠️ [TipTap Cloud DB] MongoDB connection failed:', err.message);
    isMongoConnected = false;
    mongoDbError = err.message;
    if (process.env.NODE_ENV === 'production' && MONGODB_URI) {
      console.error('🚨 [TipTap FATAL] Running in production with unreachable MongoDB Atlas! Fail-closed protection active: mutating writes will be blocked to prevent ephemeral data loss.');
    } else {
      console.log('ℹ️  [TipTap DB] Falling back safely to Local File Mode for development.');
    }
  }
}

function saveDb(data) {
  // 1. Save to local disk immediately
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving local DB:', err.message);
  }

  // 2. If connected to MongoDB, persist to cloud asynchronously
  if (isMongoConnected && mongoCollection) {
    mongoCollection.updateOne(
      { _id: 'tiptap_main_store' },
      { $set: data },
      { upsert: true }
    ).catch(err => {
      console.error('⚠️ [TipTap Cloud DB] Cloud write synchronization failed:', err.message);
      isMongoConnected = false;
      mongoDbError = err.message;
    });
  }
}

// In-Memory Rate Limiting for Security
const authAttempts = new Map();

function isRateLimited(ip, maxAttempts = 8, windowMs = 300000) {
  const now = Date.now();
  let record = authAttempts.get(ip);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + windowMs };
    authAttempts.set(ip, record);
  }
  return record.count >= maxAttempts;
}

function recordFailedAttempt(ip, windowMs = 300000) {
  const now = Date.now();
  let record = authAttempts.get(ip);
  if (!record || now > record.resetAt) {
    record = { count: 1, resetAt: now + windowMs };
  } else {
    record.count++;
  }
  authAttempts.set(ip, record);
}

function clearAttempts(ip) {
  authAttempts.delete(ip);
}

// Helper: Get restaurant by exact ID (never silently selects another restaurant)
function getRestaurant(restId) {
  if (!restId || !db.restaurants) return null;
  return db.restaurants[restId] || null;
}

// Reusable sanitizer: Strips PINs, credentials, and hashes from client-facing responses
function safeRestaurantForClient(r) {
  if (!r) return null;
  const {
    pin: _pin,
    kitchenPin: _kitchenPin,
    pinHash: _pinHash,
    kitchenPinHash: _kitchenPinHash,
    password: _pass,
    secret: _sec,
    masterPin: _master,
    ...safe
  } = r;

  const safePaymentConfig = {
    upiVpa: r.paymentConfig?.upiVpa || 'tiptap.merchant@icici',
    merchantName: r.paymentConfig?.merchantName || r.name,
    mode: r.paymentConfig?.mode || 'upi_dynamic'
  };

  return {
    ...safe,
    paymentConfig: safePaymentConfig
  };
}

// Active Server-Sent Event (SSE) client connections
const sseClients = new Set();

function broadcastEvent(restaurantId, eventType, payload) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify({ restaurantId, payload })}\n\n`;
  for (const client of sseClients) {
    try {
      // If client subscribed to specific restaurant, super-admin, or all
      if (!client.restaurantId || client.restaurantId === 'all' || client.restaurantId === 'super-admin' || client.restaurantId === restaurantId) {
        client.res.write(message);
      }
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Render reverse-proxy drops idle HTTP connections after 55s.
// Keep-alive heartbeat comment (: keepalive\n\n) every 25s ensures POS/KDS connections stay alive permanently.
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': keepalive\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 25000);

// Get Local LAN IP for phone NFC testing
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// ====================================================
// CRYPTOGRAPHIC CREDENTIAL & SESSION MANAGEMENT
// ====================================================
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map(); // sessionId -> session data

function hashPin(pin) {
  if (!pin) return '';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin.toString(), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPin(inputPin, storedValue) {
  if (!inputPin || !storedValue) return false;
  const inputStr = inputPin.toString();
  const storedStr = storedValue.toString();

  if (storedStr.startsWith('scrypt$')) {
    const parts = storedStr.split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const originalHash = parts[2];
    try {
      const derived = crypto.scryptSync(inputStr, salt, 32).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(originalHash, 'hex'));
    } catch (e) {
      return false;
    }
  }

  const bufA = Buffer.from(inputStr);
  const bufB = Buffer.from(storedStr);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createSession({ role, restaurantId = null, restaurantName = null }) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session = {
    id: sessionId,
    role,
    restaurantId,
    restaurantName,
    csrfToken,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function invalidateSession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

function invalidateRestaurantSessions(restaurantId) {
  if (!restaurantId) return;
  for (const [id, s] of sessions.entries()) {
    if (s.restaurantId === restaurantId) {
      sessions.delete(id);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}, 15 * 60 * 1000);

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      const val = parts.join('=').trim();
      list[name] = decodeURI(val);
    });
  }
  return list;
}

function setSessionCookie(res, sessionId, req) {
  const isHttps = req && (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted);
  const secureFlag = (process.env.NODE_ENV === 'production' || isHttps) ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'tiptap_session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' + secureFlag);
}

function clearSessionCookie(res, req) {
  const isHttps = req && (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted);
  const secureFlag = (process.env.NODE_ENV === 'production' || isHttps) ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'tiptap_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureFlag);
}

function authenticateRequest(req) {
  const cookies = parseCookies(req);
  let sessionId = null;
  let isCookieAuth = false;

  if (cookies['tiptap_session']) {
    sessionId = cookies['tiptap_session'];
    isCookieAuth = true;
  } else if (req.headers && req.headers.authorization) {
    const auth = req.headers.authorization.trim();
    if (auth.toLowerCase().startsWith('bearer ')) {
      sessionId = auth.substring(7).trim();
      isCookieAuth = false;
    }
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      sessionId = u.searchParams.get('auth_token');
      isCookieAuth = false;
    } catch (e) {}
  }

  const session = getSession(sessionId);
  if (!session) return null;
  return { ...session, isCookieAuth };
}

function verifyCsrfToken(req, session) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (!session) return true;
  if (!session.isCookieAuth) return true;
  if (!session.csrfToken) return false;

  const token = req.headers && (req.headers['x-csrf-token'] || req.headers['x-xsrf-token']);
  if (token && token.trim() === session.csrfToken) return true;

  return false;
}

function checkCsrfForCookieAuth(req, res, session) {
  if (session && session.isCookieAuth && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!verifyCsrfToken(req, session)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Invalid or missing CSRF token' }));
      return false;
    }
  }
  return true;
}

function isSuperAdminAuthenticated(req, bodyPin) {
  const session = authenticateRequest(req);
  if (session && session.role === 'superadmin') {
    return true;
  }

  const pin = (bodyPin || (req.headers && req.headers['x-master-pin']) || '').toString().trim();
  if (pin) {
    const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').toString().trim();
    if (envPin && verifyPin(pin, envPin)) return true;
    if (db.superAdmin && db.superAdmin.pin && verifyPin(pin, db.superAdmin.pin)) return true;
  }

  return false;
}

function verifyRestaurantAccess(req, targetRestaurantId, allowedRoles = ['restaurant_owner', 'counter_staff', 'kitchen_staff']) {
  const session = authenticateRequest(req);
  if (!session) {
    return { authorized: false, status: 401, error: 'Unauthorized: Authentication session required' };
  }
  if (session.role === 'superadmin') {
    return { authorized: true, session };
  }
  if (session.restaurantId !== targetRestaurantId) {
    return { authorized: false, status: 403, error: "Forbidden: Cannot access another restaurant's data" };
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    return { authorized: false, status: 403, error: "Forbidden: Role '" + session.role + "' is not authorized for this action" };
  }
  return { authorized: true, session };
}

function migrateAndSecureCredentials() {
  let changed = false;

  if (!db.superAdmin) {
    db.superAdmin = { name: 'TipTap Platform Super Admin' };
  }
  const targetSuperPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || db.superAdmin.pin || '0000').toString().trim();
  if (!db.superAdmin.pin || !db.superAdmin.pin.startsWith('scrypt$')) {
    db.superAdmin.pin = hashPin(targetSuperPin);
    changed = true;
  }

  if (db.restaurants) {
    Object.values(db.restaurants).forEach(r => {
      if (r.pin && !r.pin.startsWith('scrypt$')) {
        r.pin = hashPin(r.pin);
        changed = true;
      }
      if (r.kitchenPin && !r.kitchenPin.startsWith('scrypt$')) {
        r.kitchenPin = hashPin(r.kitchenPin);
        changed = true;
      }
    });
  }

  if (changed) {
    saveDb(db);
    console.log('🔒 [TipTap Security] Migrated all credentials to secure salted scrypt hashes.');
  }
}

// HTTP Request Handler
const server = http.createServer((req, res) => {
  // Production Security & CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  // ----------------------------------------------------
  // HEALTH CHECK & UPTIME KEEP-ALIVE: /healthz or /api/health
  // ----------------------------------------------------
  if (pathname === '/healthz' || pathname === '/api/health') {
    const isCloudDbExpected = Boolean(process.env.NODE_ENV === 'production' && MONGODB_URI);
    const isHealthy = !isCloudDbExpected || isMongoConnected;
    const statusCode = isHealthy ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'healthy' : 'unhealthy',
      platform: 'TipTap Smart Dining POS',
      version: '2.5.0-production',
      uptimeSeconds: Math.floor(process.uptime()),
      database: {
        mode: isMongoConnected ? 'mongodb-atlas-cloud' : (MONGODB_URI ? 'cloud-disconnected' : 'local-json-persistent'),
        connected: isMongoConnected || (!MONGODB_URI && process.env.NODE_ENV !== 'production'),
        error: isMongoConnected ? null : (mongoDbError || (MONGODB_URI ? 'Database disconnected' : null)),
        restaurantsCount: db.restaurants ? Object.keys(db.restaurants).length : 0
      },
      realtime: {
        sseClientsConnected: sseClients.size
      },
      systemMemoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // ----------------------------------------------------
  // FAIL-CLOSED PRODUCTION WRITE GUARD
  // If running in production with MONGODB_URI configured but disconnected,
  // reject state-modifying requests with HTTP 503 to prevent data loss on ephemeral disk.
  // ----------------------------------------------------
  const isMutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (process.env.NODE_ENV === 'production' && MONGODB_URI && !isMongoConnected && isMutatingMethod) {
    if (!pathname.startsWith('/api/auth/') && pathname !== '/api/admin/verify-pin') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Database Unavailable: MongoDB Atlas cluster is disconnected. State modifications are paused in production to prevent data loss.',
        status: 'service_unavailable'
      }));
      return;
    }
  }

  // ----------------------------------------------------
  // SSE REAL-TIME ENDPOINT: /api/events or /events
  // ----------------------------------------------------
  if (pathname === '/api/events' || pathname === '/events') {
    const restaurantId = searchParams.get('restaurant') || 'all';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', restaurantId, time: Date.now() })}\n\n`);

    const client = { res, restaurantId };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
    return;
  }

  // ----------------------------------------------------
  // REST API ENDPOINTS
  // ----------------------------------------------------
  if (pathname.startsWith('/api/')) {
    function readJsonBody(callback) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          callback(null, json);
        } catch (e) {
          callback(e);
        }
      });
    }

    // Helper: Verify Platform Super Admin Master PIN
    function verifyMasterPin(bodyPin) {
      const session = authenticateRequest(req);
      if (session && session.role === 'superadmin') {
        if (!checkCsrfForCookieAuth(req, res, session)) {
          return false;
        }
        return true;
      }

      const pin = (bodyPin || (req.headers && req.headers['x-master-pin']) || '').toString().trim();
      if (pin) {
        const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').toString().trim();
        if (envPin && verifyPin(pin, envPin)) return true;
        if (db.superAdmin && db.superAdmin.pin && verifyPin(pin, db.superAdmin.pin)) return true;
      }

      return false;
    }

    // 1. List All Restaurants (Restricted to Super Admin HQ)
    if (pathname === '/api/restaurants' && req.method === 'GET') {
      if (!isSuperAdminAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Super Admin session required to view restaurants list' }));
        return;
      }

      const list = Object.values(db.restaurants).map(r => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        address: r.address,
        plan: r.plan || 'Pro Plan (Active)',
        tableCount: (r.tables || []).length,
        activeOrdersCount: (r.orders || []).length,
        menuItemsCount: (r.menu || []).length,
        paymentConfig: r.paymentConfig || { upiVpa: 'tiptap.merchant@icici', merchantName: r.name },
        createdAt: r.createdAt
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    // 2. Onboard New Restaurant (Super Admin): POST /api/restaurants
    if (pathname === '/api/restaurants' && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (!verifyMasterPin(data?.masterPin)) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Valid Super Admin Master PIN required' }));
          return;
        }

        if (err || !data.name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Restaurant name is required' }));
          return;
        }

        // Generate clean URL slug from name (e.g. "Royal Biryani & Co" -> "royal-biryani-co")
        let slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!slug || db.restaurants[slug]) {
          slug = `${slug || 'restaurant'}-${Date.now().toString().slice(-4)}`;
        }

        const tablesCount = parseInt(data.tablesCount, 10) || 8;
        const newRestaurant = createDefaultRestaurant(
          slug,
          data.name,
          data.phone || '+91 98000 00000',
          data.address || 'India',
          data.gstin || '',
          tablesCount,
          false
        );

        if (data.pin) newRestaurant.pin = data.pin;
        if (data.kitchenPin) newRestaurant.kitchenPin = data.kitchenPin;
        if (data.upiVpa) {
          newRestaurant.paymentConfig = {
            upiVpa: data.upiVpa,
            merchantName: data.name,
            mode: 'upi_dynamic'
          };
        }
        db.restaurants[slug] = newRestaurant;
        saveDb(db);

        broadcastEvent(slug, 'restaurant:new', { id: slug, name: newRestaurant.name });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, restaurant: safeRestaurantForClient(newRestaurant) }));
      });
      return;
    }

    // 2b. Delete Restaurant (Super Admin): DELETE /api/restaurants/:id
    const deleteRestMatch = pathname.match(/^\/api\/restaurants\/([A-Za-z0-9_-]+)$/);
    if (deleteRestMatch && req.method === 'DELETE') {
      if (!verifyMasterPin()) {
        if (res.headersSent) return;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Master PIN required to delete restaurant' }));
        return;
      }

      const delId = deleteRestMatch[1];
      if (!db.restaurants[delId]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Restaurant not found' }));
        return;
      }
      if (Object.keys(db.restaurants).length <= 1) {
        const fallbackSlug = delId === 'tiptap-bistro' ? 'new-restaurant' : 'tiptap-bistro';
        db.restaurants[fallbackSlug] = createDefaultRestaurant(fallbackSlug, 'TipTap Smart Dining', '+91 98000 00000', 'India', '', 8, false);
      }
      delete db.restaurants[delId];
      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deletedId: delId }));
      return;
    }

    // 2c. Reset Data / Orders (Super Admin): POST /api/admin/reset
    if (pathname === '/api/admin/reset' && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (!verifyMasterPin(data?.pin)) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Valid Super Admin Master PIN required to reset order data' }));
          return;
        }

        const restId = searchParams.get('restaurant') || data?.restaurant;
        if (restId && !db.restaurants[restId]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Restaurant not found' }));
          return;
        }
        const targets = restId ? [db.restaurants[restId]] : Object.values(db.restaurants);
        targets.forEach(r => {
          r.orders = [];
          r.completedOrders = [];
          r.serviceRequests = [];
          (r.tables || []).forEach(t => {
            t.status = 'free';
            t.currentOrderId = null;
            t.seatingTime = null;
            t.reservedFor = null;
            t.reservedTime = null;
          });
          broadcastEvent(r.id, 'order:update', {});
          broadcastEvent(r.id, 'service:resolved', { all: true });
          broadcastEvent(r.id, 'table:update', r.tables);
        });
        saveDb(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Data reset successfully! All tables are free.' }));
      });
      return;
    }

    // 2d. Lead / Partner Onboarding Request: POST /api/leads
    if (pathname === '/api/leads' && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (err || !data.name || !data.phone) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Restaurant Name and Owner Phone are required' }));
          return;
        }

        const lead = {
          id: `lead_${Date.now()}`,
          name: data.name.trim(),
          ownerName: (data.ownerName || '').trim(),
          phone: data.phone.trim(),
          city: (data.city || data.address || '').trim(),
          address: (data.address || data.city || '').trim(),
          tablesCount: parseInt(data.tablesCount, 10) || 8,
          upiVpa: (data.upiVpa || '').trim(),
          status: 'pending',
          createdAt: new Date().toISOString()
        };

        db.leads = db.leads || [];
        db.leads.unshift(lead);
        saveDb(db);

        broadcastEvent('super-admin', 'lead:new', lead);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Onboarding application received!', lead }));
      });
      return;
    }

    // 2e. List All Leads (Restricted to Super Admin HQ)
    if (pathname === '/api/leads' && req.method === 'GET') {
      if (!verifyMasterPin()) {
        if (res.headersSent) return;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Super Admin Master PIN required to view onboarding leads' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(db.leads || []));
      return;
    }

    // 2f. Approve Lead & Provision Restaurant: POST /api/leads/:id/approve
    const approveLeadMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_-]+)\/approve$/);
    if (approveLeadMatch && req.method === 'POST') {
      if (!verifyMasterPin()) {
        if (res.headersSent) return;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Master PIN required to approve applications' }));
        return;
      }

      const leadId = approveLeadMatch[1];
      db.leads = db.leads || [];
      const lead = db.leads.find(l => l.id === leadId);

      if (!lead) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Lead not found' }));
        return;
      }

      let slug = lead.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!slug || db.restaurants[slug]) {
        slug = `${slug || 'restaurant'}-${Date.now().toString().slice(-4)}`;
      }

      const tablesCount = lead.tablesCount || 8;
      const newRestaurant = createDefaultRestaurant(
        slug,
        lead.name,
        lead.phone,
        lead.address || lead.city || 'India',
        '',
        tablesCount,
        false
      );

      if (lead.upiVpa) {
        newRestaurant.paymentConfig = {
          upiVpa: lead.upiVpa,
          merchantName: lead.name,
          mode: 'upi_dynamic'
        };
      }

      db.restaurants[slug] = newRestaurant;
      lead.status = 'approved';
      lead.restaurantId = slug;
      lead.approvedAt = new Date().toISOString();

      saveDb(db);
      broadcastEvent(slug, 'restaurant:new', { id: slug, name: newRestaurant.name });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, restaurant: safeRestaurantForClient(newRestaurant), lead }));
      return;
    }

    // 2g. Delete / Reject Lead: DELETE /api/leads/:id
    const deleteLeadMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_-]+)$/);
    if (deleteLeadMatch && req.method === 'DELETE') {
      if (!verifyMasterPin()) {
        if (res.headersSent) return;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Master PIN required to delete application' }));
        return;
      }

      const leadId = deleteLeadMatch[1];
      db.leads = db.leads || [];
      db.leads = db.leads.filter(l => l.id !== leadId);
      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deletedId: leadId }));
      return;
    }

    // 2x. Session Status Check: GET /api/auth/session
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const session = authenticateRequest(req);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          authenticated: true,
          role: session.role === 'kitchen_staff' ? 'kitchen' : (session.role === 'counter_staff' ? 'counter' : session.role),
          restaurantId: session.restaurantId,
          restaurantName: session.restaurantName,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false }));
      }
      return;
    }

    // 2y. Session Logout: POST /api/auth/logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const session = authenticateRequest(req);
      if (session) {
        invalidateSession(session.id);
      }
      clearSessionCookie(res, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
      return;
    }

    // 2h. Verify Super Admin Master PIN: POST /api/admin/verify-pin
    if (pathname === '/api/admin/verify-pin' && req.method === 'POST') {
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Too many failed login attempts. Please wait 5 minutes.' }));
        return;
      }

      readJsonBody((err, data) => {
        const pin = (data?.pin || '').trim();
        const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').trim();
        const isMasterValid = (envPin && verifyPin(pin, envPin)) || (db.superAdmin?.pin && verifyPin(pin, db.superAdmin.pin));

        if (isMasterValid) {
          clearAttempts(clientIp);
          const session = createSession({ role: 'superadmin' });
          setSessionCookie(res, session.id, req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Super Admin PIN verified',
            sessionId: session.id,
            csrfToken: session.csrfToken,
            redirectUrl: '/super-admin.html'
          }));
        } else {
          recordFailedAttempt(clientIp);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid Super Admin Master PIN' }));
        }
      });
      return;
    }

    // 2i. Restaurant Partner Login: POST /api/auth/restaurant-login
    if (pathname === '/api/auth/restaurant-login' && req.method === 'POST') {
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Too many failed login attempts. Please wait 5 minutes.' }));
        return;
      }

      readJsonBody((err, data) => {
        if (err || !data.identifier || !data.pin) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please enter your registered phone number or restaurant ID, and PIN' }));
          return;
        }

        const rawIdent = data.identifier.toString().trim().toLowerCase();
        const cleanIdentPhone = rawIdent.replace(/[^0-9]/g, '');
        const pin = data.pin.toString().trim();

        // 1. Check if logging in as Platform Super Admin
        if (['admin', 'superadmin', 'master', 'super'].includes(rawIdent)) {
          const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').trim();
          const isMasterValid = (envPin && verifyPin(pin, envPin)) || (db.superAdmin?.pin && verifyPin(pin, db.superAdmin.pin));
          if (isMasterValid) {
            clearAttempts(clientIp);
            const session = createSession({ role: 'superadmin' });
            setSessionCookie(res, session.id, req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              role: 'superadmin',
              sessionId: session.id,
              csrfToken: session.csrfToken,
              redirectUrl: '/super-admin.html'
            }));
            return;
          } else {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid Super Admin credentials' }));
            return;
          }
        }

        // 2. Search in db.restaurants (Exact ID, registered phone, or exact name)
        const targetRest = Object.values(db.restaurants).find(r => {
          const rPhoneClean = (r.phone || '').replace(/[^0-9]/g, '');
          const phoneMatch = cleanIdentPhone && rPhoneClean && (rPhoneClean.endsWith(cleanIdentPhone) || cleanIdentPhone.endsWith(rPhoneClean));
          const idMatch = r.id.toLowerCase() === rawIdent;
          const nameMatch = r.name.toLowerCase() === rawIdent;
          return phoneMatch || idMatch || nameMatch;
        });

        if (!targetRest) {
          recordFailedAttempt(clientIp);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No restaurant found with this phone number or ID. Please check or register first.' }));
          return;
        }

        const station = (data.station || 'counter').toString().trim();
        const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').trim();
        const isMaster = (envPin && verifyPin(pin, envPin)) || (db.superAdmin?.pin && verifyPin(pin, db.superAdmin.pin));
        const isCounterPin = targetRest.pin && verifyPin(pin, targetRest.pin);
        const isKitchenPin = targetRest.kitchenPin && verifyPin(pin, targetRest.kitchenPin);

        if (station === 'kds') {
          // Kitchen KDS login: accepts kitchenPin, counterPin, or masterPin
          if (isKitchenPin || isCounterPin || isMaster) {
            clearAttempts(clientIp);
            const session = createSession({
              role: 'kitchen_staff',
              restaurantId: targetRest.id,
              restaurantName: targetRest.name
            });
            setSessionCookie(res, session.id, req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              role: 'kitchen',
              restaurant: {
                id: targetRest.id,
                name: targetRest.name,
                phone: targetRest.phone
              },
              sessionId: session.id,
              csrfToken: session.csrfToken,
              redirectUrl: '/kds.html?restaurant=' + targetRest.id
            }));
            return;
          } else {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid Kitchen Chef Passkey.' }));
            return;
          }
        } else {
          // Billing Counter login: strictly blocks kitchen passkey!
          if (isCounterPin || isMaster) {
            clearAttempts(clientIp);
            const session = createSession({
              role: 'counter_staff',
              restaurantId: targetRest.id,
              restaurantName: targetRest.name
            });
            setSessionCookie(res, session.id, req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              role: 'counter',
              restaurant: {
                id: targetRest.id,
                name: targetRest.name,
                phone: targetRest.phone
              },
              sessionId: session.id,
              csrfToken: session.csrfToken,
              redirectUrl: '/dashboard.html?restaurant=' + targetRest.id
            }));
            return;
          } else if (isKitchenPin) {
            recordFailedAttempt(clientIp);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '🚫 Access Denied: Kitchen staff cannot access the Billing Counter. Please enter Cashier / Owner PIN, or switch destination to Kitchen KDS.' }));
            return;
          } else {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Incorrect Cashier / Manager PIN.' }));
            return;
          }
        }
      });
      return;
    }

    // 2j. Verify Restaurant Staff PIN: POST /api/auth/verify-restaurant-pin
    if (pathname === '/api/auth/verify-restaurant-pin' && req.method === 'POST') {
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Too many failed login attempts. Please wait 5 minutes.' }));
        return;
      }

      readJsonBody((err, data) => {
        let restId = (data.restaurantId || '').toString().trim();
        const pin = (data.pin || '').toString().trim();
        const station = (data.station || 'counter').toString().trim();

        if (data.restaurantId && !db.restaurants[restId]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Restaurant not found' }));
          return;
        }

        if (!restId) {
          const firstRest = Object.values(db.restaurants)[0];
          restId = firstRest ? firstRest.id : 'tiptap-bistro';
        }

        const r = db.restaurants[restId];
        if (!r) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Restaurant not found' }));
          return;
        }

        const envPin = (process.env.SUPER_ADMIN_PIN || process.env.TIPTAP_MASTER_PIN || '').trim();
        const isMaster = (envPin && verifyPin(pin, envPin)) || (db.superAdmin?.pin && verifyPin(pin, db.superAdmin.pin));
        const isCounterPin = r.pin && verifyPin(pin, r.pin);
        const isKitchenPin = r.kitchenPin && verifyPin(pin, r.kitchenPin);

        if (station === 'kds') {
          // Kitchen KDS unlock
          if (isKitchenPin || isCounterPin || isMaster) {
            clearAttempts(clientIp);
            const session = createSession({
              role: 'kitchen_staff',
              restaurantId: r.id,
              restaurantName: r.name
            });
            setSessionCookie(res, session.id, req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              role: 'kitchen',
              restaurantId: r.id, 
              restaurantName: r.name,
              sessionId: session.id,
              csrfToken: session.csrfToken
            }));
          } else {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Incorrect Kitchen Chef Passkey.' }));
          }
        } else {
          // Billing Counter unlock: strictly blocks kitchen passkey!
          if (isCounterPin || isMaster) {
            clearAttempts(clientIp);
            const session = createSession({
              role: 'counter_staff',
              restaurantId: r.id,
              restaurantName: r.name
            });
            setSessionCookie(res, session.id, req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              role: 'counter',
              restaurantId: r.id, 
              restaurantName: r.name,
              sessionId: session.id,
              csrfToken: session.csrfToken
            }));
          } else if (isKitchenPin) {
            recordFailedAttempt(clientIp);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false, 
              error: '🚫 Access Denied: Kitchen Chef passkey cannot access the Billing Counter. Please enter Cashier / Owner PIN.' 
            }));
          } else {
            recordFailedAttempt(clientIp);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Incorrect Cashier / Manager PIN.' }));
          }
        }
      });
      return;
    }

    // 3. Network IP (for physical NFC card programming)
    if (pathname === '/api/network-ip' && req.method === 'GET') {
      const localIp = getLocalIpAddress();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ localIp, port: currentPort }));
      return;
    }

    // Determine target restaurant for restaurant-specific APIs
    const restIdFromQuery = searchParams.get('restaurant');
    const restMatch = pathname.match(/^\/api\/r\/([A-Za-z0-9_-]+)/);
    const hasExplicitRestId = Boolean(restMatch || restIdFromQuery);
    const targetRestId = restMatch ? restMatch[1] : (restIdFromQuery || Object.keys(db.restaurants)[0]);
    const restaurant = getRestaurant(targetRestId);

    if (hasExplicitRestId && !restaurant) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Restaurant not found' }));
      return;
    }

    if (!restaurant) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No restaurant configured on platform' }));
      return;
    }

    // Helper: Verify restaurant staff authorization (Counter PIN or Kitchen PIN or Server Session)
    function verifyStaffAuth(data, roleRequired = 'any') {
      const session = authenticateRequest(req);
      if (session) {
        if (!checkCsrfForCookieAuth(req, res, session)) {
          return false;
        }
        if (session.role === 'superadmin') return true;
        if (session.restaurantId !== targetRestId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Forbidden: Cannot access another restaurant's data" }));
          return false;
        }
        if (roleRequired === 'counter' && session.role !== 'counter_staff' && session.role !== 'restaurant_owner') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Forbidden: Station requires counter role, but session is ${session.role}` }));
          return false;
        }
        return true;
      }

      const staffPin = (req.headers['x-staff-pin'] || data?.staffPin || searchParams.get('staffPin') || '').toString().trim();
      const masterPin = (req.headers['x-master-pin'] || data?.masterPin || searchParams.get('masterPin') || '').toString().trim();
      if (verifyMasterPin(masterPin)) return true;
      if (!staffPin || !restaurant) return false;
      if (roleRequired === 'counter') {
        return verifyPin(staffPin, restaurant.pin);
      }
      return verifyPin(staffPin, restaurant.pin) || verifyPin(staffPin, restaurant.kitchenPin);
    }

    // 4. Restaurant State (Role-Filtered & Tenant Isolated): GET /api/state or GET /api/r/:id/state
    if ((pathname === '/api/state' || pathname === `/api/r/${targetRestId}/state`) && req.method === 'GET') {
      const session = authenticateRequest(req);
      let isMaster = false;
      let isCounterStaff = false;
      let isKitchenStaff = false;

      if (session) {
        if (session.role === 'superadmin') {
          isMaster = true;
          isCounterStaff = true;
          isKitchenStaff = true;
        } else if (session.restaurantId === targetRestId) {
          if (session.role === 'counter_staff' || session.role === 'restaurant_owner') {
            isCounterStaff = true;
            isKitchenStaff = true;
          } else if (session.role === 'kitchen_staff') {
            isKitchenStaff = true;
          }
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Forbidden: Cannot access another restaurant's data" }));
          return;
        }
      } else {
        const staffPin = (req.headers['x-staff-pin'] || searchParams.get('staffPin') || '').toString().trim();
        const masterPin = (req.headers['x-master-pin'] || searchParams.get('masterPin') || '').toString().trim();
        isMaster = verifyMasterPin(masterPin);
        isCounterStaff = (staffPin && verifyPin(staffPin, restaurant.pin)) || isMaster;
        isKitchenStaff = (staffPin && verifyPin(staffPin, restaurant.kitchenPin)) || isCounterStaff;
      }
      const isAnyStaff = isCounterStaff || isKitchenStaff;

      // Base sanitized restaurant info (Never leak secret credentials)
      const sanitizedPaymentConfig = {
        upiVpa: restaurant.paymentConfig?.upiVpa || 'tiptap.merchant@icici',
        merchantName: restaurant.paymentConfig?.merchantName || restaurant.name,
        mode: restaurant.paymentConfig?.mode || 'upi_dynamic'
      };

      if (!isAnyStaff) {
        // Customer / Public Diner at Table View:
        const tableQuery = searchParams.get('table');
        const orderIdQuery = searchParams.get('orderId');

        // Only return order(s) for the specific table or order queried
        const customerOrders = (restaurant.orders || []).filter(o => {
          if (orderIdQuery && o.id === orderIdQuery) return true;
          if (tableQuery) {
            return o.tableId == tableQuery || o.tableName === `Table ${tableQuery}` || o.tableName === `T-${tableQuery}` || o.tableName === `T0${tableQuery}`;
          }
          return false;
        });

        const customerCompleted = orderIdQuery
          ? (restaurant.completedOrders || []).filter(o => o.id === orderIdQuery)
          : [];

        const customerService = tableQuery
          ? (restaurant.serviceRequests || []).filter(s => s.tableId == tableQuery)
          : [];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            tagline: restaurant.tagline,
            phone: restaurant.phone,
            address: restaurant.address,
            gstin: restaurant.gstin,
            gstPercent: restaurant.gstPercent,
            rushMode: restaurant.rushMode,
            plan: restaurant.plan,
            paymentConfig: sanitizedPaymentConfig
          },
          tables: (restaurant.tables || []).map(t => ({ id: t.id, name: t.name, status: t.status })),
          menu: restaurant.menu,
          orders: customerOrders,
          serviceRequests: customerService,
          completedOrders: customerCompleted,
          promoCodes: restaurant.promoCodes || [],
          reviews: restaurant.reviews || []
        }));
        return;
      }

      // Staff View (Billing Counter or Kitchen KDS):
      const statePayload = {
        restaurant: {
          id: restaurant.id,
          name: restaurant.name,
          tagline: restaurant.tagline,
          phone: restaurant.phone,
          address: restaurant.address,
          gstin: restaurant.gstin,
          gstPercent: restaurant.gstPercent,
          rushMode: restaurant.rushMode,
          plan: restaurant.plan,
          paymentConfig: isCounterStaff ? (restaurant.paymentConfig || sanitizedPaymentConfig) : sanitizedPaymentConfig
        },
        tables: restaurant.tables,
        menu: restaurant.menu,
        orders: restaurant.orders,
        serviceRequests: restaurant.serviceRequests,
        promoCodes: restaurant.promoCodes || [],
        reviews: restaurant.reviews || []
      };

      // Only Counter Staff gets completed orders & customer CRM for this restaurant
      if (isCounterStaff) {
        statePayload.completedOrders = restaurant.completedOrders || [];
        statePayload.customers = restaurant.customers || [];
      }

      // ONLY Platform Super Admin gets the global restaurants directory!
      if (isMaster) {
        statePayload.allRestaurants = Object.keys(db.restaurants).map(k => ({ id: k, name: db.restaurants[k].name }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statePayload));
      return;
    }

    // 4b. Safe Customer Loyalty Lookup (Phone only, no customer list leak): GET /api/customer-lookup
    if (pathname === '/api/customer-lookup' && req.method === 'GET') {
      const cleanPhone = (searchParams.get('phone') || '').replace(/[^0-9]/g, '');
      if (!cleanPhone || cleanPhone.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false }));
        return;
      }
      const match = (restaurant.customers || []).find(c => (c.phone || '').replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-10)));
      if (match) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: true, name: match.name || '', loyaltyPoints: match.loyaltyPoints || 0 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false, loyaltyPoints: 0 }));
      }
      return;
    }

    // 5. Verify Promo Code: POST /api/verify-promo
    if (pathname.includes('/verify-promo') && req.method === 'POST') {
      readJsonBody((err, data) => {
        const code = (data.code || '').trim().toUpperCase();
        const subtotal = Number(data.subtotal) || 0;
        const promos = restaurant.promoCodes || [];
        const match = promos.find(p => p.code === code);

        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ valid: false, message: 'Invalid promo coupon code' }));
          return;
        }

        if (subtotal < match.minOrder) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ valid: false, message: `Minimum order of ₹${match.minOrder} required for ${match.code}` }));
          return;
        }

        let discount = 0;
        if (match.type === 'percent') {
          discount = Math.round((subtotal * (match.value / 100)) * 100) / 100;
        } else {
          discount = Math.min(match.value, subtotal);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: true, code: match.code, discount, message: `${match.code} applied! ₹${discount} saved.` }));
      });
      return;
    }

    // 6. Submit Review: POST /api/reviews
    if (pathname.includes('/reviews') && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (err || !data.rating) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rating is required' }));
          return;
        }

        const newReview = {
          id: `rev-${Date.now().toString().slice(-4)}`,
          tableId: data.tableId || 1,
          customerName: data.customerName || 'Guest Diner',
          rating: parseInt(data.rating, 10) || 5,
          comment: data.comment || '',
          time: new Date().toISOString()
        };

        if (!restaurant.reviews) restaurant.reviews = [];
        restaurant.reviews.unshift(newReview);
        saveDb(db);
        broadcastEvent(restaurant.id, 'review:new', newReview);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, review: newReview }));
      });
      return;
    }

    // 6a. Create Payment Gateway Order: POST /api/create-payment-order
    if (pathname.includes('/create-payment-order') && req.method === 'POST') {
      readJsonBody((err, data) => {
        const orderId = data.orderId;
        let amount = Number(data.amount) || 0;
        let order = null;

        if (orderId) {
          order = restaurant.orders.find(o => o.id === orderId);
          if (order) amount = order.total;
        }

        if (amount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid amount is required' }));
          return;
        }

        const txnId = `TXN_${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
        const razorpayOrderId = `order_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
        const merchantVpa = restaurant.paymentConfig?.upiVpa || 'tiptap.merchant@icici';
        const merchantName = restaurant.paymentConfig?.merchantName || restaurant.name || 'TipTap Bistro';
        const tableLabel = order ? order.tableName : `Table ${data.tableId || 1}`;

        // Standard NPCI Dynamic UPI Intent URL
        const note = encodeURIComponent(`Bill ${tableLabel} ${txnId.slice(-6)}`);
        const upiIntent = `upi://pay?pa=${merchantVpa}&pn=${encodeURIComponent(merchantName)}&am=${amount.toFixed(2)}&tr=${txnId}&cu=INR&tn=${note}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          txnId,
          razorpayOrderId,
          amount,
          amountPaise: Math.round(amount * 100),
          merchantVpa,
          merchantName,
          tableLabel,
          upiIntent,
          currency: 'INR',
          keyId: restaurant.paymentConfig?.razorpayKeyId || 'rzp_test_TipTapPOS99',
          testMode: restaurant.paymentConfig?.testMode !== false
        }));
      });
      return;
    }

    // 6b. Verify Automatic Payment: POST /api/verify-payment
    if (pathname.includes('/verify-payment') && req.method === 'POST') {
      readJsonBody((err, data) => {
        const orderId = data.orderId;
        const txnId = data.txnId || `TXN_${Date.now()}`;
        const paymentMethod = data.paymentMethod || 'online_upi';
        const gatewayTxnId = data.gatewayTxnId || `RZP_${Date.now().toString(36).toUpperCase()}`;

        let order = restaurant.orders.find(o => o.id === orderId);
        
        if (!order && data.tableId) {
          const tId = parseInt(data.tableId, 10);
          order = restaurant.orders.find(o => o.tableId === tId);
        }

        if (!order) {
          const alreadyPaid = (restaurant.completedOrders || []).find(o => o.id === orderId || (data.tableId && o.tableId === parseInt(data.tableId, 10)));
          if (alreadyPaid) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              verified: true,
              orderId: alreadyPaid.id,
              txnId: alreadyPaid.txnId || txnId,
              tableName: alreadyPaid.tableName,
              amountPaid: alreadyPaid.total,
              paidAt: alreadyPaid.paidAt,
              message: `Payment already settled for ${alreadyPaid.tableName}`
            }));
            return;
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found or already settled' }));
          return;
        }

        const utr = (data.utr || '').toString().trim();
        const hasValidUtr = utr.length >= 6;
        const hasGatewayTxn = Boolean(data.razorpay_payment_id || (data.gatewayTxnId && !data.gatewayTxnId.startsWith('RZP_')));
        const isStaffSettlement = verifyStaffAuth(data, 'counter');

        if (!hasValidUtr && !hasGatewayTxn && !isStaffSettlement) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Valid 12-digit UPI UTR reference number or verified payment transaction required to confirm payment.'
          }));
          return;
        }

        order.isPaid = true;
        order.paymentStatus = 'paid';
        order.paymentMethod = paymentMethod;
        order.txnId = txnId;
        order.paidAt = new Date().toISOString();
        order.paymentDetails = {
          provider: hasGatewayTxn ? 'Razorpay Gateway' : (hasValidUtr ? 'UPI App (UTR Verified)' : 'POS Counter Settle'),
          txnId,
          gatewayTxnId,
          utr: hasValidUtr ? utr : null,
          verified: true,
          verifiedAt: new Date().toISOString()
        };

        // Update customer lifetime spend & loyalty coins immediately
        if (order.customerPhone && restaurant.customers) {
          const cust = restaurant.customers.find(c => c.phone === order.customerPhone);
          if (cust) {
            cust.totalSpent = (cust.totalSpent || 0) + order.total;
            cust.loyaltyPoints = (cust.loyaltyPoints || 0) + Math.floor(order.total / 10);
          }
        }

        // Check if food was already served to table by kitchen
        const isFoodServed = order.kitchenStatus === 'served' || order.status === 'served';

        if (isFoodServed) {
          // Food was already served AND now paid! Settle and archive to completedOrders
          order.status = 'completed';
          restaurant.completedOrders.push(JSON.parse(JSON.stringify(order)));
          restaurant.orders = restaurant.orders.filter(o => o.id !== order.id);

          // Table is done, set to cleaning
          const table = restaurant.tables.find(t => t.id === order.tableId);
          if (table) {
            table.status = 'cleaning';
            table.currentOrderId = null;
            table.seatingTime = null;
          }
        } else {
          // Food is STILL in kitchen queue or cooking!
          // DO NOT delete order from active orders or KDS! Keep order active with isPaid = true.
          // Table remains occupied so staff and chefs know which table this paid food belongs to!
          const table = restaurant.tables.find(t => t.id === order.tableId);
          if (table) {
            table.status = 'occupied';
            table.currentOrderId = order.id;
          }
        }

        saveDb(db);

        // Broadcast instant SSE real-time notifications to POS Counter & Kitchen
        broadcastEvent(restaurant.id, 'payment:success', {
          orderId: order.id,
          tableName: order.tableName,
          tableId: order.tableId,
          total: order.total,
          txnId,
          utr: data.utr || null,
          paymentMethod,
          paidAt: order.paidAt,
          isPaid: true,
          kitchenStatus: order.kitchenStatus || order.status
        });
        broadcastEvent(restaurant.id, 'order:update', order);
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          verified: true,
          orderId: order.id,
          txnId,
          tableName: order.tableName,
          amountPaid: order.total,
          paidAt: order.paidAt,
          isPaid: true,
          paymentStatus: 'paid',
          kitchenStatus: order.kitchenStatus || order.status,
          status: order.status,
          order: order,
          message: `Payment of ₹${order.total} verified successfully!`
        }));
      });
      return;
    }

    // 6c. Webhook Handler: POST /api/payment-webhook
    if (pathname.includes('/payment-webhook') && req.method === 'POST') {
      readJsonBody((err, data) => {
        console.log('Payment Webhook received:', data ? data.event : 'No event');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      return;
    }

    // 7. Place Order: POST /api/orders or POST /api/r/:id/orders
    if ((pathname === '/api/orders' || pathname === `/api/r/${targetRestId}/orders`) && req.method === 'POST') {
      if (restaurant.rushMode) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kitchen is currently experiencing high rush. Ordering is temporarily paused.' }));
        return;
      }

      readJsonBody((err, data) => {
        if (err || !data.items || !data.items.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid order data' }));
          return;
        }

        const newId = `ORD-${Date.now().toString().slice(-4)}`;
        const orderType = data.orderType || 'dinein'; // 'dinein' | 'takeaway' | 'delivery'
        const tableId = parseInt(data.tableId, 10) || 1;
        const targetTable = restaurant.tables.find(t => t.id === tableId) || { id: tableId, name: `Table ${tableId}` };

        let subtotal = 0;
        const items = data.items.map(cartItem => {
          const menuItem = restaurant.menu.find(m => m.id === cartItem.id);
          let unitPrice = menuItem ? menuItem.price : cartItem.price;

          if (cartItem.variant && menuItem && menuItem.variants) {
            const v = menuItem.variants.find(va => va.name === cartItem.variant);
            if (v) unitPrice = v.price;
          }

          let addonsTotal = 0;
          if (cartItem.addons && Array.isArray(cartItem.addons) && menuItem && menuItem.addons) {
            cartItem.addons.forEach(addName => {
              const matched = menuItem.addons.find(ad => ad.name === addName);
              if (matched) addonsTotal += matched.price;
            });
          }

          const lineTotal = (unitPrice + addonsTotal) * (cartItem.qty || 1);
          subtotal += lineTotal;

          return {
            id: cartItem.id,
            name: menuItem ? menuItem.name : cartItem.name,
            variant: cartItem.variant || '',
            price: unitPrice + addonsTotal,
            qty: cartItem.qty || 1,
            addons: cartItem.addons || [],
            itemTotal: lineTotal
          };
        });

        // Apply discount if promo
        const discount = Number(data.discount) || 0;
        const taxableSubtotal = Math.max(0, subtotal - discount);

        // Packaging charge for takeaway
        const packagingCharge = orderType === 'takeaway' ? 20 : 0;

        const gst = Math.round((taxableSubtotal * (restaurant.gstPercent / 100)) * 100) / 100;
        const total = taxableSubtotal + gst + packagingCharge;

        // Check if Table already has an active, unpaid dining session (Round 2+ Multi-Round KOT)
        if (orderType === 'dinein') {
          const activeOrder = restaurant.orders.find(o => 
            o.tableId === tableId && 
            !o.isPaid && 
            o.paymentStatus !== 'paid' && 
            o.status !== 'cancelled' && 
            o.status !== 'settled'
          );

          if (activeOrder) {
            // MULTI-ROUND TABLE RUNNING TAB
            if (!activeOrder.kots || !Array.isArray(activeOrder.kots)) {
              activeOrder.kots = [
                {
                  kotNumber: 1,
                  items: (activeOrder.items || []).map(it => ({ ...it, kotNumber: 1 })),
                  orderedAt: activeOrder.createdAt,
                  status: activeOrder.kitchenStatus || 'served'
                }
              ];
            }

            const kotNumber = activeOrder.kots.length + 1;
            const kotItems = items.map(it => ({ ...it, kotNumber }));

            const newKot = {
              kotNumber,
              items: kotItems,
              orderedAt: new Date().toISOString(),
              status: 'received'
            };
            activeOrder.kots.push(newKot);

            // Append items to consolidated items list
            kotItems.forEach(it => activeOrder.items.push(it));

            // Recalculate financial totals
            activeOrder.subtotal = (activeOrder.subtotal || 0) + subtotal;
            const curDiscount = Number(activeOrder.discount) || 0;
            const newTaxable = Math.max(0, activeOrder.subtotal - curDiscount);
            activeOrder.gst = Math.round((newTaxable * (restaurant.gstPercent / 100)) * 100) / 100;
            activeOrder.total = newTaxable + activeOrder.gst;
            activeOrder.kitchenStatus = 'received'; // chef has new items to cook
            activeOrder.status = 'received';
            activeOrder.updatedAt = new Date().toISOString();
            if (data.notes) {
              activeOrder.notes = activeOrder.notes 
                ? `${activeOrder.notes} | R${kotNumber}: ${data.notes}` 
                : `R${kotNumber}: ${data.notes}`;
            }

            saveDb(db);

            // Broadcast real-time notifications
            broadcastEvent(restaurant.id, 'order:kot', {
              orderId: activeOrder.id,
              tableId,
              tableName: targetTable.name,
              kot: newKot,
              order: activeOrder
            });
            broadcastEvent(restaurant.id, 'order:update', activeOrder);
            broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ...activeOrder,
              isMultiRound: true,
              currentKotNumber: kotNumber,
              newKot
            }));
            return;
          }
        }

        // New Session (Round 1 KOT)
        const initialKot = {
          kotNumber: 1,
          items: items.map(it => ({ ...it, kotNumber: 1 })),
          orderedAt: new Date().toISOString(),
          status: 'received'
        };

        const newOrder = {
          id: newId,
          orderType, // 'dinein' | 'takeaway' | 'delivery'
          tableId: orderType === 'dinein' ? tableId : null,
          tableName: orderType === 'dinein' ? targetTable.name : (orderType === 'takeaway' ? '🥡 Takeaway Pickup' : '🛵 Doorstep Delivery'),
          customerName: data.customerName || '',
          customerPhone: data.customerPhone || '',
          deliveryAddress: data.deliveryAddress || '',
          items: initialKot.items,
          kots: [initialKot],
          notes: data.notes || '',
          subtotal,
          discount,
          promoCode: data.promoCode || '',
          packagingCharge,
          gst,
          total,
          status: 'received',
          kitchenStatus: 'received',
          paymentStatus: 'unpaid',
          isPaid: false,
          paymentMethod: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        restaurant.orders.push(newOrder);

        // Track / update customer CRM
        if (data.customerPhone) {
          if (!restaurant.customers) restaurant.customers = [];
          const existingCust = restaurant.customers.find(c => c.phone === data.customerPhone);
          if (existingCust) {
            existingCust.visits += 1;
            existingCust.name = data.customerName || existingCust.name;
            existingCust.lastVisit = new Date().toISOString();
          } else {
            restaurant.customers.push({
              phone: data.customerPhone,
              name: data.customerName || 'Customer',
              visits: 1,
              totalSpent: 0,
              loyaltyPoints: 0,
              lastVisit: new Date().toISOString()
            });
          }
        }

        if (orderType === 'dinein') {
          const tableObj = restaurant.tables.find(t => t.id === tableId);
          if (tableObj) {
            tableObj.status = 'occupied';
            tableObj.currentOrderId = newId;
            if (!tableObj.seatingTime) tableObj.seatingTime = new Date().toISOString();
          }
        }

        saveDb(db);
        broadcastEvent(restaurant.id, 'order:new', newOrder);
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(newOrder));
      });
      return;
    }

    // 6. Update or Cancel Order: PATCH or DELETE /api/orders/:id
    const orderMatch = pathname.match(/\/(?:r\/[A-Za-z0-9_-]+\/)?orders\/([A-Za-z0-9-]+)$/);
    if (orderMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const orderId = orderMatch[1];

      if (req.method === 'DELETE') {
        if (!verifyStaffAuth(null, 'counter')) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Cashier / Manager PIN required to cancel order' }));
          return;
        }

        const order = restaurant.orders.find(o => o.id === orderId);
        if (!order) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
          return;
        }

        restaurant.orders = restaurant.orders.filter(o => o.id !== orderId);
        const table = (restaurant.tables || []).find(t => t.id === order.tableId);
        if (table) {
          table.status = 'free';
          table.currentOrderId = null;
          table.seatingTime = null;
        }

        saveDb(db);
        broadcastEvent(restaurant.id, 'order:update', { id: orderId, status: 'cancelled' });
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Order cancelled and table freed' }));
        return;
      }

      readJsonBody((err, data) => {
        // Enforce Role-Based Authorization on Order Updates:
        const isFinancialAction = Boolean(data.status === 'paid' || data.isPaid !== undefined || data.paymentStatus === 'paid' || data.closeTable === true);
        const isKitchenAction = Boolean(data.kitchenStatus || data.status === 'preparing' || data.status === 'ready' || data.status === 'served');

        if (isFinancialAction) {
          // Marking an order as paid or settling requires Counter PIN (or Master PIN)
          if (!verifyStaffAuth(data, 'counter')) {
            if (res.headersSent) return;
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Cashier / Manager PIN required to settle bill or mark order paid' }));
            return;
          }
        } else if (isKitchenAction) {
          // Updating kitchen cooking status requires at least Kitchen Passkey
          if (!verifyStaffAuth(data, 'any')) {
            if (res.headersSent) return;
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Staff Passkey required to update cooking status' }));
            return;
          }
        } else {
          // Any other order modification requires staff authentication
          if (!verifyStaffAuth(data, 'any')) {
            if (res.headersSent) return;
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Staff Passkey required to update order' }));
            return;
          }
        }

        const order = restaurant.orders.find(o => o.id === orderId);
        if (!order) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
          return;
        }

        if (data.status) {
          order.status = data.status;
          order.updatedAt = new Date().toISOString();
        }
        if (data.kitchenStatus) {
          order.kitchenStatus = data.kitchenStatus;
        }
        if (data.paymentMethod) order.paymentMethod = data.paymentMethod;
        if (data.isPaid !== undefined) order.isPaid = data.isPaid;
        if (data.paymentStatus) order.paymentStatus = data.paymentStatus;

        if (order.status === 'cancelled') {
          restaurant.orders = restaurant.orders.filter(o => o.id !== orderId);
          const table = (restaurant.tables || []).find(t => t.id === order.tableId);
          if (table) {
            table.status = 'free';
            table.currentOrderId = null;
            table.seatingTime = null;
          }
        } else if (order.status === 'served' || data.kitchenStatus === 'served') {
          order.kitchenStatus = 'served';
          order.status = 'served';

          // If the order was already paid online by customer
          if (order.isPaid || order.paymentStatus === 'paid') {
            // Food served AND bill is already paid! Complete and archive
            order.status = 'completed';
            restaurant.completedOrders.push(JSON.parse(JSON.stringify(order)));
            restaurant.orders = restaurant.orders.filter(o => o.id !== orderId);

            const table = restaurant.tables.find(t => t.id === order.tableId);
            if (table) {
              table.status = 'cleaning';
              table.currentOrderId = null;
              table.seatingTime = null;
            }
          } else {
            // Food served, but customer hasn't paid bill yet
            const table = restaurant.tables.find(t => t.id === order.tableId);
            if (table) {
              table.status = 'occupied';
              table.currentOrderId = order.id;
            }
          }
        } else if (order.status === 'paid' || data.status === 'paid') {
          order.isPaid = true;
          order.paymentStatus = 'paid';
          if (!order.paidAt) order.paidAt = new Date().toISOString();
          if (data.paymentMethod) order.paymentMethod = data.paymentMethod;

          // Check if food was already served OR if cashier explicitly closes table
          const isFoodServed = order.kitchenStatus === 'served';
          const shouldClose = data.closeTable === true || isFoodServed;

          if (shouldClose) {
            order.status = 'completed';
            restaurant.completedOrders.push(JSON.parse(JSON.stringify(order)));
            restaurant.orders = restaurant.orders.filter(o => o.id !== orderId);

            // Update customer lifetime spend & loyalty coins
            if (order.customerPhone && restaurant.customers) {
              const cust = restaurant.customers.find(c => c.phone === order.customerPhone);
              if (cust) {
                cust.totalSpent = (cust.totalSpent || 0) + order.total;
                cust.loyaltyPoints = (cust.loyaltyPoints || 0) + Math.floor(order.total / 10);
              }
            }

            const table = restaurant.tables.find(t => t.id === order.tableId);
            if (table) {
              table.status = 'cleaning';
              table.currentOrderId = null;
              table.seatingTime = null;
            }
          } else {
            // Cashier marked paid, but kitchen is still cooking! Keep active with isPaid = true.
            const table = restaurant.tables.find(t => t.id === order.tableId);
            if (table) {
              table.status = 'occupied';
              table.currentOrderId = order.id;
            }
          }
        } else if (order.status === 'preparing') {
          order.kitchenStatus = 'preparing';
          const table = restaurant.tables.find(t => t.id === order.tableId);
          if (table) {
            table.status = 'occupied';
            table.currentOrderId = order.id;
          }
        }

        saveDb(db);
        broadcastEvent(restaurant.id, 'order:update', order);
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, order }));
      });
      return;
    }

    // 7. Service Request (Call Waiter / Water): POST /api/service-request
    if (pathname.includes('/service-request') && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (err || !data.tableId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid data' }));
          return;
        }

        const tableId = parseInt(data.tableId, 10);
        const targetTable = restaurant.tables.find(t => t.id === tableId) || { name: `Table ${tableId}` };
        const reqObj = {
          id: `SR-${Date.now().toString().slice(-4)}`,
          tableId,
          tableName: targetTable.name,
          type: data.type || 'waiter',
          status: 'pending',
          time: new Date().toISOString()
        };

        restaurant.serviceRequests.unshift(reqObj);
        saveDb(db);
        broadcastEvent(restaurant.id, 'service:call', reqObj);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reqObj));
      });
      return;
    }

    // 8. Resolve Service Request: PATCH or DELETE /api/service-request/:id
    const srMatch = pathname.match(/service-request\/([A-Za-z0-9-]+)$/);
    if (srMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      if (!verifyStaffAuth(null, 'any')) {
        if (res.headersSent) return;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Staff Passkey required to resolve service call' }));
        return;
      }

      const srId = srMatch[1];
      restaurant.serviceRequests = (restaurant.serviceRequests || []).filter(s => s.id !== srId);
      saveDb(db);
      broadcastEvent(restaurant.id, 'service:resolved', { id: srId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: srId }));
      return;
    }

    // 9. Update Table Status: PATCH /api/tables/:id
    const tableMatch = pathname.match(/tables\/([0-9]+)$/);
    if (tableMatch && req.method === 'PATCH') {
      const tableId = parseInt(tableMatch[1], 10);
      readJsonBody((err, data) => {
        if (!verifyStaffAuth(data, 'counter')) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Cashier / Manager PIN required to update floor tables' }));
          return;
        }

        const table = restaurant.tables.find(t => t.id === tableId);
        if (!table) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Table not found' }));
          return;
        }

        if (data.status) table.status = data.status;
        if (data.reservedFor !== undefined) table.reservedFor = data.reservedFor;
        if (data.reservedTime !== undefined) table.reservedTime = data.reservedTime;
        saveDb(db);
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(table));
      });
      return;
    }

    // 9b. Transfer / Shift Table: POST /api/tables/transfer
    if (pathname.includes('/tables/transfer') && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (!verifyStaffAuth(data, 'counter')) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Cashier / Manager PIN required to transfer tables' }));
          return;
        }

        const fromTableId = parseInt(data.fromTableId, 10);
        const toTableId = parseInt(data.toTableId, 10);

        const fromTable = restaurant.tables.find(t => t.id === fromTableId);
        const toTable = restaurant.tables.find(t => t.id === toTableId);

        if (!fromTable || !toTable) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Source or destination table not found' }));
          return;
        }

        if (toTable.status === 'occupied') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `${toTable.name} is already occupied! Please select an available free table.` }));
          return;
        }

        // Find active order of fromTable
        const activeOrder = restaurant.orders.find(o => o.tableId === fromTableId && o.status !== 'paid');
        if (activeOrder) {
          activeOrder.tableId = toTableId;
          activeOrder.tableName = toTable.name;
          toTable.currentOrderId = activeOrder.id;
        }

        toTable.status = 'occupied';
        toTable.seatingTime = fromTable.seatingTime || new Date().toISOString();

        fromTable.status = 'cleaning';
        fromTable.currentOrderId = null;
        fromTable.seatingTime = null;

        saveDb(db);
        broadcastEvent(restaurant.id, 'table:update', restaurant.tables);
        if (activeOrder) broadcastEvent(restaurant.id, 'order:update', activeOrder);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, fromTable, toTable, order: activeOrder }));
      });
      return;
    }

    // 10. Add New Dish: POST /api/menu
    if (pathname.endsWith('/menu') && req.method === 'POST') {
      readJsonBody((err, data) => {
        if (!verifyStaffAuth(data, 'counter')) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Cashier PIN required to add dishes' }));
          return;
        }

        if (err || !data.name || !data.price) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid dish data' }));
          return;
        }

        const newDish = {
          id: `${restaurant.id}_m${Date.now()}`,
          name: data.name,
          category: data.category || 'Main Course',
          type: data.type || 'veg',
          isJain: Boolean(data.isJain),
          price: Number(data.price),
          description: data.description || '',
          inStock: true,
          variants: data.variants || [],
          addons: data.addons || []
        };

        restaurant.menu.push(newDish);
        saveDb(db);
        broadcastEvent(restaurant.id, 'menu:update', restaurant.menu);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(newDish));
      });
      return;
    }

    // 11. Toggle Item Stock / Edit: PATCH /api/menu/:id
    const menuMatch = pathname.match(/menu\/([A-Za-z0-9_-]+)$/);
    if (menuMatch && req.method === 'PATCH') {
      const dishId = menuMatch[1];
      readJsonBody((err, data) => {
        if (!verifyStaffAuth(data, 'any')) {
          if (res.headersSent) return;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Staff Passkey required to modify dish stock/price' }));
          return;
        }

        const dish = restaurant.menu.find(d => d.id === dishId);
        if (!dish) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Dish not found' }));
          return;
        }

        if (typeof data.inStock === 'boolean') dish.inStock = data.inStock;
        if (data.price) dish.price = Number(data.price);
        saveDb(db);
        broadcastEvent(restaurant.id, 'menu:update', restaurant.menu);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dish));
      });
      return;
    }

    // 12. Update Restaurant Settings: POST /api/settings
    if (pathname.endsWith('/settings') && req.method === 'POST') {
      readJsonBody((err, data) => {
        const session = authenticateRequest(req);
        if (session) {
          if (!checkCsrfForCookieAuth(req, res, session)) {
            return;
          }
          if (session.role === 'kitchen_staff') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Forbidden: Kitchen staff cannot modify restaurant settings" }));
            return;
          }
          if (session.role !== 'superadmin' && session.restaurantId !== restaurant.id) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Forbidden: Cannot modify another restaurant's settings" }));
            return;
          }
        } else {
          if (!verifyStaffAuth(data, 'counter')) {
            if (res.headersSent) return;
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Cashier / Manager PIN required to update settings' }));
            return;
          }
        }

        if (typeof data.rushMode === 'boolean') restaurant.rushMode = data.rushMode;
        if (data.name) restaurant.name = data.name;
        if (data.phone) restaurant.phone = data.phone;
        if (data.address) restaurant.address = data.address;
        if (data.pin) {
          restaurant.pin = hashPin(data.pin.toString().trim());
          invalidateRestaurantSessions(restaurant.id);
        }
        if (data.kitchenPin) {
          restaurant.kitchenPin = hashPin(data.kitchenPin.toString().trim());
          invalidateRestaurantSessions(restaurant.id);
        }
        if (data.paymentConfig) {
          restaurant.paymentConfig = {
            ...(restaurant.paymentConfig || {}),
            ...data.paymentConfig
          };
        }
        saveDb(db);
        const safeRestaurant = safeRestaurantForClient(restaurant);
        broadcastEvent(restaurant.id, 'settings:update', safeRestaurant);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(safeRestaurant));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API route not found' }));
    return;
  }

  // ----------------------------------------------------
  // STATIC FILE SERVING
  // ----------------------------------------------------
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found - TipTap</h1>');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

let currentPort = DEFAULT_PORT;
const candidatePorts = [DEFAULT_PORT, 3030, 5000, 8080, 8000, 3001];

function startServer(portIndex = 0) {
  if (portIndex >= candidatePorts.length) {
    console.error('No candidate ports available to bind.');
    return;
  }
  const port = candidatePorts[portIndex];

  server.once('error', (err) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} not available (${err.code}), trying next port...`);
      server.removeAllListeners('listening');
      startServer(portIndex + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    currentPort = port;
    const localIp = getLocalIpAddress();
    console.log(`\n======================================================`);
    console.log(`🚀 TipTap Multi-Restaurant SaaS Server Running!`);
    console.log(`📡 Local Computer   : http://localhost:${port}`);
    console.log(`📱 Same Wi-Fi/NFC   : http://${localIp}:${port}`);
    console.log(`👑 Super Admin SaaS : http://localhost:${port}/super-admin.html`);
    console.log(`💳 Billing POS Counter: http://localhost:${port}/dashboard.html`);
    console.log(`🍳 Kitchen KDS Station: http://localhost:${port}/kds.html`);
    console.log(`🍽️ Guest NFC Menu   : http://localhost:${port}/menu.html?table=1`);
    console.log(`💳 NFC Tools Cards  : http://localhost:${port}/nfc-manager.html`);
    console.log(`======================================================\n`);
  });
}

// Graceful Process Termination Handlers
function handleShutdown(signal) {
  console.log(`\n🛑 [TipTap Server] Received ${signal}. Gracefully closing connections...`);
  for (const client of sseClients) {
    try {
      client.res.write(`event: server_restarting\ndata: {"message":"Server is redeploying/restarting, reconnecting..."}\n\n`);
      client.res.end();
    } catch (e) {}
  }
  sseClients.clear();

  if (mongoClient) {
    mongoClient.close().catch(() => {});
  }

  server.close(() => {
    console.log('✅ [TipTap Server] HTTP server closed cleanly. Exiting.');
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 4000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

async function boot() {
  await initCloudDatabase();
  migrateAndSecureCredentials();
  startServer();
}

boot();
