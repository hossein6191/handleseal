// Vercel function: GET /api/x-profile?handle=name
export default async function handler(req, res) {
  let core;
  try {
    core = await import("../server/core.js");
  } catch (err) {
    console.error("Loading server/core.js failed:", err);
    return res.status(500).json({ error: `Server failed to start: ${err.message}` });
  }
  try {
    const profile = await core.getXProfile(req.query?.handle);
    // Let the CDN keep found profiles for 6 hours, misses for 5 minutes, to save API credits.
    res.setHeader("Cache-Control", profile.available ? "public, s-maxage=21600, stale-while-revalidate=86400" : "public, s-maxage=300");
    res.status(200).json(profile);
  } catch (err) {
    const { status, body } = core.errorResponse(err);
    res.status(status).json(body);
  }
}
