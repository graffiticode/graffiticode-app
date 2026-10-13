import { NextApiRequest, NextApiResponse } from 'next';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../../lib/plans-config';
import { getFirestore } from '../../../utils/db';
import { requireUser } from '../../../lib/api-auth';
import { normalizeName } from '../../../lib/account-lookup';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: STRIPE_API_VERSION,
});

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  created: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const auth = await requireUser(req);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = auth.uid;


    const db = getFirestore();

    // Get user data - for new users, treat as having no payment methods
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    let stripeCustomerId = userData?.stripeCustomerId;

    // Handle different HTTP methods
    switch (req.method) {
      case 'GET': {
        // List all payment methods
        if (!stripeCustomerId) {
          return res.status(200).json({ paymentMethods: [] });
        }

        // Verify the customer exists in current mode (test/live)
        try {
          await stripe.customers.retrieve(stripeCustomerId);
        } catch (error: any) {
          if (error.code === 'resource_missing') {
            // Customer doesn't exist in current mode, clear it
            console.log(`Customer ${stripeCustomerId} doesn't exist in current Stripe mode, clearing...`);
            stripeCustomerId = null;
            // Clear the invalid customer ID from database
            await db.collection('users').doc(userId).update({
              stripeCustomerId: null
            });
            return res.status(200).json({ paymentMethods: [] });
          }
          throw error;
        }

        const paymentMethods = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: 'card',
        });

        // Get the default payment method
        const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
        let defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;

        // If there's only one payment method and no default is set, set it as default
        if (paymentMethods.data.length === 1 && !defaultPaymentMethodId) {
          await stripe.customers.update(stripeCustomerId, {
            invoice_settings: {
              default_payment_method: paymentMethods.data[0].id,
            },
          });
          defaultPaymentMethodId = paymentMethods.data[0].id;
          console.log('Auto-set single payment method as default:', defaultPaymentMethodId);
        }

        const formattedMethods: PaymentMethod[] = paymentMethods.data.map(pm => ({
          id: pm.id,
          brand: pm.card?.brand || 'unknown',
          last4: pm.card?.last4 || '****',
          expMonth: pm.card?.exp_month || 0,
          expYear: pm.card?.exp_year || 0,
          isDefault: pm.id === defaultPaymentMethodId,
          created: new Date(pm.created * 1000).toISOString(),
        }));

        return res.status(200).json({
          paymentMethods: formattedMethods,
          defaultMethodId: defaultPaymentMethodId,
        });
      }

      case 'POST': {
        // Add a new payment method
        const { paymentMethodId, setAsDefault = false } = req.body;

        if (!paymentMethodId) {
          return res.status(400).json({ error: 'Payment method ID is required' });
        }

        // Verify if existing customer ID is valid in current mode
        if (stripeCustomerId) {
          try {
            await stripe.customers.retrieve(stripeCustomerId);
          } catch (error: any) {
            if (error.code === 'resource_missing') {
              // Customer doesn't exist in current mode, clear it
              console.log(`Customer ${stripeCustomerId} doesn't exist in current Stripe mode, will create new...`);
              stripeCustomerId = null;
              // Clear the invalid customer ID from database
              await db.collection('users').doc(userId).update({
                stripeCustomerId: null
              });
            } else {
              throw error;
            }
          }
        }

        // Create Stripe customer if doesn't exist
        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            metadata: {
              userId: userId,
            },
            email: userData?.email,
            name: userData?.name,
          });

          stripeCustomerId = customer.id;

          // Save Stripe customer ID to user document
          // Use set with merge for new users without a document yet
          await db.collection('users').doc(userId).set({
            stripeCustomerId,
          }, { merge: true });
        }

        // Attach the payment method to the customer
        try {
          await stripe.paymentMethods.attach(paymentMethodId, {
            customer: stripeCustomerId,
          });
        } catch (attachError: any) {
          // If the payment method is already attached, continue
          if (attachError.code !== 'resource_missing' && !attachError.message?.includes('already been attached')) {
            console.error('Error attaching payment method:', attachError);
            return res.status(400).json({
              error: 'Failed to attach payment method',
              details: attachError.message || 'Payment method may already be attached or invalid'
            });
          }
        }

        // Check if this is the first payment method
        const existingPaymentMethods = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: 'card',
        });

        // Set as default if requested OR if this is the only payment method
        const shouldSetAsDefault = setAsDefault || existingPaymentMethods.data.length === 1;

        if (shouldSetAsDefault) {
          await stripe.customers.update(stripeCustomerId, {
            invoice_settings: {
              default_payment_method: paymentMethodId,
            },
          });
        }

        // Retrieve the payment method details
        const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

        // Get the updated list of payment methods to return
        const updatedPaymentMethods = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: 'card',
        });

        // Get the default payment method and customer info
        const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
        const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;

        // Update user profile with billing details from payment method and Stripe customer
        const billingDetails = paymentMethod.billing_details;
        const profileUpdate: Record<string, any> = {
          updated: new Date().toISOString(),
        };

        // Get info from billing details (from the payment method)
        if (billingDetails?.name) {
          profileUpdate.name = billingDetails.name;
          profileUpdate.nameLower = normalizeName(billingDetails.name);
        }
        if (billingDetails?.email) {
          profileUpdate.email = billingDetails.email;
        }
        if (billingDetails?.phone) {
          profileUpdate.phone = billingDetails.phone;
        }

        // Get Stripe customer created date
        if (customer.created) {
          profileUpdate.stripeCreated = new Date(customer.created * 1000).toISOString();
        }

        // Update user profile if we have any new info
        if (Object.keys(profileUpdate).length > 1) {
          await db.collection('users').doc(userId).set(profileUpdate, { merge: true });
        }

        const formattedMethods: PaymentMethod[] = updatedPaymentMethods.data.map(pm => ({
          id: pm.id,
          brand: pm.card?.brand || 'unknown',
          last4: pm.card?.last4 || '****',
          expMonth: pm.card?.exp_month || 0,
          expYear: pm.card?.exp_year || 0,
          isDefault: pm.id === defaultPaymentMethodId,
          created: new Date(pm.created * 1000).toISOString(),
        }));

        return res.status(201).json({
          success: true,
          paymentMethods: formattedMethods,
          newPaymentMethod: {
            id: paymentMethod.id,
            brand: paymentMethod.card?.brand || 'unknown',
            last4: paymentMethod.card?.last4 || '****',
            expMonth: paymentMethod.card?.exp_month || 0,
            expYear: paymentMethod.card?.exp_year || 0,
            isDefault: shouldSetAsDefault || paymentMethod.id === defaultPaymentMethodId,
            created: new Date(paymentMethod.created * 1000).toISOString(),
          },
        });
      }

      case 'PUT': {
        // Update a payment method (typically to set as default)
        const { methodId } = req.query;
        const { setAsDefault } = req.body;

        if (!methodId || typeof methodId !== 'string') {
          return res.status(400).json({ error: 'Method ID is required' });
        }

        if (!stripeCustomerId) {
          return res.status(400).json({ error: 'No payment methods found' });
        }

        if (setAsDefault) {
          await stripe.customers.update(stripeCustomerId, {
            invoice_settings: {
              default_payment_method: methodId,
            },
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Payment method updated',
        });
      }

      case 'DELETE': {
        // Remove a payment method
        const { methodId } = req.query;

        if (!methodId || typeof methodId !== 'string') {
          return res.status(400).json({ error: 'Method ID is required' });
        }

        // Check if this is the only payment method
        if (stripeCustomerId) {
          const paymentMethods = await stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: 'card',
          });

          if (paymentMethods.data.length === 1) {
            // Check if user has active subscription
            const subscriptions = await stripe.subscriptions.list({
              customer: stripeCustomerId,
              status: 'active',
              limit: 1,
            });

            if (subscriptions.data.length > 0) {
              return res.status(400).json({
                error: 'Cannot remove the only payment method while subscription is active',
                requiresAlternative: true,
              });
            }
          }

          // Detach the payment method
          await stripe.paymentMethods.detach(methodId);

          // If this was the default method, set another as default
          const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
          if (customer.invoice_settings?.default_payment_method === methodId) {
            const remainingMethods = await stripe.paymentMethods.list({
              customer: stripeCustomerId,
              type: 'card',
              limit: 1,
            });

            if (remainingMethods.data.length > 0) {
              await stripe.customers.update(stripeCustomerId, {
                invoice_settings: {
                  default_payment_method: remainingMethods.data[0].id,
                },
              });
            }
          }
        }

        return res.status(200).json({
          success: true,
          message: 'Payment method removed',
        });
      }

      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error managing payment methods:', error);
    return res.status(500).json({
      error: 'Failed to manage payment methods',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}