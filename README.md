# Story Desk 🎨📖🎙️

An installable, offline-capable Progressive Web App (PWA) designed for children to draw pictures, write stories, and record voice narrations.

- **Zero dependencies**: Pure HTML, CSS, and vanilla JavaScript. No build step or frameworks.
- **No external network calls**: No CDNs, no remote fonts, no analytics, no trackers.
- **Privacy by design**: All stories, pictures, and voice recordings remain on the computer. Nothing is ever uploaded by the application.
- **Multiple Kid Profiles**: Switch between children with a single click. Each child gets their own stories and blog space.
- **In-App "See My Blog"**: Children can preview their published stories and listen to recordings in a read-only viewer.
- **One-Click Publish & Deploy**: Dad can build the family static blog with one click and deploy to Cloudflare Pages protected by Zero Trust email PINs.

---

## 1. Quick Local Setup & Testing

Because the app is a PWA that uses Service Workers and the File System Access API, it must be accessed over `localhost` or HTTPS.

You can serve this repository with any local web server:

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

## 2. Installing the PWA on a Laptop

1. Open the app in **Google Chrome** or **Microsoft Edge** on your child's laptop.
2. In the browser address bar, click the **Install** button (computer icon with down arrow) or go to browser menu (**⋮**) → **Save and share** → **Install Story Desk**.
3. Story Desk will now appear as its own desktop app icon with a standalone window and will work completely offline even when disconnected from the internet.

---

## 3. Multiple Kid Profiles & "Who's Writing?"

Story Desk supports multiple young authors on the same computer:

- **"Who's writing?" Dropdown**: Visible in the top header. Switching children filters the story gallery and tags newly saved stories with that child's profile.
- **Dad Profiles Manager**: Open **🔒 Dad** settings (passcode: `dad`) to add new children (name, custom emoji, and theme color), rename children, or remove profiles.
- **Safe Story Retention**: Removing a profile **never** deletes stories; stories simply move to an unassigned state that Dad can reassign at any time.
- **Profile Storage**: Profiles are stored in `profiles.json` at the root of the chosen stories folder (or in IndexedDB in fallback mode), and the active profile is remembered across launches.

---

## 4. How Story Storage Works

### Primary Mode: File System Access API
On first run (or when clicking **Save!**), the app asks to pick a directory on your computer (for example: `C:\Users\<Name>\Documents\My Stories` or `/home/<user>/Documents/Stories`).

The browser securely remembers this directory handle inside IndexedDB. Stories are saved with the following structure:

```
Stories/
  ├── maya/
  │   └── 2026-10-28_dragon-adventure/
  │       ├── post.json          (Story title, author ID, date, text, and metadata)
  │       ├── drawing.png        (High-resolution drawing canvas output)
  │       ├── audio-1.webm       (Voice take 1 in Opus/WebM)
  │       └── audio-2.webm       (Optional extra voice takes)
  └── leo/
      └── 2026-10-29_space-rocket/
          ├── post.json
          ├── drawing.png
          └── audio-1.webm
site/                            (Generated family static blog)
profiles.json                    (Kid profiles list)
```

#### Backward Compatibility
Older stories saved without a kid subfolder or without an `author` field are read in place automatically. On first run, Dad can assign older stories to any profile with one click.

### Fallback Mode (IndexedDB)
If the browser does not support the File System Access API, the app automatically persists all drawings, text, and voice recordings in IndexedDB using `navigator.storage.persist()`. Her work is completely safe, and you can export everything at any time via the **Export Everything as .ZIP** button in the Dad menu.

---

## 5. Kid View: "See My Blog" 🌟

Next to "My Stories", children can click **🌟 See My Blog**:
- Opens a full-screen, read-only preview of her published stories with her name and emoji at the top.
- Displays stories newest first with drawing, text, and voice playback controls.
- Drafts stay in her normal story list; only stories approved by Dad appear here.
- 100% offline, zero network requests, read-only with a large "← Back to Desk" button.

---

## 6. One-Click Publish & Cloudflare Pages Deployment

Story Desk builds a completely static, lightweight family blog with zero external dependencies, responsive styles, and robots.txt disallowing search engines.

### Step 1: One-Time Cloudflare Setup

#### A. Create your Cloudflare Pages Project
1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com/).
2. In the sidebar, select **Compute (Workers & Pages)** → **Pages** → **Create a project** → **Direct Upload**.
3. Name your project (e.g. `family-story-desk`) and choose production branch `main`.

#### B. Protect with Cloudflare Zero Trust (Email PIN)
To ensure only family members can view your children's blog:
1. In Cloudflare, navigate to **Zero Trust** → **Access** → **Applications** → **Add an Application**.
2. Select **Self-hosted**.
3. Set Application Details:
   - **Application Name**: `Family Story Desk`
   - **Application Domain**: `family-story-desk.pages.dev`
   - **Add Additional Domain**: Add `*.family-story-desk.pages.dev` to protect preview domains.
4. Set Access Policy:
   - **Policy Name**: `Family Members`
   - **Action**: `Allow`
   - **Rule Selector**: `Emails`
   - **Value**: Enter the email addresses of parents, grandparents, and relatives.
5. Save. Visitors will receive a 6-digit one-time passcode by email before viewing.

#### C. Configure Local Deploy Script
In the `deploy/` folder of this repository:
1. Copy `deploy/deploy.config.example` to `deploy/deploy.config`:
   ```bash
   cp deploy/deploy.config.example deploy/deploy.config
   ```
2. Edit `deploy.config`:
   ```ini
   PROJECT_NAME="family-story-desk"
   SITE_DIR="/path/to/your/chosen/stories/folder/site"
   BRANCH="main"
   ```
3. Authenticate Wrangler once on your computer:
   ```bash
   npx wrangler login
   ```

---

### Step 2: Day-to-Day Publishing Workflow

1. In Story Desk, click **🔒 Dad** and enter passcode `dad`.
2. Review stories and mark the ones you want to share as **Published**.
3. Click **🚀 Publish Family Site**. Story Desk instantly generates the static site into `site/` inside your chosen folder (or downloads a `.zip` in fallback mode).
4. Deploy to the live site with one click:
   - **macOS**: Double-click `deploy/deploy.command` (or run `./deploy/deploy.sh`)
   - **Linux**: Run `./deploy/deploy.sh`
   - **Windows**: Double-click `deploy/deploy.bat`

The deploy script runs `npx wrangler pages deploy` against the `main` branch, updating your production blog without generating preview URLs, and outputs your live URL:
```
👉 https://family-story-desk.pages.dev
```
