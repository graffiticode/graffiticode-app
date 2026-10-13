import React, { useState, Fragment } from 'react';
import { useUsageStatus } from '../hooks/use-usage-status';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';

interface UsageWarningProps {
}

export default function UsageWarning({}: UsageWarningProps) {
  const {
    isOverLimit,
    isNearLimit,
    remainingItems,
    percentageUsed,
    totalItems,
    usedItems,
    hardCap,
    loading
  } = useUsageStatus();

  const [showPopup, setShowPopup] = useState(false);

  // Don't show anything if loading
  if (loading) {
    return null;
  }

  const uncapped = totalItems === null;

  const formatNumber = (num: number) => {
    return Math.abs(num).toLocaleString();
  };

  const getDotColor = () => {
    if (isOverLimit) {
      return {
        dot: 'bg-red-500',
        ring: 'ring-red-500',
        animation: 'animate-pulse',
        barColor: 'bg-red-500',
        barBgColor: 'bg-red-100',
      };
    }
    if (isNearLimit) {
      return {
        dot: 'bg-yellow-500',
        ring: 'ring-yellow-500',
        animation: '',
        barColor: 'bg-yellow-500',
        barBgColor: 'bg-yellow-100',
      };
    }
    // Normal status (under 80% usage)
    return {
      dot: 'bg-green-500',
      ring: 'ring-green-500',
      animation: '',
      barColor: 'bg-green-500',
      barBgColor: 'bg-green-100',
    };
  };

  const getStatusText = () => {
    if (isOverLimit) {
      return 'Over Limit';
    }
    if (isNearLimit) {
      return 'Near Limit';
    }
    return 'Normal Usage';
  };

  const styles = getDotColor();
  const percentage = Math.min(percentageUsed, 999);
  const displayPercentage = Math.min(100, percentage); // Cap display at 100% for bar

  return (
    <>
      {/* Dot Indicator */}
      <button
        onClick={() => setShowPopup(true)}
        className="relative inline-flex items-center focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-white rounded-full"
      >
        <span
          className={`
            block w-2 h-2 rounded-full
            ${styles.dot}
            ring-2 ring-opacity-30 ${styles.ring}
            ${styles.animation}
            cursor-pointer
          `}
        />
      </button>

      {/* Popup Dialog */}
      <Transition.Root show={showPopup} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={setShowPopup}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-30 transition-opacity" />
          </Transition.Child>

          <div className="fixed inset-0 z-10 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-0">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
                enterTo="opacity-100 translate-y-0 sm:scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 translate-y-0 sm:scale-100"
                leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              >
                <Dialog.Panel className="relative transform overflow-hidden rounded-none bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-sm sm:p-6">
                  <div className="absolute right-0 top-0 pr-4 pt-4">
                    <button
                      type="button"
                      className="rounded-none bg-white text-gray-400 hover:text-gray-500 focus:outline-none"
                      onClick={() => setShowPopup(false)}
                    >
                      <span className="sr-only">Close</span>
                      <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                    </button>
                  </div>

                  <div>
                    <div className="text-center">
                      <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                        Usage Status
                      </Dialog.Title>

                      {/* Status Badge */}
                      <div className="mt-4">
                        <span className={`
                          inline-flex items-center px-3 py-1 rounded-full text-xs font-medium
                          ${isOverLimit ? 'bg-red-100 text-red-800' :
                            isNearLimit ? 'bg-yellow-100 text-yellow-800' :
                            'bg-green-100 text-green-800'}
                        `}>
                          {getStatusText()}
                        </span>
                      </div>

                      {/* Usage Bar Chart */}
                      <div className="mt-6">
                        <div className="flex justify-between text-sm text-gray-600 mb-2">
                          <span>Used: {formatNumber(usedItems)} items</span>
                          <span>Included: {uncapped ? 'Unlimited' : formatNumber(totalItems as number)}</span>
                        </div>

                        {/* Progress Bar */}
                        <div className={`w-full ${styles.barBgColor} rounded-none h-8 relative overflow-hidden`}>
                          <div
                            className={`${styles.barColor} h-8 rounded-none transition-all duration-300 flex items-center justify-center`}
                            style={{ width: `${displayPercentage}%` }}
                          >
                            {displayPercentage > 20 && (
                              <span className="text-white text-xs font-semibold">
                                {percentage.toFixed(0)}%
                              </span>
                            )}
                          </div>
                          {displayPercentage <= 20 && (
                            <span className="absolute inset-0 flex items-center justify-center text-gray-700 text-xs font-semibold">
                              {percentage.toFixed(0)}%
                            </span>
                          )}
                        </div>

                        {/* Additional Info */}
                        <div className="mt-4 space-y-2 text-sm">
                          {uncapped ? (
                            <div className="text-green-600 font-medium">
                              {formatNumber(usedItems)} items created this period
                            </div>
                          ) : isOverLimit ? (
                            <div className="text-red-600 font-medium">
                              {hardCap
                                ? `Reached your ${formatNumber(totalItems as number)}-item Free limit`
                                : 'Overage spend cap reached'}
                            </div>
                          ) : (
                            <div className="text-green-600 font-medium">
                              {formatNumber(remainingItems as number)} items remaining
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="mt-6 space-y-2">
                        <Link
                          href="/billing"
                          className="inline-flex w-full justify-center rounded-none bg-gray-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600"
                          onClick={() => setShowPopup(false)}
                        >
                          {isOverLimit && hardCap ? 'Upgrade Plan' : 'Manage Subscription'}
                        </Link>
                        <button
                          type="button"
                          className="inline-flex w-full justify-center rounded-none bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                          onClick={() => setShowPopup(false)}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition.Root>
    </>
  );
}