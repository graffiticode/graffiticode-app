import { useState, useEffect } from 'react';
import { CreditCardIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { paymentsGet, paymentsPost, paymentsDelete } from '../../utils/payments-client';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || 'pk_test_PwlNxtmtkJ5hH6Ze0eMPsOaS');

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

interface PaymentMethodsProps {
}

function AddPaymentMethodForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const { user } = useGraffiticodeAuth();
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setProcessing(true);
    setError(null);

    // Get the CardElement
    const cardElement = elements.getElement(CardElement);

    if (!cardElement) {
      setError('Card element not found');
      setProcessing(false);
      return;
    }

    // Create a payment method directly with billing details
    const { error, paymentMethod } = await stripe.createPaymentMethod({
      type: 'card',
      card: cardElement,
      billing_details: {
        name: name || undefined,
        email: email || undefined,
      },
    });

    if (error) {
      setError(error.message || 'An error occurred');
      setProcessing(false);
    } else if (paymentMethod) {
      // Save the payment method to our backend
      try {
        const response = await paymentsPost(user, 'methods', {
          paymentMethodId: paymentMethod.id,
          setAsDefault: false
        });

        if (response.data.success) {
          onSuccess();
        } else {
          setError('Failed to save payment method');
          setProcessing(false);
        }
      } catch (err: any) {
        console.error('Error saving payment method:', err);
        const errorMessage = err.response?.data?.details || err.response?.data?.error || 'Failed to save payment method';
        setError(errorMessage);
        setProcessing(false);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-700">
          Full Name
        </label>
        <input
          type="text"
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full border border-gray-300 rounded-none shadow-sm py-2 px-3 focus:outline-none focus:ring-gray-500 focus:border-gray-500 sm:text-sm"
          placeholder="John Doe"
        />
      </div>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700">
          Email
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full border border-gray-300 rounded-none shadow-sm py-2 px-3 focus:outline-none focus:ring-gray-500 focus:border-gray-500 sm:text-sm"
          placeholder="john@example.com"
        />
      </div>
      <div className="p-4 border border-gray-300 rounded-none">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: '16px',
                color: '#424770',
                '::placeholder': {
                  color: '#aab7c4',
                },
              },
              invalid: {
                color: '#9e2146',
              },
            },
          }}
        />
      </div>
      {error && (
        <div className="text-sm text-red-600">{error}</div>
      )}
      <div className="flex justify-end space-x-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-none shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || processing}
          className="px-4 py-2 border border-transparent rounded-none shadow-sm text-sm font-medium text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 disabled:opacity-50"
        >
          {processing ? 'Processing...' : 'Add Payment Method'}
        </button>
      </div>
    </form>
  );
}

export default function PaymentMethods({}: PaymentMethodsProps) {
  const { user } = useGraffiticodeAuth();
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false);

  useEffect(() => {
    fetchPaymentMethods();
    fetchSubscriptionStatus();
  }, [user]);

  const fetchPaymentMethods = async () => {
    try {
      const response = await paymentsGet(user, 'methods');
      // Extract paymentMethods array from response object
      const methods = response.data.paymentMethods || response.data || [];
      // Ensure it's always an array
      setPaymentMethods(Array.isArray(methods) ? methods : []);
    } catch (error) {
      console.error('Error fetching payment methods:', error);
      // Set to empty array on error rather than mock data
      setPaymentMethods([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchSubscriptionStatus = async () => {
    try {
      const response = await paymentsGet(user, 'subscription');
      const subscription = response.data;
      // Check if user has an active paid subscription
      setHasActiveSubscription(
        subscription.status === 'active' &&
        subscription.plan !== 'starter' &&
        subscription.plan !== 'none'
      );
    } catch (error) {
      console.error('Error fetching subscription:', error);
      setHasActiveSubscription(false);
    }
  };

  const handleAddPaymentMethod = () => {
    setShowAddForm(true);
  };

  const handleRemovePaymentMethod = async (methodId: string) => {
    if (!confirm('Are you sure you want to remove this payment method?')) {
      return;
    }

    try {
      await paymentsDelete(user, `methods/${methodId}`);
      await fetchPaymentMethods();
    } catch (error: any) {
      console.error('Error removing payment method:', error);
      const errorMessage = error.response?.data?.error || 'Failed to remove payment method.';
      alert(errorMessage);
    }
  };

  const handleSetDefault = async (methodId: string) => {
    try {
      await paymentsPost(user, 'methods/set-default', { methodId });
      await fetchPaymentMethods();
    } catch (error) {
      console.error('Error setting default payment method:', error);
      alert('Failed to set default payment method.');
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="h-24 bg-gray-200 rounded-none"></div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg leading-6 font-medium text-gray-900">
            Payment Methods
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Manage your payment methods for subscriptions and overage charges.
          </p>
        </div>
        {!showAddForm && (
          <button
            onClick={handleAddPaymentMethod}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-none shadow-sm text-sm font-medium text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
          >
            <PlusIcon className="h-4 w-4 mr-2" />
            Add Payment Method
          </button>
        )}
      </div>

      {/* Add Payment Method Form */}
      {showAddForm && (
        <div className="bg-gray-50 rounded-none p-6">
          <h4 className="text-sm font-medium text-gray-900 mb-4">Add New Payment Method</h4>
          <Elements stripe={stripePromise}>
            <AddPaymentMethodForm
              onSuccess={() => {
                setShowAddForm(false);
                fetchPaymentMethods();
              }}
              onCancel={() => {
                setShowAddForm(false);
              }}
            />
          </Elements>
        </div>
      )}

      {/* Payment Methods List */}
      {!Array.isArray(paymentMethods) || paymentMethods.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-none border-2 border-dashed border-gray-300">
          <CreditCardIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900">No payment methods</h3>
          <p className="mt-1 text-sm text-gray-500">Get started by adding a payment method.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {paymentMethods.map((method) => {
            const isLastMethod = paymentMethods.length === 1;
            const cannotRemove = isLastMethod && hasActiveSubscription;

            return (
              <div
                key={method.id}
                className={`bg-white shadow rounded-none p-6 ${
                  method.isDefault ? 'ring-2 ring-gray-500' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <CreditCardIcon className="h-8 w-8 text-gray-400 mr-4" />
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {method.brand} ending in {method.last4}
                      </p>
                      <p className="text-sm text-gray-500">
                        Expires {method.expMonth}/{method.expYear}
                      </p>
                      {method.isDefault && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 mt-1">
                          Default
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    {!method.isDefault && (
                      <button
                        onClick={() => handleSetDefault(method.id)}
                        className="text-sm text-gray-600 hover:text-gray-500"
                      >
                        Set as default
                      </button>
                    )}
                    <div className="relative group">
                      <button
                        onClick={() => handleRemovePaymentMethod(method.id)}
                        disabled={cannotRemove}
                        className={`text-sm inline-flex items-center ${
                          cannotRemove
                            ? 'text-gray-400 cursor-not-allowed'
                            : 'text-red-600 hover:text-red-500'
                        }`}
                      >
                        <TrashIcon className="h-4 w-4 mr-1" />
                        Remove
                      </button>
                      {cannotRemove && (
                        <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Cannot remove the only payment method with an active subscription. Add another payment method first.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Security Notice */}
      <div className="bg-gray-50 border-l-4 border-gray-400 p-4">
        <div className="flex">
          <div className="ml-3">
            <p className="text-sm text-gray-700">
              Your payment information is securely stored with Stripe. We never store your full card details on our servers.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}