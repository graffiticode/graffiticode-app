/*
  This example requires some changes to your config:

  ```
  // tailwind.config.js
  module.exports = {
    // ...
    plugins: [
      // ...
      require('@tailwindcss/forms'),
    ],
  }
  ```
*/
import { useState } from 'react'
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid'
import { Combobox } from '@headlessui/react'
import { getTitle } from '../lib/utils';
import { LANGUAGES, selectLanguages as selectLangs, findLanguageById, type Language } from '../lib/languages';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export function findLanguageByNumber(num: string): Language | undefined {
  return findLanguageById(num);
}

export { selectLangs as selectLanguages };

interface LanguageSelectorProps {
  domain?: string;
  language: Language | null;
  setLanguage: (language: Language | null) => void;
}

export default function LanguageSelector({ domain, language, setLanguage }: LanguageSelectorProps) {
  const [query, setQuery] = useState('')
  const domainLanguages = selectLangs(domain);
  // Normalize the query to ensure it has the leading "L" if it's just numbers
  const normalizedQuery = query && /^\d+$/.test(query) ? `L${query}` : query;
  // Check if query is a valid custom language format (e.g., "L0177" or just "0177")
  const isCustomLanguage = normalizedQuery && /^L\d+$/i.test(normalizedQuery) &&
    !domainLanguages.some(lang => lang.name.toLowerCase() === normalizedQuery.toLowerCase());

  // For custom languages, we want to still show all domain languages in the dropdown
  // When no query is entered, show all domain languages
  // When a query is entered, filter domain languages that match the query
  const filteredLanguages =
        query === ""
          ? domainLanguages
          : domainLanguages.filter(language => {
              // Match "L0177" format directly
              if (language.name.toLowerCase().includes(query.toLowerCase())) {
                return true;
              }

              // Match just numbers (e.g., "0177") against language names (e.g., "L0177")
              if (/^\d+$/.test(query)) {
                return language.name.toLowerCase().includes(`l${query.toLowerCase()}`);
              }

              return false;
            });
  return (
    <Combobox as="div" value={language} onChange={setLanguage}>
      <div className="relative">
        <Combobox.Input
          className="w-full rounded-none border border-gray-300 bg-white py-2 pl-3 pr-10 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 sm:text-sm"
          onChange={(event) => setQuery(event.target.value)}
          displayValue={(language: Language | null) => language?.name || ''}
        />
        <Combobox.Button className="absolute inset-y-0 right-0 flex items-center rounded-none px-2 focus:outline-none">
          <ChevronUpDownIcon className="h-5 w-5 text-gray-400" aria-hidden="true" />
        </Combobox.Button>

        {(filteredLanguages.length > 0 || isCustomLanguage) && (
          <Combobox.Options className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-none bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm">
            {isCustomLanguage && (
              <Combobox.Option
                key="custom"
                value={{ id: 'custom', name: normalizedQuery.toUpperCase(), description: "Custom language", domains: [] }}
                className={({ active }) =>
                  classNames(
                    'relative cursor-default select-none py-2 pl-8 pr-4',
                    active ? 'bg-gray-100 text-gray-900' : 'text-gray-900'
                  )
                }
              >
                {({ active, selected }) => (
                  <>
                    <span className={classNames('block truncate', selected && 'font-semibold')}>
                      {normalizedQuery.toUpperCase()} (Custom)
                    </span>
                    {selected && (
                      <span
                        className={classNames(
                          'absolute inset-y-0 left-0 flex items-center pl-1.5',
                          'text-gray-600'
                        )}
                      >
                        <CheckIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    )}
                  </>
                )}
              </Combobox.Option>
            )}
            {filteredLanguages.map((language) => (
              <Combobox.Option
                key={language.id}
                value={language}
                className={({ active }) =>
                  classNames(
                    'relative cursor-default select-none py-2 pl-8 pr-4',
                    active ? 'bg-gray-100 text-gray-900' : 'text-gray-900'
                  )
                }
              >
                {({ active, selected }) => (
                  <>
                    <span className={classNames('block truncate', selected && 'font-semibold')}>{language.name}</span>

                    {selected && (
                      <span
                        className={classNames(
                          'absolute inset-y-0 left-0 flex items-center pl-1.5',
                          'text-gray-600'
                        )}
                      >
                        <CheckIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                    )}
                  </>
                )}
              </Combobox.Option>
            ))}
          </Combobox.Options>
        )}
      </div>
    </Combobox>
  )
}
