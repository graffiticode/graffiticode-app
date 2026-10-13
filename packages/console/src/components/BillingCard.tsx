import { useState } from 'react';
import { PaperClipIcon } from '@heroicons/react/20/solid';
import StripeSetupForm from './SetupForm';

const types = {
  COLLECT_PAYMENT_INFO: 1,
  SHOW_PAYMENT_INFO: 2,
  NO_PAYMENT_INFO: 3,
};

const ShowPaymentInfo = () =>
  <>
    <dt className="text-sm font-medium text-gray-500">Visa card ending 4242</dt>
    <dd className="mt-1 text-sm text-gray-900 sm:col-span-2 sm:mt-0">
      <button
        type="button"
className="inline-flex items-center bg-gray-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
      >
        Change payment method
      </button>
    </dd>
  </>;

const NoPaymentInfo = ({setMode}) =>
      <div className="py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5 sm:px-6">
    <dt className="text-sm font-medium text-gray-500">No card on file</dt>
    <dd className="mt-1 text-sm text-gray-900 sm:col-span-2 sm:mt-0">
      <button
        type="button"
        onClick={() => setMode(types.COLLECT_PAYMENT_INFO)}
        className="inline-flex items-center bg-gray-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
      >
        Add payment method
      </button>
    </dd>
  </div>;

export default function Example() {
  const [mode, setMode] = useState(types.NO_PAYMENT_INFO);
  return (
    <div className="overflow-hidden bg-white">
      <div className="px-4 py-5 sm:p-0">
        <dl className="divide-y">
          {
            mode === types.COLLECT_PAYMENT_INFO && <StripeSetupForm />
            || mode === types.SHOW_PAYMENT_INFO && <ShowPaymentInfo />
            || <NoPaymentInfo setMode={setMode}/>
          }
          <div className="py-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:py-5 sm:px-6">
            <dt className="text-sm font-medium text-gray-500">Current usage</dt>
            <dd className="mt-1 text-sm text-gray-900 sm:col-span-2 sm:mt-0">$10.50 (1,050 compiles)</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
