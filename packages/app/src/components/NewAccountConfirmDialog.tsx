"use client";

import { Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";

interface NewAccountConfirmDialogProps {
  isOpen: boolean;
  identifier: string;
  kind: "email" | "wallet";
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  error?: string | null;
}

export default function NewAccountConfirmDialog({
  isOpen,
  identifier,
  kind,
  onConfirm,
  onCancel,
  confirming = false,
  error = null,
}: NewAccountConfirmDialogProps) {
  const subject = kind === "email" ? "email address" : "wallet";
  const display = kind === "wallet" ? `0x${identifier.replace(/^0x/i, "")}` : identifier;

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onCancel}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/25" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-none bg-white p-6 text-left align-middle shadow-xl transition-all">
                <Dialog.Title as="h3" className="text-lg font-medium leading-6 text-gray-900">
                  Create a new account?
                </Dialog.Title>

                <div className="mt-4 space-y-3 text-sm text-gray-600">
                  <p>No Graffiticode account exists for this {subject}:</p>
                  <p className="rounded-none bg-gray-50 px-3 py-2 font-mono text-xs break-all text-gray-800">
                    {display}
                  </p>
                  <p>Continue to create a new account.</p>
                  {error && (
                    <div className="rounded-none bg-red-50 p-3 text-sm text-red-700">{error}</div>
                  )}
                </div>

                <div className="mt-6 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={confirming}
                    className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {confirming ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-700"></div>
                        <span>Creating account...</span>
                      </>
                    ) : (
                      <span>Create new account</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={confirming}
                    className="w-full text-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
