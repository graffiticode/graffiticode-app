import Head from 'next/head'
import Image from 'next/image';
import { Fragment, useState } from 'react'
import { Disclosure, Menu, Dialog, Transition } from '@headlessui/react'
import {
  CalendarIcon,
  ChartBarIcon,
  FolderIcon,
  HomeIcon,
  InboxIcon,
  Bars3Icon,
  UsersIcon,
  XMarkIcon,
  BellIcon,
} from '@heroicons/react/24/outline'
import SignIn from '../../components/SignIn'
import { useEffect } from 'react';
import Link from 'next/link';
import Gallery from '../../components/gallery';
import useSwr from 'swr';
import useLocalStorage from '../../hooks/use-local-storage';
import { getPageTitle } from '../../lib/utils';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function Tasks({ language, mark, setMark, client, setClient, sort, setSort, dateFilter, setDateFilter }) {
  useEffect(() => {
    document.title = getPageTitle();
  }, []);
  const lang = language.name.slice(1);
  return (
    <div className="max-w-full mx-auto py-0 sm:px-6 lg:px-8">
      <Gallery
        lang={lang}
        mark={mark}
        setMark={setMark}
        client={client}
        setClient={setClient}
        sort={sort}
        setSort={setSort}
        dateFilter={dateFilter}
        setDateFilter={setDateFilter}
      />
    </div>
  )
}
