import useSWR from "swr";
import { useRouter } from 'next/router';
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
import SignIn from '../components/SignIn'
import { useEffect } from 'react';
import Link from 'next/link';
import FormView from '../components/FormView';
import LanguageSelector from '../components/language-selector';
import MarkSelector, { marks } from '../components/mark-selector';
import useSwr from 'swr';
import useLocalStorage from '../hooks/use-local-storage';
import useGraffiticodeAuth from "@graffiticode/auth-react";
import { getPageTitle } from '../lib/utils';

const parseQuery =
      query => ({
        lang: query.lang,
        id: query.id && query.id.split(/[ ]/g).join("+")
      });

export default function Form() {
  const router = useRouter();
  const { lang, id } = parseQuery(router.query);
  const [mark, setMark] = useLocalStorage("graffiticode:items:mark", marks[0]);
  if (id === undefined) {
    return <div />;
  }
  return (
    <>
      <Head>
        <title>{getPageTitle()}</title>
      </Head>
      <div className="h-screen w-full overflow-hidden">
          <div className="h-full w-full">
            <FormView lang={lang} id={id} className="w-full h-full"/>
          </div>
      </div>
    </>
  )
}
