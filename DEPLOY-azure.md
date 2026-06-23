# Deploying Trip Tracker to Azure

This hosts the app **and** lets you update the data through the website itself, cheaply.

## Architecture (≈ $0–$1 / month)

- **Azure Static Web Apps (Free plan)** — serves the app, SSL + custom domain, includes a managed Functions API.
- **Azure Functions** (`/api/trips`) — `GET` reads the dataset, `POST` writes it (sign-in required).
- **Azure Blob Storage** — stores the live `trip-tracker.json` (a few cents/month).

The app defaults to **Cloud** mode and reads `/api/trips` on load; if the API isn't reachable (e.g. running locally with no backend) it falls back to browser storage / the bundled `demo-data.json`, so it still works offline. Users can switch to **Local** in ⚙ → Settings, and that choice is remembered.

## Files in this repo that matter

```
index.html               → redirects the site root to the app
Trip Tracker.dc.html     → the app
support.js               → runtime
demo-data.json           → bundled demo data (first-run fallback)
staticwebapp.config.json → routes + role-gated API (GET needs `reader`/`editor`; writes need `editor`; built-in auth, Free plan)
api/                      → the Functions API
  host.json
  package.json
  trips/function.json
  trips/index.js
```

## One-time setup

1. **Storage account** (cheapest: StorageV2, LRS):
   ```
   az group create -n trip-tracker -l eastus
   az storage account create -n triptrackerdata -g trip-tracker --sku Standard_LRS
   az storage account show-connection-string -n triptrackerdata -g trip-tracker -o tsv
   ```
   Copy that connection string.

2. **Deploy the Static Web App** — easiest via the Azure Portal → *Create Static Web App* → connect this GitHub repo. Set:
   - **App location**: `/`
   - **Api location**: `api`
   - **Output location**: *(blank)*
   (A GitHub Action is added to your repo and deploys on every push.)

3. **Add the storage connection string** to the Static Web App:
   Portal → your Static Web App → **Environment variables** (or **Configuration**) → add
   `AZURE_STORAGE_CONNECTION_STRING` = *(the value from step 1)*.
   Optional: `TRIPS_CONTAINER` (default `data`), `TRIPS_BLOB` (default `trip-tracker.json`).

4. **Sign-in — built-in provider (no app registration, no Standard plan needed).** Azure Static Web Apps ships with **pre-configured auth providers**, so you don't register your own Entra app, create a client secret, or edit `staticwebapp.config.json` — and it all works on the **Free** plan.
   - The config already protects the API by **role** (`allowedRoles` in `staticwebapp.config.json`); there is intentionally **no `auth` block**. The built-in **Microsoft / Azure AD** provider is live at `/.auth/login/aad` out of the box, and the app's **Sign in** link points there. (GitHub at `/.auth/login/github` is also available if you prefer.)
   - Anyone can technically *sign in* with the shared provider, but **access is granted only by the roles you assign** (step 5). A signed-in account with no role can't read or write — it sees the in-app *No access — contact the author* message. So you control access purely by who you invite.
   - *Optional (not required):* to restrict sign-in to **your own Entra tenant** or use a branded app registration, that's the custom-auth path — it needs the **Standard** plan plus an `auth` block with your `openIdIssuer`, `AAD_CLIENT_ID`, and `AAD_CLIENT_SECRET`. Skip it unless you specifically need tenant-locked sign-in.

5. **Grant access (roles).** Three custom roles: **`reader`** (view), **`editor`** (view + add/edit/delete), and **`admin`** (editor + import & clear data).
   - Azure Portal → your Static Web App → **Role management** → **Invite** → enter the user, pick the provider (e.g. Azure AD), assign `reader`, `editor`, and/or `admin` → generate the invite link and send it. The user opens it, signs in, and accepts.
   - The API enforces read/write: `GET /api/trips` requires `reader` or `editor`; `POST/PUT` requires `editor`. The **Import** and **Clear data** controls are additionally hidden in the UI unless the account has `admin`.
   - Roles are baked into the session at sign-in — after assigning/changing a role, the user must **sign out and back in** for it to take effect.

