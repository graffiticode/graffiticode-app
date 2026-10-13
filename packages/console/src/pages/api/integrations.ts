import { NextApiRequest, NextApiResponse } from 'next';
import { createHash } from 'crypto';
import { getFirestore } from '../../utils/db';
import { requireUser } from '../../lib/api-auth';

interface FrontIntegration {
  authSecret: string;
  emails: string[];
  apiKeyId?: string;
  apiKeyToken?: string;
}

function hashEmailAuth(authSecret: string, email: string): string {
  return createHash('sha256').update(authSecret + email).digest('hex');
}

interface IntegrationsSettings {
  front?: FrontIntegration;
  updatedAt?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Acts on the caller's own settings only; any ?userId= is ignored.
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
        .doc('integrations')
        .get();

      const defaultSettings: IntegrationsSettings = {
        front: undefined,
      };

      if (settingsDoc.exists) {
        const data = settingsDoc.data() as IntegrationsSettings;
        const responseData: any = { ...data };

        // Mask auth secret for Front, showing only last 4 chars
        if (data?.front) {
          const secret = data.front.authSecret || '';
          const maskedSecret = secret.length > 4
            ? '••••••••' + secret.slice(-4)
            : secret.length > 0 ? '••••' : '';
          responseData.front = {
            ...data.front,
            authSecret: maskedSecret,
            hasAuthSecret: !!data.front.authSecret,
            apiKeyId: data.front.apiKeyId,
          };
        }

        return res.status(200).json(responseData);
      }

      return res.status(200).json(defaultSettings);
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const updates = req.body as IntegrationsSettings;

      // Validate Front integration if provided
      if (updates.front) {
        if (updates.front.emails && !Array.isArray(updates.front.emails)) {
          return res.status(400).json({ error: 'emails must be an array' });
        }
      }

      const settingsRef = db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('integrations');

      const currentDoc = await settingsRef.get();
      const currentSettings = currentDoc.exists ? currentDoc.data() as IntegrationsSettings : {};

      // If authSecret is masked (starts with ••), preserve the existing secret
      let frontUpdate = updates.front;
      if (frontUpdate && frontUpdate.authSecret?.startsWith('••')) {
        frontUpdate = {
          ...frontUpdate,
          authSecret: currentSettings.front?.authSecret || '',
        };
      }

      // If apiKeyToken is masked (starts with ••), preserve the existing token
      if (frontUpdate && frontUpdate.apiKeyToken?.startsWith('••')) {
        frontUpdate = {
          ...frontUpdate,
          apiKeyToken: currentSettings.front?.apiKeyToken || '',
        };
      }

      // Build the new settings (exclude undefined values for Firestore)
      // Use existing values if client sends empty/missing values for apiKeyId/apiKeyToken
      const effectiveApiKeyId = frontUpdate?.apiKeyId || currentSettings.front?.apiKeyId;
      const effectiveApiKeyToken = frontUpdate?.apiKeyToken || currentSettings.front?.apiKeyToken;

      const newFront = frontUpdate ? {
        authSecret: frontUpdate.authSecret ?? currentSettings.front?.authSecret ?? '',
        emails: frontUpdate.emails ?? currentSettings.front?.emails ?? [],
        ...(effectiveApiKeyId ? { apiKeyId: effectiveApiKeyId } : {}),
        ...(effectiveApiKeyToken ? { apiKeyToken: effectiveApiKeyToken } : {}),
      } : currentSettings.front;

      // Build merged settings, excluding undefined values (Firestore doesn't accept undefined)
      const mergedSettings: Record<string, any> = {
        updatedAt: new Date().toISOString(),
      };
      if (newFront) {
        mergedSettings.front = newFront;
      }

      await settingsRef.set(mergedSettings);

      // Sync integrations/front collection
      if (newFront?.authSecret && newFront?.apiKeyId && newFront?.apiKeyToken) {
        const oldEmails = currentSettings.front?.emails || [];
        const newEmails = newFront.emails || [];
        const oldAuthSecret = currentSettings.front?.authSecret || '';
        const frontCollection = db.collection('integrations').doc('front').collection('emails');

        // Remove old hashes that are no longer valid
        for (const oldEmail of oldEmails) {
          const oldHash = hashEmailAuth(oldAuthSecret.trim(), oldEmail.toLowerCase().trim());
          // Only delete if email is removed or auth secret changed
          if (!newEmails.map(e => e.toLowerCase().trim()).includes(oldEmail.toLowerCase().trim()) || oldAuthSecret.trim() !== newFront.authSecret.trim()) {
            await frontCollection.doc(oldHash).delete();
          }
        }

        // Add/update new hashes
        for (const email of newEmails) {
          const trimmedSecret = newFront.authSecret.trim();
          const trimmedEmail = email.toLowerCase().trim();
          const hash = hashEmailAuth(trimmedSecret, trimmedEmail);
          await frontCollection.doc(hash).set({
            userId: userId,
            apiKeyId: newFront.apiKeyId,
            apiKeyToken: newFront.apiKeyToken,
          });
        }
      }

      // Return masked version
      const responseSettings: any = { updatedAt: mergedSettings.updatedAt };
      if (mergedSettings.front) {
        const secret = mergedSettings.front.authSecret || '';
        responseSettings.front = {
          ...mergedSettings.front,
          authSecret: secret.length > 4
            ? '••••••••' + secret.slice(-4)
            : secret.length > 0 ? '••••' : '',
        };
        delete responseSettings.front.apiKeyToken; // Don't return the token
      }
      return res.status(200).json({
        success: true,
        settings: responseSettings,
      });
    } else if (req.method === 'DELETE') {
      const settingsRef = db
        .collection('users')
        .doc(userId)
        .collection('settings')
        .doc('integrations');

      // Get current settings to clean up integrations/front
      const currentDoc = await settingsRef.get();
      if (currentDoc.exists) {
        const currentSettings = currentDoc.data() as IntegrationsSettings;
        if (currentSettings.front?.authSecret && currentSettings.front?.emails) {
          const frontCollection = db.collection('integrations').doc('front').collection('emails');
          // Delete all entries for this integration
          for (const email of currentSettings.front.emails) {
            const hash = hashEmailAuth(currentSettings.front.authSecret.trim(), email.toLowerCase().trim());
            await frontCollection.doc(hash).delete();
          }
        }
      }

      await settingsRef.delete();

      return res.status(200).json({ success: true });
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error handling integrations settings:', error);
    return res.status(500).json({
      error: 'Failed to process integrations settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
