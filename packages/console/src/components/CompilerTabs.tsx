import { useState } from 'react'

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

const tabs = [
  { name: 'Code', current: false },
  { name: 'Data', current: true },
];

export function CompilerTabs({ tab: tabName, setTab, onCopy }) {
  const [copied, setCopied] = useState(false);

  const handleClick = (name) => {
    tabs.find(t => t.current).current = false;
    tabs.find(t => t.name === name).current = true;
    setTab(name);
  };

  const handleCopy = () => {
    if (onCopy) {
      onCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div>
      <div className="sm:hidden">
        <label htmlFor="tabs" className="sr-only">
          Select a tab
        </label>
        <select
          id="tabs"
          name="tabs"
          className="block w-full rounded-none py-2 pl-3 pr-10 text-base focus:border-gray-500 focus:outline-none focus:ring-gray-500 sm:text-sm"
        >
          {tabs.map((tab) => (
            tab.name === tabName && tab.current === true &&
              <option key={tab.name}>{tab.name} selected</option> ||
              <option key={tab.name}>{tab.name}</option>
          ))}
        </select>
      </div>
      <div className="hidden sm:block">
        <div className="pt-1">
          <nav className="-mb-px flex justify-between border-b text-xs" aria-label="Tabs">
            <div className="flex">
              {tabs.map((tab) => (
                <a
                  key={tab.name}
                  onClick={() => handleClick(tab.name)}
                  className={classNames(
                    tab.name === tabName
                      ? 'border-gray-500 text-gray-700 font-semibold'
                      : 'border-transparent font-light text-gray-500 hover:border-gray-300 hover:text-gray-700',
                    'whitespace-nowrap border-b py-2 mb-0 mx-2 px-1 cursor-pointer'
                  )}
                  aria-current={tab.current ? 'page' : undefined}
                >
                  {tab.name}
                </a>
              ))}
            </div>
            <button
              className={classNames(
                copied
                  ? 'text-green-500 font-semibold'
                  : 'font-light text-gray-500 hover:text-gray-700 hover:font-semibold',
                'whitespace-nowrap py-2 mb-0 mx-2 px-1'
              )}
              onClick={handleCopy}
            >
              {copied ? (
                <span className="flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 mr-1">
                    <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                  </svg>
                  Copied!
                </span>
              ) : 'Copy All'}
            </button>
          </nav>
        </div>
      </div>
    </div>
  )
}