## Troubleshooting — "Not connected" / app shows Browser storage on the live site

If the deployed site stays on **Browser storage** and ⚙ → System → CLOUD SYNC shows **"Not connected"** with a diagnostic like **`HTTP 404 from /api/trips`**, the Functions API isn't deployed. The cause is almost always the **GitHub Actions workflow has a blank `api_location`** — the deploy log shows:

```
No Api directory specified. Azure Functions will not be created.
```

Fix it in the workflow file (one line):

1. In your repo, open `.github/workflows/azure-static-web-apps-*.yml`.
2. Find the `Azure/static-web-apps-deploy` step's `with:` block and set:
   ```yaml
   app_location: "/"
   api_location: "api"      # ← was "" — this is what was missing
   output_location: ""
   ```
3. Commit + push. The Action redeploys; watch the log for **"Found Api directory"** / a Functions build (it runs `npm install` in `api/`).
4. Reload the site → ⚙ → System → **Retry connection**. The diagnostic should clear; an anon visitor now gets a 401 → the **Sign in** prompt instead of "Not connected".

Other diagnostics and what they mean:
- **`HTTP 404 from /api/trips`** — API not deployed (the `api_location` fix above), or `staticwebapp.config.json` not deployed.
- **`HTTP 500`** — API deployed but `AZURE_STORAGE_CONNECTION_STRING` is missing/wrong (set it in Static Web App → Environment variables, then it works without redeploy).
- **`Could not reach /api/trips` / network error** — you're opening the file directly (not through the SWA host) or offline; this is expected in Local mode.

## How data flows once deployed

- The **page always loads** (not gated). In **Cloud** mode, an unauthorized visitor sees a clean *No access / Sign in* message — never your data.
- **Roles:** `reader` can view; `editor` can view and save. A signed-in account with neither role gets the “contact the author for access” message.
- An editor's change `POST`s the full dataset to the blob (creating it on first save). The bundled `demo-data.json` / `trip-tracker.json` are only used in **Local** mode — they never expose cloud data.

## Protecting the data (blob versioning + soft delete)

The app writes the **whole dataset** on every save, so a bad client state could in theory overwrite good data. The app guards against this (it never pushes to the cloud before it has read the cloud, and asks before seeding an empty cloud), but you should **also** enable storage-side safety nets so any overwrite is recoverable:

1. **Enable blob versioning + soft delete** (one-time, on the storage account):
   ```
   az storage account blob-service-properties update \
     -n triptrackerdata -g trip-tracker \
     --enable-versioning true \
     --enable-delete-retention true --delete-retention-days 30 \
     --enable-container-delete-retention true --container-delete-retention-days 30
   ```
   Or in the Portal: **Storage account → Data protection** → tick **Enable versioning for blobs**, **Enable soft delete for blobs** (e.g. 30 days), and **Enable soft delete for containers**.

2. **What this buys you:** every save keeps the previous blob as an immutable **version**. If `trip-tracker.json` ever gets clobbered, you can roll back instead of losing data. Cost is negligible at this size (a few KB per version).

3. **Restore a previous version:**
   - Portal → **Storage account → Containers → `data` → `trip-tracker.json` → Versions** tab. Pick a timestamp from *before* the bad save → **…** → **Restore** (promotes it to current). Or **Download** that version, then in the app (signed in as `editor`/`admin`) use **⚙ → Import → Data** to push it back to the cloud.
   - CLI:
     ```
     az storage blob list --account-name triptrackerdata -c data --prefix trip-tracker.json --include v -o table
     az storage blob copy start --account-name triptrackerdata \
       --destination-container data --destination-blob trip-tracker.json \
       --source-uri "https://triptrackerdata.blob.core.windows.net/data/trip-tracker.json?versionId=<VERSION_ID>"
     ```

4. **Belt and braces:** the app still auto-downloads a dated JSON **backup** before any *Clear data*, and **⚙ → Export** gives you a manual snapshot anytime.

## Local development

Run with the [SWA CLI](https://aka.ms/swa-cli) to emulate the API + auth locally:
```
npm i -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa start . --api-location api
```
Without it, plain Live Server works too — the app just stays in local mode.
