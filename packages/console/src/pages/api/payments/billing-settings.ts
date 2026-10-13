import { NextApiRequest, NextApiResponse } from 'next';
import { getFirestore } from '../../../utils/db';
import { requireUser } from '../../../lib/api-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUser(req);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = auth.uid;

  const db = getFirestore();

  try {
    if (req.method === 'GET') {
      const settingsDoc = await db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('billing')
        .get();

      const defaultSettings: Record<string, any> = {
        notifications: {
          emailOnLowBalance: true,
          emailOnPurchase: true,
          lowBalanceThreshold: 25,
        },
      };

      const settings = settingsDoc.exists ? settingsDoc.data() : defaultSettings;

      return res.status(200).json(settings);
    } else if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST') {
      const updates = req.body;

      const settingsRef = db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('billing');

      const currentDoc = await settingsRef.get();
      const currentSettings = currentDoc.exists ? currentDoc.data() : {};

      const mergedSettings = {
        ...currentSettings,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      if (currentDoc.exists) {
        await settingsRef.update(mergedSettings);
      } else {
        await settingsRef.set(mergedSettings);
      }

      return res.status(200).json({
        success: true,
        settings: mergedSettings,
      });
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error handling billing settings:', error);
    return res.status(500).json({
      error: 'Failed to process billing settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}