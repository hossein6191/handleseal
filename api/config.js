// Vercel function: GET /api/config
import { getConfig, errorResponse } from "../server/core.js";

export default function handler(_req, res) {
  try {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).json(getConfig());
  } catch (err) {
    const { status, body } = errorResponse(err);
    res.status(status).json(body);
  }
}
