# TipTap - Smart NFC Restaurant Ordering & Management System 🚀

**TipTap** is a modern, real-time, NFC-first restaurant POS and contactless table ordering platform (inspired by BlinkRest, customized with NFC-first technology and a sky-blue brand theme).

---

## 🌟 Key Features Built

### 1. 📱 Guest Contactless NFC Table Menu (`/menu.html?table=1`)
- **Zero App Download**: Guests touch their phone to the table's NFC card. The menu opens instantly in Safari or Chrome.
- **Auto Table Detection**: Pre-selects table (`?table=1`, `?table=2`, etc.).
- **Smart Dietary Filters**: Veg Only, Non-Veg, and Jain-friendly toggles.
- **Portion Variants & Add-ons**: Half/Full sizing with live price calculation.
- **Cooking Instructions**: Free-form text for special chef requests ("Less spicy, no onion").
- **Real-Time Live Order Tracker**:
  - 📝 Order Received
  - 🍳 Chef is Preparing
  - 🍽️ Order is Ready / Served
  - 💳 Settle via UPI QR at table
- **Direct Table Assistance**: "Call Waiter" and "Request Water" buttons right on customer's phone!

---

### 2. 🍳 Kitchen Display System (KDS / KOT)
- **Audio Chime**: Live audio chime (synthesized via Web Audio API) plays as soon as a guest sends an order ticket.
- **Color-Coded Late Warnings**:
  - Fresh order: Green/Clean border
  - > 8 mins: Yellow warning
  - > 15 mins: Red flashing "LATE" ticket
- **1-Click Actions**: "Start Cooking" ➔ "Mark Ready for Service".

---

### 3. 🛎️ Waiter Station View
- **Table Call Notifications**: Instantly alerts waiter when a table calls for assistance or drinking water.
- **Ready Food Pickup**: Displays ready-to-serve orders waiting at the kitchen counter with 1-click "Mark Served".

---

### 4. 💰 Cashier / POS & Interactive Floor Tables View
- **Live Floor Occupancy (T1 - T8)**:
  - 🟢 Free (Table available)
  - 🟠 Occupied (Live running bill total + seating timer)
  - 🔵 Cleaning (Table needs wipe-down)
- **5% GST Tax Invoicing**: Calculates Subtotal, CGST 2.5%, SGST 2.5%, and Grand Total.
- **Payment Split Ledger**: UPI / QR, Cash, and Card breakdown.
- **Print Thermal Bill**: Formatted for standard 80mm thermal receipt printers (`window.print()`).
- **Send Bill on WhatsApp**: 1-click pre-filled WhatsApp link with receipt breakdown to the customer's phone!

---

### 5. 👑 Owner Business Analytics & Stock Manager
- **Today's Live Sales Dashboard**: Real-time revenue counter, order count, and average order value.
- **Top-Selling Dishes**: Ranked by order frequency.
- **Instant Sold Out Switch**: Toggle any dish out of stock in 1 click; it immediately greys out on all customer phone menus.
- **Rush Hour Toggle**: One-click pause on new orders with a courteous banner ("Kitchen is busy, please wait 10 mins").
- **Day-End Tally / CSV Export**: Download complete sales ledger in `.csv` format.

---

### 6. 💳 NFC Card Programmer & Table Stands (`/nfc-manager.html`)
- **Printable Table Tent Cards**: Sky-blue acrylic cards featuring:
  - Big NFC Tap Circle ("TAP PHONE HERE")
  - Fallback camera QR code for older devices
  - Unique Table Number badge
- **NFC Programming Guide**:
  1. Download free **NFC Tools** app on Android or iPhone.
  2. Select **Write** ➔ **Add a record** ➔ **URL / URI**.
  3. Copy and paste the table link (e.g. `http://<your-ip>:3030/menu.html?table=1`).
  4. Touch blank NTAG213 / NTAG215 card to the back of phone to write!

---

## 🚀 How to Run TipTap

### Option 1: Double Click (Windows)
Double click `start-tiptap.bat` in this folder.

### Option 2: Command Line
```powershell
cd "C:\Users\pawan kumar\.gemini\antigravity\scratch\tiptap"
node server.js
```

### URLs to Open:
- **Landing Page**: [http://localhost:3030](http://localhost:3030)
- **Guest NFC Menu (Demo Table 2)**: [http://localhost:3030/menu.html?table=2](http://localhost:3030/menu.html?table=2)
- **Staff Dashboard & POS**: [http://localhost:3030/dashboard.html](http://localhost:3030/dashboard.html)
- **NFC Card & Print Manager**: [http://localhost:3030/nfc-manager.html](http://localhost:3030/nfc-manager.html)

---

## 🛠️ Tech Stack
- **Backend**: Native Node.js HTTP + Server-Sent Events (SSE) (Zero npm dependencies needed!)
- **Database**: Local JSON store with automatic persistence in `data/tiptap-db.json`
- **Frontend**: Vanilla JS + Tailwind CSS (Sky-blue SaaS theme)
- **Real-Time Engine**: SSE EventSource for <10ms multi-device synchronization
