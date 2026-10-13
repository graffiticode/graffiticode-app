import { useState, Fragment } from "react";
import { Menu, Transition } from "@headlessui/react";
import Link from "next/link";
import useSWR from "swr";
import {
  ChevronDownIcon,
  CreditCardIcon,
  UserCircleIcon,
  Cog6ToothIcon,
  ArrowRightOnRectangleIcon,
} from "@heroicons/react/24/outline";
import useGraffiticodeAuth from "@graffiticode/auth-react";
import { useEmailSignIn } from "@graffiticode/auth-react";
import { useConsoleSignOut } from "../hooks/use-console-sign-out";
import WalletSelectionDialog from "./WalletSelectionDialog";
import AuthMethodDialog from "./AuthMethodDialog";
import NewAccountConfirmDialog from "./NewAccountConfirmDialog";

interface SignInComponentProps {
  label?: string | React.ReactNode;
  className?: string;
}

interface Wallet {
  name: string;
  provider: any;
}

const fetchUserData = async ({ user }) => {
  const token = await user.getToken();
  const response = await fetch(`/api/user/${user.uid}`, {
    headers: { 'Authorization': token },
  });
  if (response.ok) {
    return response.json();
  }
  return null;
};

interface PendingWalletSignup {
  address: string;
  accountAddress: string;
}

