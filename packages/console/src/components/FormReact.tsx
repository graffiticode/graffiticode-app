"use client"

import React, { useState, useEffect } from 'react';
import useSWR from 'swr';
import { Form as L0002Form } from "@graffiticode/l0002";
import { createState } from "../lib/state";
import { compile } from '../utils/swr/fetchers';

function isNonNullNonEmptyObject(obj) {
  return (
    typeof obj === "object" &&
      obj !== null &&
      Object.keys(obj).length > 0
  );
}

export const FormReact = ({
  lang,
  id,
  data,
  className,
  height,
  user,
}) => {
  const [ recompile, setRecompile ] = useState(true);
  useEffect(() => {
    // If `id` changes, then recompile.
    if (id) {
      setRecompile(true);
      state.apply({
        type: "reset"
      });
    }
  }, [id]);

  const [ state ] = useState(createState({}, (data, { type, args }) => {
    // console.log("FormReact() apply() type=" + type + " args=" + JSON.stringify(args, null, 2));
    switch (type) {
    case "compile":
      return {
        ...data,
        ...args,
      };
    case "change":
      setRecompile(true);
      return {
        ...data,
        ...args,
      };
    case "reset":
      return {};
    default:
      console.error(false, `Unimplemented action type: ${type}`);
      return data;
    }
  }));

  const resp = useSWR(
    recompile && user && id && {
      user,
      id,
      data: state.data,
    },
    compile
  );

  if (resp.data) {
    state.apply({
      type: "compile",
      args: resp.data.data,
    });
    setRecompile(false);
  }

  let Form;

  switch(lang) {
  case "0002":
    Form = L0002Form;
    break;
  default:
    Form = <div>Internal error: no form defined for language {lang}</div>;
    break;
  }

  return (
    isNonNullNonEmptyObject(state.data) &&
      <Form state={state} /> ||
      <div />
  );
}
