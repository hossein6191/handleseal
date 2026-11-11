// Vercel function: POST /api/sign
import { signRequest, errorResponse } from "../server/core.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    res.status(200).json(await signRequest(req.body?.signParams));
  } catch (err) {
    const { status, body } = errorResponse(err);
    res.status(status).json(body);
  }
}
