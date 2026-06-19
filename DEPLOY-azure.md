# Deploying Trip Tracker to Azure

This hosts the app **and** lets you update the data through the website itself, cheaply.

## Architecture (≈ $0–$1 / month)

- **Azure Static Web Apps (Free plan)** — serves the app, SSL + custom domain, includes a managed Functions API.
- **Azure Functions** (`/api/trips`) — `GET` reads the dataset, `POST` writes it (sign-in required).
- **Azure Blob Storage** — stores the live `trip-tracker.json` (a few cents/month).

The app auto-detects the API: when `/api/trips` responds it runs in **Cloud** mode (and shows cloud controls in ⚙ → Settings); otherwise it falls back to browser storage / the bundled `trip-tracker.json`, so it still works locally with no backend.

## Files in this repo that matter

```
index.html               → redirects the site root to the app
Trip Tracker.dc.html     → the app
support.js               → runtime
trip-tracker.json        → bundled demo data (fallback / first-run)
staticwebapp.config.json → routes + Entra auth (GET & write both require sign-in; writes require the `editor` role; needs the Standard plan)
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

4. **Microsoft Entra sign-in (Standard plan required).** Both reading and writing require a signed-in user; writing also requires the **`editor`** role.
   a. **Upgrade the Static Web App to Standard** (Portal → Static Web App → *Hosting plan* → Standard) — custom Entra auth is not available on Free.
   b. **Register an Entra app:** Azure Portal → *Microsoft Entra ID* → **App registrations** → **New registration**. Redirect URI (Web): `https://<your-swa-host>/.auth/login/aad/callback`. Note the **Application (client) ID** and **Directory (tenant) ID**.
   c. **Client secret:** that app registration → *Certificates & secrets* → **New client secret** → copy the **Value**.
   d. **Add app settings** to the Static Web App (Environment variables): `AAD_CLIENT_ID` = client ID, `AAD_CLIENT_SECRET` = secret value.
   e. **Set your tenant** in `staticwebapp.config.json`: replace `<TENANT_ID>` in the `openIdIssuer` URL with your Directory (tenant) ID, then commit.
   The app's **Sign in** link points to `/.auth/login/aad`.

5. **Grant access (roles).** Three custom roles: **`reader`** (view), **`editor`** (view + add/edit/delete), and **`admin`** (editor + import & clear data).
   - Azure Portal → your Static Web App → **Role management** → **Invite** → enter the user, assign `reader`, `editor`, and/or `admin` → send the invite link and have them accept.
   - The API enforces read/write: `GET /api/trips` requires `reader` or `editor`; `POST/PUT` requires `editor`. The **Import** and **Clear data** controls are additionally hidden in the UI unless the account has `admin`.

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
