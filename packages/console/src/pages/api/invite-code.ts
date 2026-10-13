import { getFirestore } from '../../utils/db';
import { client } from '../../lib/auth';

// Default invite codes
const DEFAULT_INVITE_CODES = [
  'WELCOME2025',
  'EARLY_ACCESS',
  'BETA_USER',
];

// Get invite codes from environment variable or use defaults
const getValidInviteCodes = () => {
  const envCodes = process.env.VALID_INVITE_CODES;
  if (envCodes) {
    // Parse comma-separated list of codes from environment variable
    // Convert to uppercase for case-insensitive comparison
    return new Set(envCodes.split(',').map(code => code.trim().toUpperCase()));
  }
  // Convert default codes to uppercase for case-insensitive comparison
  return new Set(DEFAULT_INVITE_CODES.map(code => code.toUpperCase()));
};

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { inviteCode } = req.body;
    const token = req.headers.authorization;

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { uid } = await client.verifyToken(token);

    if (!inviteCode) {
      return res.status(400).json({ error: 'Invite code is required' });
    }

    // Check if invite code is valid (case-insensitive)
    const validInviteCodes = getValidInviteCodes();
    if (!validInviteCodes.has(inviteCode.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid invite code' });
    }

    // Check if user has already used an invite code
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(uid).get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.inviteCodeUsed) {
        return res.status(400).json({ error: 'Invite code already used' });
      }

      // Update user with invite code
      await db.collection('users').doc(uid).update({
        inviteCodeUsed: inviteCode,
        inviteCodeTimestamp: new Date().toISOString(),
      });
    } else {
      // Create new user with invite code
      await db.collection('users').doc(uid).set({
        uid,
        inviteCodeUsed: inviteCode,
        inviteCodeTimestamp: new Date().toISOString(),
        created: new Date().toISOString(),
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error verifying invite code:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export default handler;
