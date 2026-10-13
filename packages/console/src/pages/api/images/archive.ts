import { NextApiRequest, NextApiResponse } from 'next';
import { client } from '../../../lib/auth';
import { getFirestore } from '../../../utils/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  let uid: string;
  try {
    ({ uid } = await client.verifyToken(token));
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const db = getFirestore();
  const docRef = db.doc(`users/${uid}/settings/archivedImages`);

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const doc = await docRef.get();
    const archived: string[] = doc.exists ? doc.data()?.fileNames || [] : [];
    console.log(`GET archive uid=${uid} path=${docRef.path} exists=${doc.exists} count=${archived.length} files=${JSON.stringify(archived)}`);
    return res.status(200).json({ archived });
  }

  if (req.method === 'POST') {
    const { fileName } = req.body;
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'fileName is required' });
    }
    const { FieldValue } = await import('firebase-admin/firestore');
    console.log(`POST archive uid=${uid} path=${docRef.path} fileName=${fileName}`);
    await docRef.set(
      { fileNames: FieldValue.arrayUnion(fileName) },
      { merge: true },
    );
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { fileName } = req.body;
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'fileName is required' });
    }
    const { FieldValue } = await import('firebase-admin/firestore');
    await docRef.set(
      { fileNames: FieldValue.arrayRemove(fileName) },
      { merge: true },
    );
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
