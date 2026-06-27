const { BlobServiceClient } = require("@azure/storage-blob");

// CUSTOM ROLES function (Azure Static Web Apps `rolesSource`).
//
// After ANY user signs in (Microsoft / Google / Yahoo / …), Azure SWA POSTs their
// identity here and expects back the list of roles to grant them. This is what lets
// the APP own access control instead of Azure portal invitations: we look the user's
// email up in an admin-managed allowlist (access-list.json in Blob Storage) and return
// the matching role. Unknown email → no roles → the app shows its "no access" message.
//
// App settings:
//   AZURE_STORAGE_CONNECTION_STRING  (required) — storage account holding the allowlist
//   BOOTSTRAP_ADMIN_EMAIL            (recommended) — comma-separated emails that ALWAYS
//                                     get admin, so you can never lock yourself out and
//                                     can seed the very first allowlist entry.
// Optional:
//   TRIPS_CONTAINER (default "data")   ACCESS_BLOB (default "access-list.json")

const CONTAINER = process.env.TRIPS_CONTAINER || "data";
const ACCESS_BLOB = process.env.ACCESS_BLOB || "access-list.json";

// Roles are cumulative: admin can do everything an editor/reader can, etc. The SWA
// route rules check for "reader"/"editor"/"admin", so we expand to the full set.
function rolesFor(role) {
  switch (String(role || "").toLowerCase()) {
    case "admin":  return ["admin", "editor", "reader"];
    case "editor": return ["editor", "reader"];
    case "reader": return ["reader"];
    default:       return [];
  }
}

async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readAccessList() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return [];
  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(CONTAINER);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(ACCESS_BLOB);
  if (!(await blob.exists())) return [];
  const dl = await blob.download();
  const text = await streamToString(dl.readableStreamBody);
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : (Array.isArray(data.list) ? data.list : []);
  } catch (e) { return []; }
}

module.exports = async function (context, req) {
  const email = String((req.body && req.body.userDetails) || "").toLowerCase().trim();
  const roles = new Set();

  // 1) bootstrap admin(s) — always granted, regardless of the allowlist
  const boot = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (email && boot.includes(email)) rolesFor("admin").forEach((r) => roles.add(r));

  // 2) the admin-managed allowlist
  try {
    const list = await readAccessList();
    const hit = list.find((e) => e && String(e.email || "").toLowerCase().trim() === email);
    if (hit) rolesFor(hit.role).forEach((r) => roles.add(r));
  } catch (e) {
    context.log.error(e);
  }

  context.res = {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: Array.from(roles) }),
  };
};
