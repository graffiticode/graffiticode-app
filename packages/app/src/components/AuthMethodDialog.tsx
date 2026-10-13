"use client";

import { Fragment, useState, useEffect } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { XMarkIcon, EnvelopeIcon } from "@heroicons/react/24/outline";

interface AuthMethodDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectEthereum: () => void;
  onSubmitEmail: (email: string) => Promise<void>;
  onSubmitCode: (code: string) => Promise<"signed-in" | "needs-confirm" | void>;
  onAuthSuccess?: () => void;
  emailSending?: boolean;
  emailError?: string | null;
  codeVerifying?: boolean;
  codeError?: string | null;
  variant?: "default" | "claim";
}

type Step = "method" | "email" | "code";

export default function AuthMethodDialog({
  isOpen,
  onClose,
  onSelectEthereum,
  onSubmitEmail,
  onSubmitCode,
  onAuthSuccess,
  emailSending = false,
  emailError = null,
  codeVerifying = false,
  codeError = null,
  variant = "default",
}: AuthMethodDialogProps) {
  const [step, setStep] = useState<Step>("method");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentToEmail, setSentToEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setStep("method");
      setEmail("");
      setCode("");
      setSentToEmail(null);
    }
  }, [isOpen]);

  const isClaim = variant === "claim";
  const title = isClaim ? "Save your items" : "Sign in to Graffiticode";
  const leadCopy = isClaim
    ? "Sign in to keep these items permanently."
    : "New here? Create a free account by signing in. No blockchain fees. No credit card required.";
  const ethereumLabel = isClaim ? "Sign in with Ethereum Wallet" : "Continue with Ethereum Wallet";
  const emailCaption = isClaim ? "(creates a new Graffiticode account)" : null;

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    try {
      await onSubmitEmail(trimmed);
      setSentToEmail(trimmed);
      setStep("code");
    } catch {
      // emailError surfaces via prop
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await onSubmitCode(trimmed);
      if (result !== "needs-confirm") {
        onAuthSuccess?.();
      }
    } catch {
      // codeError surfaces via prop
    }
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
                <Dialog.Title
                  as="h3"
                  className="text-lg font-medium leading-6 text-gray-900 flex justify-between items-center"
                >
                  {title}
                  <button
                    type="button"
                    className="text-gray-400 hover:text-gray-500"
                    onClick={onClose}
                  >
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </Dialog.Title>

                <div className="mt-4 space-y-3">
                  {step === "method" && (
                    <>
                      <p className="text-sm text-gray-500 text-center">{leadCopy}</p>

                      <button
                        type="button"
                        onClick={onSelectEthereum}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <svg
                          className="h-5 w-5"
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path d="M12 2L4 12L12 16L20 12L12 2Z" fill="#627EEA" />
                          <path d="M12 16L4 12L12 22L20 12L12 16Z" fill="#627EEA" opacity="0.6" />
                          <path d="M12 2L4 12L12 9.5L20 12L12 2Z" fill="#627EEA" opacity="0.3" />
                        </svg>
                        <span>{ethereumLabel}</span>
                      </button>

                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-gray-300" />
                        </div>
                        <div className="relative flex justify-center text-sm">
                          <span className="bg-white px-2 text-gray-500">or</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setStep("email")}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <EnvelopeIcon className="h-5 w-5 text-gray-600" />
                        <span>Continue with Email</span>
                      </button>

                      {emailCaption && (
                        <p className="text-xs text-gray-500 text-center">{emailCaption}</p>
                      )}
                    </>
                  )}

                  {step === "email" && (
                    <form onSubmit={handleEmailSubmit} className="space-y-3">
                      <p className="text-sm text-gray-500 text-center">
                        Enter your email to receive a sign-in code.
                      </p>
                      {emailError && (
                        <div className="rounded-none bg-red-50 p-3 text-sm text-red-700">
                          {emailError}
                        </div>
                      )}
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="email@example.com"
                        required
                        autoFocus
                        disabled={emailSending}
                        className="w-full rounded-none border border-gray-300 px-4 py-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-0 disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={emailSending || !email.trim()}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {emailSending ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-700"></div>
                            <span>Sending...</span>
                          </>
                        ) : (
                          <span>Send code</span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setStep("method")}
                        disabled={emailSending}
                        className="w-full text-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Back
                      </button>
                    </form>
                  )}

                  {step === "code" && (
                    <form onSubmit={handleCodeSubmit} className="space-y-3">
                      <p className="text-sm text-gray-500 text-center">
                        We sent a code to{" "}
                        <span className="font-medium text-gray-700">{sentToEmail}</span>.
                        <br />
                        Enter it below to finish signing in.
                      </p>
                      {codeError && (
                        <div className="rounded-none bg-red-50 p-3 text-sm text-red-700">
                          {codeError}
                        </div>
                      )}
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                        placeholder="123456"
                        required
                        autoFocus
                        disabled={codeVerifying}
                        className="w-full rounded-none border border-gray-300 px-4 py-3 text-center text-lg tracking-widest font-mono focus:border-gray-500 focus:outline-none focus:ring-0 disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={codeVerifying || !code.trim()}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {codeVerifying ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-700"></div>
                            <span>Signing in...</span>
                          </>
                        ) : (
                          <span>Sign in</span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCode("");
                          setStep("email");
                        }}
                        disabled={codeVerifying}
                        className="w-full text-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Use a different email
                      </button>
                    </form>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