export default function SignInComponent({ label = "Sign in", className }: SignInComponentProps) {
  const { loading, user, beginEthereumSignIn, confirmEthereumSignIn } = useGraffiticodeAuth();
  const signOut = useConsoleSignOut();
  const {
    sendCode,
    verifyAndSignIn,
    confirmAndCreateAccount,
    cancelSignup,
    reset: resetEmailFlow,
    sending: emailSending,
    verifying: codeVerifying,
    emailError,
    codeError,
    awaitingSignupConfirm,
    pendingEmail,
  } = useEmailSignIn();
  const [showAuthMethodDialog, setShowAuthMethodDialog] = useState(false);
  const [showWalletDialog, setShowWalletDialog] = useState(false);
  const [pendingWalletSignup, setPendingWalletSignup] = useState<PendingWalletSignup | null>(null);
  const [confirmingWalletSignup, setConfirmingWalletSignup] = useState(false);

  // Fetch user profile data from Firestore
  const { data: userData } = useSWR(
    user ? `user-profile-${user.uid}` : null,
    () => fetchUserData({ user }),
    { revalidateOnFocus: false }
  );

  const handleSignInClick = () => {
    resetEmailFlow();
    setShowAuthMethodDialog(true);
  };

  const handleCloseAuthDialog = () => {
    setShowAuthMethodDialog(false);
    resetEmailFlow();
  };

  const handleSelectEthereum = () => {
    setShowAuthMethodDialog(false);
    setShowWalletDialog(true);
  };

  const handleSubmitEmail = async (email: string) => {
    await sendCode(email);
  };

  const handleSubmitCode = async (code: string) => {
    const result = await verifyAndSignIn(code);
    // The confirm dialog and the auth-method dialog can't co-exist — having
    // both Headless UI Dialogs open at the same z-index causes the underlying
    // one to fire its onClose handler, which would call resetEmailFlow and
    // wipe the pending sign-up state. Close it ourselves without routing
    // through that reset handler.
    if (result === 'needs-confirm') {
      setShowAuthMethodDialog(false);
    }
    return result;
  };

  const handleConfirmEmailSignup = async () => {
    try {
      await confirmAndCreateAccount();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCancelEmailSignup = async () => {
    try {
      await cancelSignup();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSignIn = async (wallet: Wallet | null) => {
    try {
      const pending = await beginEthereumSignIn(wallet);
      if (pending && pending.needsSignupConfirm) {
        setPendingWalletSignup({ address: pending.address, accountAddress: pending.accountAddress });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleWalletSelect = (wallet: Wallet) => {
    handleSignIn(wallet);
  };

  const handleConfirmWalletSignup = async () => {
    if (!pendingWalletSignup) return;
    setConfirmingWalletSignup(true);
    try {
      await confirmEthereumSignIn({ ...pendingWalletSignup, needsSignupConfirm: true });
      setPendingWalletSignup(null);
    } catch (err) {
      console.error(err);
    } finally {
      setConfirmingWalletSignup(false);
    }
  };

  const handleCancelWalletSignup = () => {
    setPendingWalletSignup(null);
  };

  // Get display name for the user menu button
  const getUserDisplayName = () => {
    // Check Firestore profile data first
    if (userData?.profileImageUrl) {
      return (
        <img
          src={userData.profileImageUrl}
          alt="Profile"
          className="h-6 w-6 rounded-full object-cover"
        />
      );
    }
    // Fall back to Firebase Auth photoURL
    if (user.photoURL) {
      return (
        <img
          src={user.photoURL}
          alt="Profile"
          className="h-6 w-6 rounded-full object-cover"
        />
      );
    }
    // Check Firestore name
    if (userData?.name) {
      return userData.name;
    }
    // Fall back to Firebase Auth displayName
    if (user.displayName) {
      return user.displayName;
    }
    // Fall back to truncated UID
    return `${user.uid.slice(0, 7)}...${user.uid.slice(33)}`;
  };

  if (user) {
    return (
      <Menu as="div" className="relative inline-block text-left">
        <div>
          <Menu.Button className={`inline-flex justify-center items-center w-full ${className}`}>
            {getUserDisplayName()}
            <ChevronDownIcon className="ml-2 -mr-1 h-4 w-4" aria-hidden="true" />
          </Menu.Button>
        </div>

        <Transition
          as={Fragment}
          enter="transition ease-out duration-100"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-in duration-75"
          leaveFrom="transform opacity-100 scale-100"
          leaveTo="transform opacity-0 scale-95"
        >
          <Menu.Items className="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
            <div className="px-1 py-1">
              <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-200">
                Account
              </div>
              <Menu.Item>
                {({ active }) => (
                  <Link
                    href="/profile"
                    className={`${
                      active ? 'bg-gray-100 text-gray-900' : 'text-gray-700'
                    } group flex items-center px-4 py-2 text-sm mt-1`}
                  >
                    <UserCircleIcon
                      className="mr-3 h-4 w-4 text-gray-400 group-hover:text-gray-500"
                      aria-hidden="true"
                    />
                    Profile
                  </Link>
                )}
              </Menu.Item>
              <Menu.Item>
                {({ active }) => (
                  <Link
                    href="/billing"
                    className={`${
                      active ? 'bg-gray-100 text-gray-900' : 'text-gray-700'
                    } group flex items-center px-4 py-2 text-sm`}
                  >
                    <CreditCardIcon
                      className="mr-3 h-4 w-4 text-gray-400 group-hover:text-gray-500"
                      aria-hidden="true"
                    />
                    Billing
                  </Link>
                )}
              </Menu.Item>
              <Menu.Item>
                {({ active }) => (
                  <Link
                    href="/settings"
                    className={`${
                      active ? 'bg-gray-100 text-gray-900' : 'text-gray-700'
                    } group flex items-center px-4 py-2 text-sm`}
                  >
                    <Cog6ToothIcon
                      className="mr-3 h-4 w-4 text-gray-400 group-hover:text-gray-500"
                      aria-hidden="true"
                    />
                    Settings
                  </Link>
                )}
              </Menu.Item>
              <div className="border-t border-gray-200 my-1"></div>
              <Menu.Item>
                {({ active }) => (
                  <button
                    onClick={signOut}
                    disabled={loading}
                    className={`${
                      active ? 'bg-gray-100 text-gray-900' : 'text-gray-700'
                    } group flex items-center w-full text-left px-4 py-2 text-sm`}
                  >
                    <ArrowRightOnRectangleIcon
                      className="mr-3 h-4 w-4 text-gray-400 group-hover:text-gray-500"
                      aria-hidden="true"
                    />
                    Sign out
                  </button>
                )}
              </Menu.Item>
            </div>
          </Menu.Items>
        </Transition>
      </Menu>
    );
  } else {
    return (
      <>
        <button
          className={className}
          disabled={loading}
          onClick={handleSignInClick}
        >
          {label}
        </button>

        <AuthMethodDialog
          isOpen={showAuthMethodDialog}
          onClose={handleCloseAuthDialog}
          onAuthSuccess={handleCloseAuthDialog}
          onSelectEthereum={handleSelectEthereum}
          onSubmitEmail={handleSubmitEmail}
          onSubmitCode={handleSubmitCode}
          emailSending={emailSending}
          emailError={emailError}
          codeVerifying={codeVerifying}
          codeError={codeError}
        />

        <WalletSelectionDialog
          isOpen={showWalletDialog}
          onClose={() => setShowWalletDialog(false)}
          onSelectWallet={handleWalletSelect}
        />

        <NewAccountConfirmDialog
          isOpen={!!pendingWalletSignup}
          identifier={pendingWalletSignup?.address ?? ''}
          kind="wallet"
          onConfirm={handleConfirmWalletSignup}
          onCancel={handleCancelWalletSignup}
          confirming={confirmingWalletSignup}
        />

        <NewAccountConfirmDialog
          isOpen={awaitingSignupConfirm}
          identifier={pendingEmail ?? ''}
          kind="email"
          onConfirm={handleConfirmEmailSignup}
          onCancel={handleCancelEmailSignup}
          confirming={codeVerifying}
          error={codeError}
        />
      </>
    );
  }
}
