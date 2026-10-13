import { NextApiRequest, NextApiResponse } from 'next';
import { client } from '../../lib/auth';
import { getItem } from './resolvers';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { id } = req.query;
    const token = req.headers.authorization;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Item ID is required' });
    }

    if (!token) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const { uid } = await client.verifyToken(token);
    const item = await getItem({ auth: { uid, token }, id });

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    return res.status(200).json(item);
  } catch (error) {
    console.error('Error fetching item:', error);
    return res.status(500).json({ error: 'Failed to fetch item' });
  }
}
