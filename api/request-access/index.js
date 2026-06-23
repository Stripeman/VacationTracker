// Sends an access-request email via Resend when a visitor without access
// submits their email on the Trip Tracker sign-in screen.
//
// Required app settings (Static Web App → Settings → Environment variables):
//   RESEND_API_KEY     — your Resend API key (starts with "re_")
//   RESEND_FROM        — a VERIFIED Resend sender, e.g. "Trip Tracker <noreply@yourdomain.com>"
//   ACCESS_REQUEST_TO  — where requests are delivered (your email address)
//
// The recipient is taken ONLY from ACCESS_REQUEST_TO on the server — never from
// the request body — so this endpoint cannot be abused as an open mail relay.

module.exports = async function (context, req) {
  const json = (status, body) => {
    context.res = {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  };

  if (req.method !== "POST") { json(405, { error: "Use POST" }); return; }

  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.ACCESS_REQUEST_TO;
  // 501 → the client knows to fall back to a mailto: link.
  if (!key || !from || !to) { json(501, { error: "Email sending is not configured on the server." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const requester = (body && typeof body.email === "string" ? body.email : "").trim().slice(0, 200);
  const note = (body && typeof body.message === "string" ? body.message : "").trim().slice(0, 2000);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requester)) { json(400, { error: "A valid email is required." }); return; }

  const subject = "Trip Tracker — access request from " + requester;
  const text =
    "A visitor requested access to Trip Tracker.\n\n" +
    "Email: " + requester + "\n" +
    (note ? ("Message:\n" + note + "\n\n") : "\n") +
    "To grant access, add this address as a reader (view) or editor (edit) role in your identity provider.";

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], reply_to: requester, subject, text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      context.log.error("Resend error", r.status, detail);
      json(502, { error: "Email service rejected the request." });
      return;
    }
    json(200, { ok: true });
  } catch (err) {
    context.log.error(err);
    json(500, { error: String((err && err.message) || err) });
  }
};
