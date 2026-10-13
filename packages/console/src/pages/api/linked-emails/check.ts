import { client } from '../../../lib/auth';

const AUTH_SERVICE_URL = process.env.NEXT_PUBLIC_GC_AUTH_URL || 'https://auth.graffiticode.org';
const INTERNAL_API_KEY = process.env.AUTH_SERVICE_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || '';

// Pre-OTP availability check. Lets AddEmailDialog avoid sending a code (and
// burning a Privy session) for an email that's already linked elsewhere.
// Authenticated as the user via Firebase token so we can tell "your own
// already-linked email" apart from "linked to another account".
const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: { message: 'Unauthorized' } });

  let uid: string;
  try {
    const verified = await client.verifyToken(token);
    uid = verified.uid;
  } catch {
    return res.status(401).json({ error: { message: 'Invalid auth token' } });
  }

  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: { message: 'email required' } });
  }

  if (!INTERNAL_API_KEY) {
    return res.status(500).json({ error: { message: 'Internal API key not configured' } });
  }

  const url = `${AUTH_SERVICE_URL.replace(/\/$/, '')}/linked-emails/internal/lookup?email=${encodeURIComponent(email.trim())}`;
  const upstream = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-API-Key': INTERNAL_API_KEY },
  });
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: { message: 'Failed to check email' } });
  }
  const body = await upstream.json().catch(() => ({}));
  if (body?.status !== 'success') {
    return res.status(502).json({ error: { message: 'Upstream lookup failed' } });
  }
  if (!body.data?.matched) {
    return res.status(200).json({ status: 'success', data: { available: true } });
  }
  const ownedBy = body.data.uid === uid ? 'self' : 'other';
  return res.status(200).json({
    status: 'success',
    data: { available: false, ownedBy },
  });
};

export default handler;
