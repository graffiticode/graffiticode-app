import Head from 'next/head';
import Image from 'next/image';
import { Fragment, useEffect, useState } from 'react';
import logo from '@/images/logos/logo.png';
import { Disclosure, Menu, Transition } from '@headlessui/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import useGraffiticodeAuth from "@graffiticode/auth-react";
import LanguageSelector from '../components/language-selector';
import MarkSelector from '../components/mark-selector';
import {
  Bars3Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { ChevronDownIcon } from '@heroicons/react/20/solid'
import SignIn from '../components/SignIn'
import { getTitle, getPageTitle } from '../lib/utils';

export function Logo(props) {
  return (
    <Image src={logo} alt='Graffiticode logo' width={30} height={30} unoptimized />
  );
}

interface NavigationItem {
  name: string;
  href: string;
  current: boolean;
  target?: string;
}

const navigation: NavigationItem[] = [
  { name: 'Tools', href: '/tools', current: false },
  { name: 'Items', href: '/items', current: false },
  { name: 'Tasks', href: '/tasks', current: false },
]

const specsMenu = [
  { name: 'Language Spec', href: '/specs?view=spec' },
  { name: 'Usage Guide', href: '/specs?view=usage-guide' },
  { name: 'Code Gen Instructions', href: '/specs?view=instructions' },
]

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function Layout({ children, language, setLanguage, mark, setMark }) {
  const { user } = useGraffiticodeAuth();
  const router = useRouter();
  const pathName = router.pathname.split('/').filter(Boolean)[0] || '';
  const queryDomain = router.query.domain;
  const queryDomainStr = Array.isArray(queryDomain) ? queryDomain[0] : queryDomain;

  // Store domain in sessionStorage when first seen from URL
  if (queryDomainStr && typeof window !== 'undefined') {
    sessionStorage.setItem('graffiticode:domain', queryDomainStr);
  }

  const storedDomain = typeof window !== 'undefined' ? sessionStorage.getItem('graffiticode:domain') : null;
  const rawDomain = queryDomainStr || storedDomain || getTitle();
  const domain = rawDomain.toLowerCase() === 'graffiticode' ? undefined : rawDomain;
  useEffect(() => {
    document.title = getPageTitle();
  }, []);

  // Track the last-selected item / task so the top-nav Items + Tasks links
  // jump straight to their detail URLs instead of bouncing through the index.
  // We also persist the lang of the selection so a stale item from a different
  // language can't hijack the link after the user switches the selector.
  type NavSel = { id: string | null; lang: string | null };
  const [navItem, setNavItem] = useState<NavSel>({ id: null, lang: null });
  const [navTask, setNavTask] = useState<NavSel>({ id: null, lang: null });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setNavItem({
      id: localStorage.getItem('graffiticode:selected:itemId'),
      lang: localStorage.getItem('graffiticode:selected:itemId:lang'),
    });
    setNavTask({
      id: localStorage.getItem('graffiticode:selected:taskId'),
      lang: localStorage.getItem('graffiticode:selected:taskId:lang'),
    });
    const onItem = (e: any) => setNavItem({ id: e.detail?.id || null, lang: e.detail?.lang || null });
    const onTask = (e: any) => setNavTask({ id: e.detail?.id || null, lang: e.detail?.lang || null });
    window.addEventListener('gc:selected-itemId', onItem);
    window.addEventListener('gc:selected-taskId', onTask);
    return () => {
      window.removeEventListener('gc:selected-itemId', onItem);
      window.removeEventListener('gc:selected-taskId', onTask);
    };
  }, []);

  // Remember the last top-level tab the user was on so the root page can route
  // them back here. Unlike the item/task selection keys (cleared on logout), this
  // survives sign-out so a logged-out visitor still lands on their last tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (pathName === 'tools' || pathName === 'items' || pathName === 'tasks') {
      localStorage.setItem('graffiticode:selected:lastTab', pathName);
    }
  }, [pathName]);

  const currentLangId = (language?.name || '').replace(/^L/i, '').padStart(4, '0') || null;
  const resolveNavHref = (item: NavigationItem): string => {
    if (item.name === 'Items' && navItem.id && navItem.lang === currentLangId) return `/items/${navItem.id}`;
    if (item.name === 'Tasks' && navTask.id && navTask.lang === currentLangId) return `/tasks/${navTask.id}`;
    return item.href;
  };
  return (
    <>
      {/*
        This example requires updating your template:

        ```
        <html class="h-full bg-gray-100">
        <body class="h-full">
        ```
      */}
      <Head>
        <title>{getPageTitle()}</title>
      </Head>
      <div className="min-h-full">
        <Disclosure as="nav" className="bg-gray-800 sticky top-0 z-50 shadow-lg">
          {({ open }) => (
            <>
              <div className="px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <Link
                        href="/"
                        className='px-3 py-2 rounded-none text-sm font-medium'
                      >
                        <Logo />
                      </Link>
                    </div>
                    <div className="hidden md:block">
                      <div className="ml-10 flex items-baseline space-x-4">
                        {
                          navigation.map((item) => {
                            const currentName = item.name.toLowerCase();
                            return (
                              <Link
                                key={item.name}
                                href={resolveNavHref(item)}
                                target={item.target}
                                className={classNames(
                                  currentName === pathName
                                    ? 'bg-gray-700 text-white font-semibold ring-1 ring-gray-500'
                                    : 'text-gray-300 hover:text-white hover:bg-gray-700/50',
                                  'px-3 py-2 rounded-none text-sm tracking-wide font-medium'
                                )}
                                aria-current={item.current ? 'page' : undefined}
                              >
                              {item.name}
                              </Link>
                            );
                          })
                        }
                        <Menu as="div" className="relative inline-block text-left">
                          <Menu.Button
                            className={classNames(
                              pathName === 'specs'
                                ? 'bg-gray-700 text-white font-semibold ring-1 ring-gray-500'
                                : 'text-gray-300 hover:text-white hover:bg-gray-700/50',
                              'inline-flex items-center px-3 py-2 rounded-none text-sm tracking-wide font-medium focus:outline-none'
                            )}
                          >
                            Specs
                            <ChevronDownIcon className="ml-1 -mr-1 h-4 w-4" aria-hidden="true" />
                          </Menu.Button>
                          <Transition
                            as={Fragment}
                            enter="transition ease-out duration-100"
                            enterFrom="transform opacity-0 scale-95"
                            enterTo="transform opacity-100 scale-100"
                            leave="transition ease-in duration-75"
                            leaveFrom="transform opacity-100 scale-100"
                            leaveTo="transform opacity-0 scale-95"
                          >
                            <Menu.Items className="absolute left-0 z-10 mt-2 w-56 origin-top-left rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                              <div className="py-1">
                                {specsMenu.map((item) => (
                                  <Menu.Item key={item.name}>
                                    {({ active }) => (
                                      <Link
                                        href={item.href}
                                        className={classNames(
                                          active ? 'bg-gray-100 text-gray-900' : 'text-gray-700',
                                          'block px-4 py-2 text-sm'
                                        )}
                                      >
                                        {item.name}
                                      </Link>
                                    )}
                                  </Menu.Item>
                                ))}
                              </div>
                            </Menu.Items>
                          </Transition>
                        </Menu>
                      </div>
                    </div>
                    { ["items", "tasks", "specs"].includes(pathName) &&
                      <div className="ml-10 flex-shrink-0 w-24 h-24 pt-7">
                        <LanguageSelector domain={domain} language={language} setLanguage={setLanguage} />
                      </div>
                    }
                    { pathName === "items" && mark && setMark &&
                      <div className="ml-4 flex-shrink-0 w-24 h-24 pt-7">
                        <MarkSelector mark={mark} setMark={setMark} />
                      </div>
                    }
                  </div>
                  <div className="hidden md:block">
                    <div className="text-sm font-medium ml-4 flex items-center md:ml-6 space-x-8">
                      {/* <Link
                        href="/integrations"
                        className={classNames(
                          pathName === 'integrations'
                            ? 'text-sky-300'
                            : 'text-gray-300 hover:text-white',
                          'text-sm tracking-wide font-medium'
                        )}
                      >
                        Integrations
                      </Link> */}
                      <a
                        href="https://forum.graffiticode.org/c/support"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-300 hover:text-white text-sm tracking-wide font-medium"
                      >
                        Support
                      </a>
                      <div className="flex items-center gap-2 text-gray-400 hover:text-white">
                        <SignIn />
                      </div>
                    </div>
                  </div>
                  <div className="-mr-2 flex md:hidden">
                    {/* Mobile menu button */}
                    <Disclosure.Button className="bg-gray-800 inline-flex items-center justify-center p-2 rounded-none text-gray-400 hover:text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-white">
                      <span className="sr-only">Open main menu</span>
                      {open ? (
                        <XMarkIcon className="block h-6 w-6" aria-hidden="true" />
                      ) : (
                        <Bars3Icon className="block h-6 w-6" aria-hidden="true" />
                      )}
                    </Disclosure.Button>
                  </div>
                </div>
              </div>

              <Disclosure.Panel className="md:hidden">
                <div className="px-2 pt-2 pb-3 space-y-1 sm:px-3">
                  {navigation.map((item) => (
                    <Disclosure.Button
                      key={item.name}
                      as="a"
                      href={item.href}
                      className={classNames(
                        item.current
                          ? 'bg-gray-700 text-white font-semibold ring-1 ring-gray-500'
                          : 'text-gray-300 hover:text-white hover:bg-gray-700/50',
                        'block px-3 py-2 rounded-none text-base font-medium'
                      )}
                      aria-current={item.current ? 'page' : undefined}
                    >
                      {item.name}
                    </Disclosure.Button>
                  ))}
                  {specsMenu.map((item) => (
                    <Disclosure.Button
                      key={item.name}
                      as="a"
                      href={item.href}
                      className="text-gray-300 hover:text-white block px-3 py-2 rounded-none text-base font-medium"
                    >
                      {item.name}
                    </Disclosure.Button>
                  ))}
                  {/* <Disclosure.Button
                    as="a"
                    href="/integrations"
                    className="text-gray-300 hover:text-white block px-3 py-2 rounded-none text-base font-medium"
                  >
                    Integrations
                  </Disclosure.Button> */}
                  <Disclosure.Button
                    as="a"
                    href="https://forum.graffiticode.org/c/support"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-300 hover:text-white block px-3 py-2 rounded-none text-base font-medium"
                  >
                    Support
                  </Disclosure.Button>
                </div>
                <div className="pt-4 pb-3 border-t border-gray-700">
                  <div className="flex items-center px-5">
                    <div className="flex items-center gap-2 text-gray-400 hover:text-white">
                      <SignIn />
                    </div>
                  </div>
                </div>
              </Disclosure.Panel>
            </>
          )}
        </Disclosure>
        <main className="pt-2">
          <div className="py-2">
            { children }
          </div>
        </main>
      </div>
    </>
  )
}
