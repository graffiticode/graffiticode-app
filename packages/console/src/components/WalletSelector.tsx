import { Fragment, useState, useEffect } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid';

interface Wallet {
  name: string;
  provider: any;
}

interface WalletSelectorProps {
  onSelectWallet: (wallet: Wallet) => void;
}

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}

export default function WalletSelector({ onSelectWallet }: WalletSelectorProps) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<Wallet | null>(null);

  useEffect(() => {
    const detected: Wallet[] = [];
    const eth = (window as any).ethereum;

    // Check if we have multiple providers (EIP-5749)
    if (eth?.providers?.length) {
      eth.providers.forEach((provider: any) => {
        if (provider.isMetaMask) {
          detected.push({ name: 'MetaMask', provider });
        } else if (provider.isCoinbaseWallet) {
          detected.push({ name: 'Coinbase Wallet', provider });
        }
      });
    } else if (eth) {
      // Single provider
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
      setSelectedWallet(detected[0]);
    }
  }, []);

  const handleWalletChange = (wallet: Wallet) => {
    setSelectedWallet(wallet);
    onSelectWallet(wallet);
  };

  if (wallets.length <= 1) {
    // If only one wallet or no wallets, don't show selector
    return null;
  }

  return (
    <div className="w-48">
      <Listbox value={selectedWallet} onChange={handleWalletChange}>
        <div className="relative">
          <Listbox.Button className="relative w-full cursor-pointer rounded-none border border-gray-300 bg-white py-2 pl-3 pr-10 text-left text-gray-900 shadow-sm hover:bg-gray-50 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 sm:text-sm">
            <span className="block truncate text-gray-900">{selectedWallet?.name || 'Select Wallet'}</span>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
              <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
            </span>
          </Listbox.Button>
          <Transition
            as={Fragment}
            leave="transition ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <Listbox.Options className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-none bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
              {wallets.map((wallet, idx) => (
                <Listbox.Option
                  key={idx}
                  className={({ active }) =>
                    classNames(
                      'relative cursor-pointer select-none py-2 pl-10 pr-4',
                      active ? 'bg-gray-100 text-gray-900' : 'text-gray-900'
                    )
                  }
                  value={wallet}
                >
                  {({ selected, active }) => (
                    <>
                      <span className={classNames('block truncate', selected ? 'font-medium' : 'font-normal')}>
                        {wallet.name}
                      </span>
                      {selected && (
                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-600">
                          <CheckIcon className="h-5 w-5" aria-hidden="true" />
                        </span>
                      )}
                    </>
                  )}
                </Listbox.Option>
              ))}
            </Listbox.Options>
          </Transition>
        </div>
      </Listbox>
    </div>
  );
}