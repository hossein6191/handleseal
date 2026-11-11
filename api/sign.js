// Vercel function: POST /api/sign
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  let core;
  try {
    core = await import("../server/core.js");
  } catch (err) {
    console.error("Loading server/core.js failed:", err);
    return res.status(500).json({ error: `Server failed to start: ${err.message}` });
  }
  try {
    res.status(200).json(await core.signRequest(req.body?.signParams));
  } catch (err) {
    const { status, body } = core.errorResponse(err);
    res.status(status).json(body);
  }
}
