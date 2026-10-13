import React, { useState, useEffect, forwardRef } from 'react';
import useSWR from 'swr';
import { getData } from '../utils/swr/fetchers';
import { Form } from "@graffiticode/l0012";

const isNullOrEmptyObject = (obj) => !obj || Object.keys(obj).length === 0;

export const DataPanel = forwardRef(function DataPanel({
  id,
  user,
  onDataChange,
}: any, ref: any) {
  const [ data, setData ] = useState({});

  const { data: fetchedData, isLoading } = useSWR(
    user && id ? [`getData-${id}`, { user, id }] : null,
    ([_, params]) => getData(params)
  );

  useEffect(() => {
    if (fetchedData) {
      setData(fetchedData);
      onDataChange?.(fetchedData);
    }
  }, [fetchedData]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return (
    isNullOrEmptyObject(data) &&
      <div className="h-full bg-white" /> ||
      <div ref={ref} className="h-full bg-white p-4">
        <Form
          state={{
            apply: () => {},
            data
          }}
        />
      </div>
  );
})
