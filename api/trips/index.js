const { BlobServiceClient } = require("@azure/storage-blob");

// Reads/writes the Trip Tracker dataset to Blob Storage, with PER-USER access control.
//
// Each trip may carry:
//   owner       — stable user id of the creator (Azure clientPrincipal.userId)
//   ownerEmail  — creator's email, for display
//   visibility  — "private" (owner only) | "shared" (specific people) | "all" (any signed-in user)
//   sharedWith  — array of emails the owner shared a "shared" trip with
// Trips with no `owner` are LEGACY (created before access control) and are treated as
// visible to everyone but editable by no one via normal saves (admins manage them via Import).
//
// App settings required on the Static Web App / Function:
//   AZURE_STORAGE_CONNECTION_STRING  — connection string of your storage account
// Optional:
//   TRIPS_CONTAINER (default "data")  TRIPS_BLOB (default "trip-tracker.json")

const CONTAINER = process.env.TRIPS_CONTAINER || "data";
const BLOB = process.env.TRIPS_BLOB || "trip-tracker.json";

function principal(req) {
  const header = req.headers["x-ms-client-principal"];
  if (!header) return null;
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return {
      id: p.userId || "",
      email: (p.userDetails || "").toLowerCase(),
      roles: p.userRoles || [],
    };
  } catch (e) {
    return null;
  }
}

function canView(trip, me) {
  if (!trip || !trip.owner) return true;            // legacy / unowned → visible to all
  if (trip.owner === me.id) return true;            // your own
  if (trip.visibility === "all") return true;       // shared with all users
  if (trip.visibility === "shared" && Array.isArray(trip.sharedWith)) {
    if (trip.sharedWith.map((s) => String(s).toLowerCase()).includes(me.email)) return true;
  }
  return false;
}

// Normal saves may only create/modify/delete trips the caller OWNS. Legacy (unowned)
// and other people's trips are never touched by a normal save (admins use ?mode=replace).
function canEdit(trip, me) {
  return !!(trip && trip.owner && trip.owner === me.id);
}

async function getContainer() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(CONTAINER);
  await container.createIfNotExists();
  return container;
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readDataset(blob) {
  if (!(await blob.exists())) return { locations: [], settings: null };
  const dl = await blob.download();
  const text = await streamToString(dl.readableStreamBody);
  let data;
  try { data = JSON.parse(text); } catch (e) { return { locations: [], settings: null }; }
  if (Array.isArray(data)) return { locations: data, settings: null };
  return { locations: Array.isArray(data.locations) ? data.locations : [], settings: data.settings || null };
}

async function writeDataset(blob, locations, settings) {
  const payload = { app: "vacation-location", version: 1, locations };
  if (settings) payload.settings = settings;
  const text = JSON.stringify(payload, null, 2);
  await blob.upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

module.exports = async function (context, req) {
  const json = (status, body) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  };

  try {
    const me = principal(req);
    // The SWA routes already require a role, so a principal should always be present.
    if (!me) { json(401, { error: "Sign in required." }); return; }

    const container = await getContainer();
    const blob = container.getBlockBlobClient(BLOB);

    if (req.method === "GET") {
      const { locations, settings } = await readDataset(blob);
      const visible = locations.filter((t) => canView(t, me));
      json(200, {
        app: "vacation-location",
        version: 1,
        locations: visible,
        settings: settings || undefined,
        me: { id: me.id, email: me.email, roles: me.roles },
        total: locations.length,
        visible: visible.length,
      });
      return;
    }

    // ---- writes ----
    let payload = req.body;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch (e) { json(400, { error: "Invalid JSON" }); return; } }
    if (!payload || !Array.isArray(payload.locations)) { json(400, { error: "Expected { locations: [...] }" }); return; }

    const mode = (req.query && req.query.mode) || "";

    // Admin-only full replace — used by Import and Clear data.
    if (mode === "replace") {
      if (!me.roles.includes("admin")) { json(403, { error: "Admin role required to replace all data." }); return; }
      await writeDataset(blob, payload.locations, payload.settings || null);
      json(200, { ok: true, mode: "replace", count: payload.locations.length });
      return;
    }

    // Normal save: reconcile the caller's working set against stored data so a user
    // can only ever add/change/delete trips they OWN. Everything else is preserved.
    const stored = await readDataset(blob);
    const storedById = new Map(stored.locations.map((t) => [t.id, t]));
    const result = [];

    // Reconcile the caller's working set against stored data:
    //  - trips they OWN  → updated from payload (or deleted if omitted)
    //  - other people's  → always kept untouched
    //  - LEGACY (no owner): if the payload version carries owner==me.id the caller is
    //    CLAIMING + editing it (stamp owner/ownerEmail, save all props); otherwise keep
    //    the stored copy unchanged (legacy trips are never auto-dropped by a normal save).
    const incomingById = new Map(payload.locations.map((t) => [t.id, t]));

    const normalize = (t, owner, ownerEmail) => {
      let visibility = t.visibility;
      if (["private", "shared", "all"].indexOf(visibility) === -1) visibility = "private";
      const sharedWith = Array.isArray(t.sharedWith)
        ? t.sharedWith.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
        : [];
      return { ...t, owner, ownerEmail, visibility, sharedWith };
    };

    for (const s of stored.locations) {
      const sOwner = s.owner || null;
      const incoming = incomingById.get(s.id);
      if (sOwner && sOwner !== me.id) {
        result.push(s);                                   // someone else's — untouchable
      } else if (sOwner === me.id) {
        if (incoming) result.push(normalize(incoming, me.id, s.ownerEmail || me.email));
        // omitted by an owner → deleted
      } else {
        // legacy / unowned
        if (incoming && incoming.owner === me.id) {
          result.push(normalize(incoming, me.id, me.email)); // claim + edit
        } else {
          result.push(s);                                  // keep legacy as-is
        }
      }
    }
    // brand-new trips the caller created this session
    for (const t of payload.locations) {
      if (storedById.has(t.id)) continue;
      result.push(normalize(t, t.owner || me.id, t.ownerEmail || me.email));
    }

    const settings = payload.settings || stored.settings || null;
    await writeDataset(blob, result, settings);
    json(200, { ok: true, count: result.length });
  } catch (err) {
    context.log.error(err);
    json(500, { error: String((err && err.message) || err) });
  }
};
