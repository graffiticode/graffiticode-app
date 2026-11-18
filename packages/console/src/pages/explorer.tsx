import Image from 'next/image';
import { useState, useEffect, Fragment } from 'react';
import { Disclosure, Menu, Dialog, Transition } from '@headlessui/react';
import Link from 'next/link';
import GraphQLIde from '../components/graphiql';

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
import { usePublicConfig } from '../lib/public-config';

// The installation's image at its fixed URL (served by api/brand-image), and its name.
export function Logo(props) {
  const { brand } = usePublicConfig();
  return (
    <Image src="/logo.png" alt={`${brand.name} logo`} width={30} height={30} unoptimized />
  );
}

const navigation = [
  { name: 'Languages', href: '/languages', current: false },
  { name: 'Items', href: '/items', current: false },
  { name: 'Tasks', href: '/tasks', current: false },
  { name: 'Explorer', href: '/explorer', current: true },
  { name: 'Settings', href: '/integrations', current: false },
]

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function Compiles() {
  const [userId, setUserId] = useState();
  return (
    <div className="w-full h-screen">
      <GraphQLIde />
    </div>
  )
}
