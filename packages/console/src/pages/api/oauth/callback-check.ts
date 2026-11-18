// GET /api/oauth/callback-check?url=… — whether the consent page may send a
// grant to this callback (core/oauth-callbacks.ts), so a bad link fails before
// the person signs in. /api/oauth/grant checks again and decides.
import type { NextApiRequest, NextApiResponse } from 'next';
import { oauthCallbackAllowed } from '@graffiticode-app/core/oauth-callbacks';
import { installationHosts, profile } from '@graffiticode-app/core/profile/runtime';
import { withInstallation } from '../../../lib/with-installation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ allowed: oauthCallbackAllowed(req.query.url, profile(), installationHosts()) });
}

export default withInstallation(handler);
