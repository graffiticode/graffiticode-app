import { Fragment } from 'react'
import { Listbox, Transition } from '@headlessui/react'
import { ChevronUpDownIcon } from '@heroicons/react/20/solid'

export interface ClientOption {
  id: string;
  name: string;
}

export const ALL_CLIENT: ClientOption = { id: 'all', name: 'All' };

export const clients: ClientOption[] = [
  ALL_CLIENT,
  { id: 'console', name: 'Console' },
  { id: 'mcp', name: 'MCP' },
  { id: 'front', name: 'Front' },
];

const CLIENT_NAMES: Record<string, string> = {
  all: 'All',
  console: 'Console',
  mcp: 'MCP',
  front: 'Front',
};

export const clientOptionForId = (id: string): ClientOption =>
  ({ id, name: CLIENT_NAMES[id] || id });

export const findClientById = (id: string): ClientOption | undefined =>
  clients.find(c => c.id === id);

interface ClientSelectorProps {
  client: ClientOption;
  setClient: (client: ClientOption) => void;
  dropUp?: boolean;
  clientList?: ClientOption[];
}

export default function ClientSelector({ client, setClient, dropUp = false, clientList = clients }: ClientSelectorProps) {
  return (
    <Listbox value={client} onChange={setClient}>
      <div className="relative w-28 bg-white">
        <Listbox.Button className="relative w-full cursor-default rounded-none ring-1 ring-gray-300 py-2 pl-3 pr-8 text-left focus:outline-none focus-visible:border-gray-500 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-75 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-300 sm:text-sm hover:ring-2">
          <span className="block truncate">{client.name}</span>
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
          <Listbox.Options className={`absolute ${dropUp ? 'bottom-full mb-1' : 'mt-1'} max-h-60 w-full overflow-auto rounded-none bg-white py-1 text-base ring-1 ring-black ring-opacity-25 focus:outline-none sm:text-sm z-[1000]`}>
            {clientList.map((option) => (
              <Listbox.Option
                key={option.id}
                className={({ active }) =>
                  `relative cursor-default select-none py-2 pl-3 pr-4 ${active ? 'bg-gray-200 text-gray-900' : 'text-gray-900'}`
                }
                value={option}
              >
                <span className="block truncate">{option.name}</span>
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  );
}
