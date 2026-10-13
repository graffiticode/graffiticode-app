import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../../lib/plans-config';
import { getFirestore } from '../../../utils/db';
import { requireUser } from '../../../lib/api-auth';

// Initialize Stripe only if secret key is available
let stripe: Stripe | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
}

interface Invoice {
  id: string;
  date: string;
  amount: number;
  status: string;
  description: string;
  invoicePdf?: string;
  type: 'subscription' | 'overage' | 'one-time';
  plan?: string;
  period?: {
    start: string;
    end: string;
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;
    const { limit = 12, startingAfter } = req.query;


    const db = getFirestore();

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const stripeCustomerId = userData?.stripeCustomerId;

    const invoices: Invoice[] = [];

    // If user has a Stripe customer and Stripe is configured, fetch invoices from Stripe
    if (stripeCustomerId && stripe) {
      // Fetch subscription invoices from Stripe
      const stripeInvoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        limit: Number(limit),
        starting_after: startingAfter as string,
      });

      const invoiceIds = new Set<string>();

      for (const invoice of stripeInvoices.data) {
        const isOverage = invoice.metadata?.type === 'overage_purchase';
        let planName = 'Unknown';
        let type: Invoice['type'] = isOverage ? 'overage' : 'subscription';

        if (!isOverage && invoice.lines.data.length > 0) {
          const firstLineItem = invoice.lines.data[0];
          if (firstLineItem.description?.toLowerCase().includes('pro')) {
            planName = 'Pro';
          } else if (firstLineItem.description?.toLowerCase().includes('team') ||
                     firstLineItem.description?.toLowerCase().includes('max')) {
            planName = 'Max';
          } else if (firstLineItem.description?.toLowerCase().includes('starter') ||
                     firstLineItem.description?.toLowerCase().includes('free')) {
            planName = 'Starter';
          }
        }

        const displayDescription = isOverage
          ? (invoice.description || 'Overage units purchase')
          : `${planName} subscription`;

        invoiceIds.add(invoice.id);
        invoices.push({
          id: invoice.id,
          date: new Date(invoice.created * 1000).toISOString(),
          amount: (invoice.amount_paid || invoice.amount_due) / 100,
          status: invoice.status || 'pending',
          description: displayDescription,
          invoicePdf: invoice.invoice_pdf || undefined,
          type,
          plan: isOverage ? invoice.metadata?.plan : planName,
          period: invoice.period_start && invoice.period_end ? {
            start: new Date(invoice.period_start * 1000).toISOString(),
            end: new Date(invoice.period_end * 1000).toISOString(),
          } : undefined,
        });
      }

      // Fetch legacy overage PaymentIntents (before invoice-based purchases)
      const payments = await stripe.paymentIntents.list({
        customer: stripeCustomerId,
        limit: Number(limit),
      });

      for (const payment of payments.data) {
        if (payment.metadata?.type === 'overage_purchase' && payment.status === 'succeeded') {
          // Skip if this payment is already represented by an invoice
          // (`invoice`/`charges` were removed from the PaymentIntent shape in
          // recent API versions; this legacy-overage block is retired anyway).
          const pi = payment as any;
          if (pi.invoice && invoiceIds.has(pi.invoice as string)) continue;
          invoices.push({
            id: payment.id,
            date: new Date(payment.created * 1000).toISOString(),
            amount: payment.amount / 100,
            status: 'paid',
            description: payment.description || 'Overage units purchase',
            // Legacy PaymentIntent overage charges have no Stripe invoice/PDF,
            // but the charge has a hosted receipt — surface it so Download works.
            invoicePdf: pi.charges?.data?.[0]?.receipt_url || undefined,
            type: 'overage',
            plan: payment.metadata.plan,
          });
        }
      }
    }

    // Also fetch any manual credits or adjustments from Firestore
    try {
      const creditsQuery = await db
        .collection('billing_events')
        .where('userId', '==', userId)
        .orderBy('timestamp', 'desc')
        .limit(Number(limit))
        .get();

      creditsQuery.docs.forEach(doc => {
        const data = doc.data();
        if (data.type === 'credit' || data.type === 'adjustment') {
          invoices.push({
            id: doc.id,
            date: data.timestamp.toDate().toISOString(),
            amount: data.amount,
            status: 'completed',
            description: data.description || 'Account credit',
            type: 'one-time',
          });
        }
      });
    } catch (creditsError) {
      console.error('Error fetching billing events (may need Firestore index):', creditsError);
      // Continue without manual credits
    }

    // Sort all invoices by date (most recent first)
    invoices.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Calculate summary statistics
    const totalPaid = invoices
      .filter(inv => inv.status === 'paid' || inv.status === 'completed')
      .reduce((sum, inv) => sum + inv.amount, 0);

    const totalPending = invoices
      .filter(inv => inv.status === 'pending' || inv.status === 'draft')
      .reduce((sum, inv) => sum + inv.amount, 0);

    return res.status(200).json({
      invoices: invoices.slice(0, Number(limit)),
      summary: {
        totalPaid,
        totalPending,
        count: invoices.length,
        hasMore: invoices.length > Number(limit),
      },
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    return res.status(500).json({
      error: 'Failed to fetch billing history',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}