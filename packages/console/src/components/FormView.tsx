import useSWR from "swr";
import { Fragment, memo, useCallback, useEffect, useState, useRef } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import {
  XMarkIcon,
  ChevronDoubleLeftIcon,
} from '@heroicons/react/24/outline'
import Editor from './editor';
import SignIn from "./SignIn";
import { loadTasks, getAccessToken } from '../utils/swr/fetchers';
import { isNonEmptyString } from "../utils";
import useGraffiticodeAuth from "@graffiticode/auth-react";
import { FormIFrame } from "./FormIFrame";
import { FormReact } from "./FormReact";
//const reactForms = ["0002"];
const reactForms = [];

interface FormViewProps {
  lang: any;
  id: any;
  setData?: any;
  setNewTask?: any;
  className?: any;
  height?: any;
  // The item's connection: the view shows its stored result through it.
  connectionId?: string | null;
}

export default function FormView({ lang, id, setData, setNewTask, className, height, connectionId = null }: FormViewProps) {
  const [open, setOpen] = useState(true);
  const [task, setTask] = useState();
  const [dataId, setDataId] = useState();
  const { user } = useGraffiticodeAuth();
  const { isValidating, isLoading, data: accessToken } = useSWR(
    user && { user } || null,
    getAccessToken,
  );
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
        <SignIn
          label="Sign in to continue"
        />
        <p className="mt-4 text-sm text-gray-600 text-center max-w-sm">
          New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
        </p>
      </div>
    );
  }

  const { uid } = user;

  const Form = reactForms.includes(lang) && FormReact || FormIFrame;
  return (
    <div className="h-full w-full">
      <Form
        accessToken={accessToken}
        lang={lang}
        id={id}
        data={{}}
        setData={setData}
        className={className || "w-full h-full"}
        height={height || "100%"}
        user={user}
        onFocus={() => {}}
        connectionId={connectionId}
      />
    </div>
  );
}
