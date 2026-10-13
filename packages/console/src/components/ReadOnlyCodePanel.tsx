import React, { useState, useEffect } from 'react';
import useSWR from 'swr';
import { getTask } from '../utils/swr/fetchers';

type CodeTab = 'source' | 'ast';

export const ReadOnlyCodePanel = ({ id, user, onCodeChange }: any) => {
  const [activeTab, setActiveTab] = useState<CodeTab>('source');

  const { data: taskData, isLoading } = useSWR(
    user && id ? [`getTask-${id}`, { user, id }] : null,
    ([_, params]) => getTask(params)
  );

  // Notify parent when source changes
  useEffect(() => {
    if (taskData?.src) {
      onCodeChange?.(taskData.source);
    } else if (taskData?.code) {
      onCodeChange?.(taskData.code);
    }
  }, [taskData, onCodeChange]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  const displayCode = activeTab === 'source' ? (taskData?.src || "") : (taskData?.code || "");

  return (
    <div className="h-full flex flex-col">
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab('source')}
          className={`px-3 py-1 text-xs font-medium ${
            activeTab === 'source'
              ? 'border-b-2 border-gray-500 text-gray-700'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Source
        </button>
        <button
          onClick={() => setActiveTab('ast')}
          className={`px-3 py-1 text-xs font-medium ${
            activeTab === 'ast'
              ? 'border-b-2 border-gray-500 text-gray-700'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          AST
        </button>
      </div>
      {displayCode ? (
        <div className="flex-1 overflow-auto bg-gray-50">
          <pre className="p-4 overflow-x-auto">
            <code className="text-sm font-mono whitespace-pre-wrap">{displayCode}</code>
          </pre>
        </div>
      ) : (
        <div className="p-4 text-gray-500 bg-gray-50">No code available</div>
      )}
    </div>
  );
};
