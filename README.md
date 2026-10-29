# Story Desk 🎨📖🎙️

An installable, offline-capable Progressive Web App (PWA) designed for an 8-year-old child to draw pictures, write stories, and record voice narrations.

- **Zero dependencies**: Pure HTML, CSS, and vanilla JavaScript.
- **No external network calls**: No CDNs, no web fonts, no analytics, no trackers.
- **Privacy by design**: All stories, pictures, and voice recordings remain on the computer. Nothing is ever uploaded by the application.

---

## 1. Quick Local Setup & Testing

Because the app is a PWA that uses Service Workers and the File System Access API, it must be accessed over `localhost` or HTTPS.

You can serve this folder with any local web server:

```bash
# Using Python 3:
python3 -m http.server 8000

# Or using Node.js:
npx serve .
```

Open Google Chrome or Microsoft Edge and navigate to:
```
http://localhost:8000
```

---

## 2. Installing the PWA for Your Daughter

1. Open the app in **Chrome** or **Edge** on her laptop.
2. In the browser address bar, click the **Install** button (computer icon with down arrow) or go to the browser menu (**⋮**) → **Save and share** → **Install Story Desk**.
3. Story Desk will now appear as its own desktop app icon with a standalone window and will work completely offline even when disconnected from Wi-Fi.

---

## 3. How Story Storage Works

### Primary Mode: File System Access API
On first run (or when clicking **Save!**), the app asks to pick a directory on her computer (for example: `C:\Users\<Name>\Documents\My Stories` or `/home/<user>/Documents/Stories`).

- The browser securely remembers this directory handle inside IndexedDB.
- Each time she saves a story, it writes a dedicated subfolder formatted as:
  ```
  2026-10-28_dragon-adventure/
    ├── post.json          (Story title, date, text, and metadata)
    ├── drawing.png        (High-resolution drawing canvas output)
    ├── audio-1.webm       (Voice take 1 in Opus/WebM)
    └── audio-2.webm       (Optional extra voice takes)
  ```

### Fallback Mode (IndexedDB)
If the browser does not support the File System Access API, the app automatically persists all drawings, text, and voice recordings in IndexedDB using `navigator.storage.persist()`. Her work is completely safe, and you can export everything at any time via the **Export Everything as .ZIP** button in the Dad menu.

---

## 4. Parent Area & Dad Settings

Behind the **🔒 Dad** button in the top navigation bar lies the parent dashboard:
- **Passcode Gate**: Enter the secret word: `dad` (or `story`). You can modify this in `app.js` under `STATE.parentPasscode`.
- **Review Stories**: View her posts and toggle their status (**Draft Only** vs. **Published**).
- **Make Blog Site Files**: Generates a self-contained static site bundle containing all stories marked as "Published" and prompts a `.zip` download.

---

## 5. Deploying the Private Blog to Cloudflare Pages & Access

The Story Desk desk app is hosted on your GitHub Pages repo for installation, but the generated family blog is a separate, private site.

### Step A: Generate the Site Files
1. In Story Desk, click **🔒 Dad**, enter the secret word, and ensure the stories you want to share are marked **Published**.
2. Click **Make Blog Site Files**.
3. A file named `story-blog-site-YYYY-MM-DD.zip` will download. Extract this zip file into a folder on your computer.

### Step B: Deploy via Cloudflare Pages Direct Upload
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the sidebar, select **Compute (Workers & Pages)** → **Pages**.
3. Click **Create a project** → **Direct Upload**.
4. Set a Project Name (e.g., `family-story-desk`) and click **Create project**.
5. Drag and drop the extracted folder (containing `index.html`, `style.css`, and the story subfolders) into the Cloudflare upload box.
6. Click **Deploy site**. Your static blog is now live at `https://family-story-desk.pages.dev`.

### Step C: Restrict Access with Cloudflare Zero Trust (Email One-Time PIN)
To ensure only your family can read her blog:

1. In the Cloudflare Dashboard, navigate to **Zero Trust**.
2. Go to **Access** → **Applications** → click **Add an Application**.
3. Choose **Self-hosted**.
4. Configure application details:
   - **Application name**: `Family Story Desk`
   - **Application domain**: `family-story-desk.pages.dev` (or your custom domain)
5. Click **Next** to configure Policies:
   - **Policy Name**: `Family Access`
   - **Action**: `Allow`
   - **Configure rules**:
     - **Selector**: `Emails`
     - **Value**: Enter the email addresses of parents, grandparents, and family members.
6. Click **Next** → save the application.

Whenever anyone visits the site, Cloudflare will prompt for their email address and email them a single-use numeric code before granting access. The site remains 100% private.

