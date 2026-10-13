import { Fragment, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { ShareIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid';
import UserSearchCombobox from './UserSearchCombobox';
import { shareItem, type AccountMatch } from '../utils/swr/fetchers';
import useGraffiticodeAuth from '@graffiticode/auth-react';

interface ShareItemDialogProps {
  isOpen: boolean;
  onClose: () => void;
  itemId: string;
  itemName: string;
  sharedWith?: string[];
  onShareSuccess?: () => void;
}

export default function ShareItemDialog({
  isOpen,
  onClose,
  itemId,
  itemName,
  sharedWith = [],
  onShareSuccess
}: ShareItemDialogProps) {
  const { user } = useGraffiticodeAuth();
  const [selectedUser, setSelectedUser] = useState<AccountMatch | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleShare = async () => {
    if (!selectedUser || !user) return;

    setIsSharing(true);
    setShareResult(null);

    try {
      const result = await shareItem({
        user,
        itemId,
        targetUserId: selectedUser.accountId
      });

      setShareResult({
        success: result.success,
        message: result.message || (result.success ? 'Item shared successfully!' : 'Failed to share item')
      });

      if (result.success) {
        // Clear selection for next share
        setSelectedUser(null);
        // Notify parent of success
        if (onShareSuccess) {
          onShareSuccess();
        }
        // Auto-close after success
        setTimeout(() => {
          onClose();
          // Reset state after dialog closes
          setTimeout(() => {
            setShareResult(null);
          }, 300);
        }, 1500);
      }
    } catch (error) {
      setShareResult({
        success: false,
        message: 'An error occurred while sharing the item'
      });
    } finally {
      setIsSharing(false);
    }
  };

  const handleClose = () => {
    // Reset state when closing
    setSelectedUser(null);
    setShareResult(null);
    onClose();
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative transform overflow-visible rounded-none bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:p-6">
                <div className="absolute right-0 top-0 hidden pr-4 pt-4 sm:block">
                  <button
                    type="button"
                    className="rounded-none bg-white text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
                    onClick={handleClose}
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-none bg-gray-100 sm:mx-0 sm:h-10 sm:w-10">
                    <ShareIcon className="h-6 w-6 text-gray-600" aria-hidden="true" />
                  </div>
                  <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left w-full">
                    <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900">
                      Share Item
                    </Dialog.Title>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        Share &ldquo;{itemName}&rdquo; with another user. The item will be copied to their account.
                      </p>
                    </div>

                    {sharedWith.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-semibold text-gray-600 mb-1">Already shared with:</p>
                        <div className="text-xs text-gray-500">
                          {sharedWith.map((userId, index) => (
                            <span key={userId}>
                              {userId}
                              {index < sharedWith.length - 1 && ', '}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Find an account (name, email or account ID)
                      </label>
                      <UserSearchCombobox
                        selectedUser={selectedUser}
                        onSelectUser={setSelectedUser}
                      />
                    </div>

                    {shareResult && (
                      <div className={`mt-4 p-3 rounded-none ${shareResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
                        <div className="flex">
                          <div className="flex-shrink-0">
                            {shareResult.success ? (
                              <CheckCircleIcon className="h-5 w-5 text-green-400" aria-hidden="true" />
                            ) : (
                              <ExclamationCircleIcon className="h-5 w-5 text-red-400" aria-hidden="true" />
                            )}
                          </div>
                          <div className="ml-3">
                            <p className={`text-sm ${shareResult.success ? 'text-green-800' : 'text-red-800'}`}>
                              {shareResult.message}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                  <button
                    type="button"
                    disabled={!selectedUser || isSharing}
                    onClick={handleShare}
                    className="inline-flex w-full justify-center rounded-none bg-gray-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:bg-gray-300 disabled:cursor-not-allowed sm:ml-3 sm:w-auto"
                  >
                    {isSharing ? 'Sharing...' : 'Share'}
                  </button>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="mt-3 inline-flex w-full justify-center rounded-none bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 sm:mt-0 sm:w-auto"
                  >
                    Cancel
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}