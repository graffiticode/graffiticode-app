import { getFirestore } from '../../../utils/db';
import { requireUser } from '../../../lib/api-auth';

// Ensure the caller's own users/{uid} doc exists and return its id. Used by
// SetupForm before it asks for a Stripe setup intent. It never looks anyone
// else up and never takes fields from the body.
const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const auth = await requireUser(req);
  if (!auth) return res.status(401).end();
  try {
    const ref = getFirestore().collection('users').doc(auth.uid);
    if (!(await ref.get()).exists) {
      await ref.set({ uid: auth.uid, created: new Date().toISOString() }, { merge: true });
    }
    res.status(200).json({ id: auth.uid });
  } catch (e) {
    console.info("POST /user error=" + e);
    res.status(400).end();
  }
}

export default handler;
