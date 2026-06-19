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
staticwebapp.config.json → routes + auth (GET public, POST authenticated)
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

4. **Identity provider for sign-in** — `staticwebapp.config.json` gates writes to the `authenticated` role. The app's **Sign in** link uses GitHub (`/.auth/login/github`); change it to Entra ID (`/.auth/login/aad`) in the app if you prefer. Static Web Apps provides these endpoints automatically.

## How data flows once deployed

- First load: the API has no blob yet → the app shows the bundled `trip-tracker.json`.
- You **Sign in** (⚙ → Settings → Cloud) and make any change → it `POST`s the full dataset, creating/updating the blob.
- Everyone else sees the cloud data read-only; only signed-in users can save.

## Local development

Run with the [SWA CLI](https://aka.ms/swa-cli) to emulate the API + auth locally:
```
npm i -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa start . --api-location api
```
Without it, plain Live Server works too — the app just stays in local mode.
