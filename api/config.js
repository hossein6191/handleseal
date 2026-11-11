// Vercel function: GET /api/config
export default async function handler(_req, res) {
  let core;
  try {
    core = await import("../server/core.js");
  } catch (err) {
    console.error("Loading server/core.js failed:", err);
    return res.status(500).json({ error: `Server failed to start: ${err.message}` });
  }
  try {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(core.getConfig());
  } catch (err) {
    const { status, body } = core.errorResponse(err);
    res.status(status).json(body);
  }
}
