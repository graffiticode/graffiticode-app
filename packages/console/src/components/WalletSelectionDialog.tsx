import { Fragment, useState, useEffect } from 'react';
import { Dialog, Transition, Listbox } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface Wallet {
  name: string;
  provider: any;
}

interface WalletSelectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectWallet: (wallet: Wallet) => void;
}

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

// Store the original providers array globally
let originalProviders: any[] | null = null;

// Store the last selected wallet name
let lastSelectedWalletName: string | null = null;

export default function WalletSelectionDialog({
  isOpen,
  onClose,
  onSelectWallet
}: WalletSelectionDialogProps) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      // Detect wallets when dialog opens
      const detected: Wallet[] = [];
      const eth = (window as any).ethereum;

      // On first load, store the original providers if they exist
      if (!originalProviders && eth?.providers?.length) {
        originalProviders = [...eth.providers];
      }

      // Use original providers if available, otherwise check current state
      const providersToCheck = originalProviders || eth?.providers || [];

      if (providersToCheck.length > 0) {
        // Multiple providers available (either original or current)
        providersToCheck.forEach((provider: any) => {
          if (provider.isMetaMask) {
            detected.push({ name: 'MetaMask', provider });
          } else if (provider.isCoinbaseWallet) {
            detected.push({ name: 'Coinbase Wallet', provider });
          }
        });
      } else if (eth) {
        // Single provider - identify which one
        if (eth.isMetaMask && !eth.isCoinbaseWallet) {
          detected.push({ name: 'MetaMask', provider: eth });
        } else if (eth.isCoinbaseWallet) {
          detected.push({ name: 'Coinbase Wallet', provider: eth });
        } else {
          detected.push({ name: 'Injected Wallet', provider: eth });
        }
      }

      setWallets(detected);
      if (detected.length > 0) {
        // Try to select the last used wallet, otherwise select the first one
        const lastUsedWallet = detected.find(w => w.name === lastSelectedWalletName);
        setSelectedWallet(lastUsedWallet || detected[0]);
      }
      setLoading(false);
    }
  }, [isOpen]);

  const handleConnect = () => {
    if (selectedWallet) {
      // Remember the selected wallet
      lastSelectedWalletName = selectedWallet.name;
      onSelectWallet(selectedWallet);
      onClose();
    }
  };

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
              <Dialog.Panel className="relative transform overflow-hidden rounded-none bg-white px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-md sm:p-6">
                <div className="absolute right-0 top-0 hidden pr-4 pt-4 sm:block">
                  <button
                    type="button"
                    className="rounded-none bg-white text-gray-400 hover:text-gray-500"
                    onClick={onClose}
                  >
                    <span className="sr-only">Close</span>
                    <XMarkIcon className="h-6 w-6" aria-hidden="true" />
                  </button>
                </div>

                <div>
                  <Dialog.Title as="h3" className="text-base font-semibold leading-6 text-gray-900 mb-4">
                    Select Wallet
                  </Dialog.Title>

                  {loading ? (
                    <div className="text-sm text-gray-500">Detecting wallets...</div>
                  ) : wallets.length === 0 ? (
                    <div className="text-sm text-gray-500">No wallet detected. Please install an Ethereum wallet such as MetaMask or Coinbase. These are free to install and free to use for Graffiticode authentication.</div>
                  ) : wallets.length === 1 ? (
                    <div className="space-y-4">
                      <div className="text-sm text-gray-600">
                        Connecting with: <span className="font-medium">{wallets[0].name}</span>
                      </div>
                      <div className="mt-5 sm:mt-6">
                        <button
                          type="button"
                          className="inline-flex w-full justify-center rounded-none bg-gray-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700"
                          onClick={() => {
                            // Remember the selected wallet
                            lastSelectedWalletName = wallets[0].name;
                            onSelectWallet(wallets[0]);
                            onClose();
                          }}
                        >
                          Connect
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="text-sm text-gray-600 mb-3">
                        Multiple wallets detected. Please select one:
                      </div>

                      {/* Wallet list as buttons */}
                      <div className="space-y-2">
                        {wallets.map((wallet, idx) => (
                          <button
                            key={idx}
                            onClick={() => setSelectedWallet(wallet)}
                            className={classNames(
                              'w-full text-left px-4 py-3 border rounded-none transition-colors',
                              selectedWallet?.name === wallet.name
                                ? 'border-gray-600 bg-gray-50'
                                : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-gray-900">{wallet.name}</span>
                              {selectedWallet?.name === wallet.name && (
                                <CheckIcon className="h-5 w-5 text-gray-600" />
                              )}
                            </div>
                          </button>
                        ))}
                      </div>

                      <div className="mt-5 sm:mt-6 flex gap-3">
                        <button
                          type="button"
                          className="flex-1 inline-flex justify-center rounded-none border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gray-50"
                          onClick={onClose}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!selectedWallet}
                          className="flex-1 inline-flex justify-center rounded-none bg-gray-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                          onClick={handleConnect}
                        >
                          Connect
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}