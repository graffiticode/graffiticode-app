import { getFirestore } from '../../../utils/db';
import { emitEvent, actor } from '../../../lib/funnel-events';
import { requireUser } from '../../../lib/api-auth';
import { normalizeName } from '../../../lib/account-lookup';

// Fields a user may set on their own users/{uid} doc. Everything else
// (stripeCustomerId, signInEmail, plan state, ...) is written only by the
// server paths that own it, so a PUT body can't forge it.
const SELF_EDITABLE = [
  'name',
  'notificationEmail',
  'notificationPhone',
  'notifyByEmail',
  'notifyByPhone',
  'profileImageUrl',
  // Sent by AuthWrapper.ensureUserExists() when it creates the doc.
  'uid',
  'created',
];

const pickEditable = (body: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const key of SELF_EDITABLE) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
};

const handler = async (req, res) => {
  const auth = await requireUser(req);
  if (!auth) return res.status(401).end();
  const { name } = req.query;
  // Only the account itself may read, write or delete its user doc.
  if (typeof name !== 'string' || name !== auth.uid) return res.status(403).end();
  try {
    const db = getFirestore();
    if (req.method === 'PUT') {
      // AuthWrapper.ensureUserExists() PUTs here only after a 404, so this is
      // the one place every sign-in method (wallet, email/Privy, SSO) converges
      // on creating a console account. The extra read costs one lookup on a path
      // that runs once per account.
      const { via, ...rest } = req.body ?? {};
      const body = pickEditable(rest);
      if (body.uid !== undefined) body.uid = auth.uid;
      if (typeof body.name === 'string') body.nameLower = normalizeName(body.name);
      const existed = (await db.collection('users').doc(name).get()).exists;
      await db.collection('users').doc(name).set({
        ...body,
        updated: new Date().toISOString(),
      }, { merge: true });
      if (!existed) {
        emitEvent('signup', {
          ...actor({ uid: String(name) }),
          via: via === 'claim' ? 'claim' : 'direct',
        });
      }
    } else if (req.method === 'GET') {
      const doc = await db.collection('users').doc(name).get();
      if (!doc.exists) {
        return res.status(404).end();
      } else {
        return res.status(200).json(doc.data());
      }
    } else if (req.method === 'DELETE') {
      await db.collection('users').doc(name).delete();
      return res.status(200).end();
    } else {
      return res.status(405).end();
    }
    res.status(200).end();
  } catch (e) {
    res.status(400).end();
  }
}

export default handler;
