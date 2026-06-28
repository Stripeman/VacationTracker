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

function sameEmail(a, b) {
  a = String(a || "").toLowerCase().trim();
  b = String(b || "").toLowerCase().trim();
  return !!a && a === b;
}

// A trip is "mine" if I created it (owner id) OR my email is its ownerEmail (assigned).
function isMine(trip, me) {
  return !!(trip && ((trip.owner && trip.owner === me.id) || sameEmail(trip.ownerEmail, me.email)));
}

function canView(trip, me) {
  if (!trip || (!trip.owner && !trip.ownerEmail)) return true; // legacy / unassigned → visible to all
  if (isMine(trip, me)) return true;                // your own / assigned to you
  if (trip.visibility === "all") return true;       // shared with all users
  if (trip.visibility === "shared" && Array.isArray(trip.sharedWith)) {
    if (trip.sharedWith.map((s) => String(s).toLowerCase()).includes(me.email)) return true;
  }
  return false;
}

// Normal saves may only create/modify/delete trips the caller OWNS (by id or assigned
// email). Legacy/unassigned and other people's trips are never touched by a normal save
// (admins use ?mode=replace or ?mode=assign).
function canEdit(trip, me) {
  return isMine(trip, me);
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

    // Admin-only single/bulk owner assignment — used by the Trip Management tab. Sets
    // ownerEmail on the targeted trips in the STORED dataset (never touches other trips,
    // so it's safe even though the admin's own GET is filtered). Body:
    //   { ownerEmail, ids: [...] }  → assign those trip ids
    //   { ownerEmail }              → assign ALL currently-unassigned (no ownerEmail) trips
    if (mode === "assign") {
      if (!me.roles.includes("admin")) { json(403, { error: "Admin role required to assign owners." }); return; }
      const em = String(payload.ownerEmail || "").toLowerCase().trim();
      const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id != null ? [payload.id] : null);
      const stored = await readDataset(blob);
      let n = 0;
      const out = stored.locations.map((t) => {
        const target = ids ? ids.indexOf(t.id) !== -1 : !t.ownerEmail;
        if (target) { n++; return { ...t, ownerEmail: em }; }
        return t;
      });
      await writeDataset(blob, out, stored.settings);
      json(200, { ok: true, mode: "assign", assigned: n, ownerEmail: em });
      return;
    }

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
      const incoming = incomingById.get(s.id);
      if (s.owner || s.ownerEmail) {
        if (isMine(s, me)) {
          if (incoming) result.push(normalize(incoming, s.owner || me.id, s.ownerEmail || me.email));
          // omitted by an owner → deleted
        } else {
          result.push(s);                                  // someone else's — untouchable
        }
      } else {
        // legacy / unassigned
        if (incoming && isMine(incoming, me)) {
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
