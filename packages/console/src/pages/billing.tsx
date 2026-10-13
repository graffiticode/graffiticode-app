import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { Tab } from '@headlessui/react';
import {
  CreditCardIcon,
  DocumentTextIcon,
  CurrencyDollarIcon,
  ChartBarIcon
} from '@heroicons/react/24/outline';
import { paymentsPost } from '../utils/payments-client';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { getPageTitle } from '../lib/utils';
import SignIn from '../components/SignIn';
import SubscriptionCard from '../components/payments/SubscriptionCard';
import PricingPlans from '../components/payments/PricingPlans';
import BillingHistory from '../components/payments/BillingHistory';
import PaymentMethods from '../components/payments/PaymentMethods';
import UsageMonitor from '../components/payments/UsageMonitor';

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

const tabs = [
  { name: 'Plan', icon: CurrencyDollarIcon },
  { name: 'Usage', icon: ChartBarIcon },
  { name: 'Payment History', icon: DocumentTextIcon },
  { name: 'Payment Methods', icon: CreditCardIcon },
];

const TAB_STORAGE_KEY = 'graffiticode:billing:tab';

export default function Billing() {
  const router = useRouter();
  const { user, loading } = useGraffiticodeAuth();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subscriptionKey, setSubscriptionKey] = useState(0); // Force refresh of subscription components

  // Restore the last tab after mount (not during render) so the server and
  // client agree on the first paint.
  useEffect(() => {
    const saved = Number(localStorage.getItem(TAB_STORAGE_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < tabs.length) {
      setSelectedIndex(saved);
    }
  }, []);

  const selectTab = (index: number) => {
    setSelectedIndex(index);
    localStorage.setItem(TAB_STORAGE_KEY, String(index));
  };

  const refreshSubscription = () => {
    setSubscriptionKey(prev => prev + 1); // Increment to trigger re-render
  };

  // Handle return from checkout after adding payment method for resume
  useEffect(() => {
    if (router.query.resumed === 'true' && user) {
      // Call resume API - payment method now exists so it should succeed
      paymentsPost(user, 'resume-subscription')
        .then(() => {
          refreshSubscription();
        })
        .catch((error) => {
          console.error('Error resuming subscription after checkout:', error);
        })
        .finally(() => {
          // Clear the query param
          router.replace('/billing', undefined, { shallow: true });
        });
    }
  }, [router.query.resumed, user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
        <SignIn
          label="Sign in to continue"
        />
        <p className="mt-4 text-sm text-gray-600 text-center max-w-sm">
          New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
        </p>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>{getPageTitle('Billing')}</title>
      </Head>

      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Billing</h1>
            <p className="mt-2 text-sm text-gray-600">
              Track your usage, choose a plan, review past payments, and manage your
              payment methods.
            </p>
          </div>

          <Tab.Group selectedIndex={selectedIndex} onChange={selectTab}>
            <Tab.List className="flex space-x-1 rounded-none bg-gray-200 p-1">
              {tabs.map((tab) => (
                <Tab
                  key={tab.name}
                  className={({ selected }) =>
                    classNames(
                      'w-full rounded-none py-2.5 text-sm font-medium leading-5',
                      'ring-white ring-opacity-60 ring-offset-2 ring-offset-gray-400 focus:outline-none focus:ring-2',
                      selected
                        ? 'bg-white text-gray-900 shadow'
                        : 'text-gray-700 hover:bg-white/[0.12] hover:text-gray-900'
                    )
                  }
                >
                  <div className="flex items-center justify-center space-x-2">
                    <tab.icon className="h-5 w-5" />
                    <span>{tab.name}</span>
                  </div>
                </Tab>
              ))}
            </Tab.List>

            <Tab.Panels className="mt-6">
              <Tab.Panel className="rounded-none bg-white p-6 shadow">
                <div className="space-y-6">
                  <SubscriptionCard key={subscriptionKey} />
                  <div className="border-t pt-6">
                    <PricingPlans onSubscriptionChange={refreshSubscription} />
                  </div>
                </div>
              </Tab.Panel>

              <Tab.Panel className="rounded-none bg-white p-6 shadow">
                <UsageMonitor />
              </Tab.Panel>

              <Tab.Panel className="rounded-none bg-white p-6 shadow">
                <BillingHistory />
              </Tab.Panel>

              <Tab.Panel className="rounded-none bg-white p-6 shadow">
                <PaymentMethods />
              </Tab.Panel>
            </Tab.Panels>
          </Tab.Group>
        </div>
      </div>
    </>
  );
}