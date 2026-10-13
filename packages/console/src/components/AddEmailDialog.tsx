import { Fragment, useEffect, useState } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useVerifyEmail } from '../hooks/use-verify-email';
import { useLinkedEmails } from '../hooks/use-linked-emails';

interface AddEmailDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (email: string) => void;
}

type Step = 'email' | 'code' | 'conflict';
type ConflictReason = 'self' | 'other';

export default function AddEmailDialog({ isOpen, onClose, onAdded }: AddEmailDialogProps) {
  const verify = useVerifyEmail();
  const { checkEmail, addEmail } = useLinkedEmails();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conflictReason, setConflictReason] = useState<ConflictReason | null>(null);
  const [conflictEmail, setConflictEmail] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      verify.reset();
      setStep('email');
      setEmail('');
      setCode('');
      setAdding(false);
      setChecking(false);
      setConflictReason(null);
      setConflictEmail(null);
      setErrorMsg(null);
    }
  }, [isOpen, verify]);

  const handleSubmitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setChecking(true);
    try {
      const check = await checkEmail(trimmed);
      if (check.available === false) {
        setConflictEmail(trimmed);
        setConflictReason(check.ownedBy);
        setStep('conflict');
        return;
      }
      await verify.sendCode(trimmed);
      setStep('code');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to send code');
    } finally {
      setChecking(false);
    }
  };

  const handleSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setAdding(true);
    try {
      const accessToken = await verify.verifyCode(trimmed);
      const result = await addEmail(accessToken);
      if (result.success) {
        await verify.cleanup();
        onAdded(result.email || verify.pendingEmail || email);
        return;
      }
      if (result.conflict) {
        setConflictEmail(verify.pendingEmail || email);
        setConflictReason(result.conflict);
        setStep('conflict');
      } else {
        setErrorMsg(result.error || 'Failed to add email');
      }
    } catch {
      // codeError surfaces via prop
    } finally {
      setAdding(false);
    }
  };

  const handleClose = async () => {
    await verify.cleanup();
    onClose();
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={handleClose}>
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
                  Add email
                  <button
                    type="button"
                    className="text-gray-400 hover:text-gray-500"
                    onClick={handleClose}
                  >
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </Dialog.Title>

                <div className="mt-4 space-y-3">
                  {step === 'email' && (
                    <form onSubmit={handleSubmitEmail} className="space-y-3">
                      <p className="text-sm text-gray-500">
                        Enter the email you want to add. We&apos;ll send a 6-digit code
                        to verify ownership.
                      </p>
                      {(verify.emailError || errorMsg) && (
                        <div className="rounded-none bg-red-50 p-3 text-sm text-red-700">
                          {verify.emailError || errorMsg}
                        </div>
                      )}
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="email@example.com"
                        required
                        autoFocus
                        disabled={verify.sending || checking}
                        className="w-full rounded-none border border-gray-300 px-4 py-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-0 disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={verify.sending || checking || !email.trim()}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {verify.sending || checking ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-700"></div>
                            <span>{checking ? 'Checking…' : 'Sending…'}</span>
                          </>
                        ) : (
                          <span>Send code</span>
                        )}
                      </button>
                    </form>
                  )}

                  {step === 'code' && (
                    <form onSubmit={handleSubmitCode} className="space-y-3">
                      <p className="text-sm text-gray-500">
                        We sent a code to{' '}
                        <span className="font-medium text-gray-700">{verify.pendingEmail}</span>.
                      </p>
                      {(verify.codeError || errorMsg) && (
                        <div className="rounded-none bg-red-50 p-3 text-sm text-red-700">
                          {verify.codeError || errorMsg}
                        </div>
                      )}
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))}
                        placeholder="123456"
                        required
                        autoFocus
                        disabled={verify.verifying || adding}
                        className="w-full rounded-none border border-gray-300 px-4 py-3 text-center text-lg tracking-widest font-mono focus:border-gray-500 focus:outline-none focus:ring-0 disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={verify.verifying || adding || !code.trim()}
                        className="w-full flex items-center justify-center gap-3 rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {verify.verifying || adding ? (
                          <>
                            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-700"></div>
                            <span>{adding ? 'Adding…' : 'Verifying…'}</span>
                          </>
                        ) : (
                          <span>Add email</span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCode('');
                          setStep('email');
                        }}
                        disabled={verify.verifying || adding}
                        className="w-full text-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      >
                        Use a different email
                      </button>
                    </form>
                  )}

                  {step === 'conflict' && (
                    <div className="space-y-3 text-sm text-gray-600">
                      {conflictReason === 'self' ? (
                        <p>
                          <span className="font-medium">{conflictEmail}</span> is already
                          linked to this account. No need to add it again.
                        </p>
                      ) : (
                        <>
                          <p>
                            <span className="font-medium">{conflictEmail}</span> is already
                            in use on another Graffiticode account.
                          </p>
                          <p>
                            Only one account can use a given email. Sign in to the other
                            account to remove it first, or contact support if you can&apos;t
                            access it.
                          </p>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={handleClose}
                        className="w-full rounded-none border border-gray-300 bg-white px-4 py-3 text-gray-700 hover:bg-gray-50"
                      >
                        Close
                      </button>
                    </div>
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
