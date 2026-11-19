# 🚀 TipTap - Free Cloud Deployment & Custom Domain Guide

Your TipTap project is 100% self-contained with **zero npm dependencies**, which means it deploys instantly on any cloud platform with zero build errors!

---

## Option 1: Free Deployment on Render.com (Recommended - 2 Minutes)

1. **Push your project to GitHub**:
   - Create a free GitHub account (if you don't have one).
   - Create a new repository: `tiptap`.
   - Push your folder `C:\Users\pawan kumar\.gemini\antigravity\scratch\tiptap` to GitHub.

2. **Open Render.com**:
   - Go to [render.com](https://render.com) and sign up for free (using your GitHub account).
   - Click **"New +"** ➔ **"Web Service"**.
   - Select your `tiptap` repository.

3. **Configure Settings**:
   - **Environment**: `Node`
   - **Build Command**: Leave empty or `echo "Ready"`
   - **Start Command**: `node server.js`
   - **Plan**: `Free`
   - Click **"Create Web Service"**.

4. **Live URL**:
   - In 60 seconds, Render will give you a live URL like `https://tiptap-xxxx.onrender.com`.
   - Anyone in the world can now open your menus and staff dashboard!

---

## Option 2: Connecting Your Custom Domain (e.g., `tiptap.in`)

1. Buy your domain on Hostinger, GoDaddy, or Namecheap (e.g. `tiptap.in` costs ~₹499/year).
2. In Render dashboard ➔ **Settings** ➔ **Custom Domains** ➔ Click **"Add Custom Domain"**.
3. Type `tiptap.in` and `www.tiptap.in`.
4. Copy the DNS CNAME records provided by Render and paste them into your domain DNS manager (e.g., Hostinger DNS).
5. Render automatically issues a free **SSL Certificate (HTTPS / Green Padlock)**!

---

## 💳 Writing Live URLs to Physical NFC Cards

Once your domain is live (e.g. `https://tiptap.in`):

1. Open free **NFC Tools** app on your phone.
2. Select **Write** ➔ **Add a record** ➔ **URL / URI**.
3. Paste:
   - For Table 1: `https://tiptap.in/menu.html?restaurant=tiptap-bistro&table=1`
   - For Table 2: `https://tiptap.in/menu.html?restaurant=tiptap-bistro&table=2`
4. Tap your phone to the blank NTAG213/215 acrylic card.
5. Place the card on Table 1. Whenever guests tap, your live menu opens instantly!
