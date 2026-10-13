"use client";

import { useState } from "react";
import { useGraffiticodeAuth, useEmailSignIn } from "@graffiticode/auth-react";
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

interface PendingWalletSignup {
  address: string;
  accountAddress: string;
}

export function SignIn({ label = "Sign in", className }: SignInComponentProps) {
  const { loading, user, beginEthereumSignIn, confirmEthereumSignIn, signOut } =
    useGraffiticodeAuth();
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
    // The confirm dialog and the auth-method dialog can't co-exist — having both
    // open at the same z-index causes the underlying one to fire onClose, which
    // would call resetEmailFlow and wipe the pending sign-up state. Close it
    // ourselves without routing through that reset handler.
    if (result === "needs-confirm") {
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

  if (user) {
    return (
      <button
        type="button"
        onClick={signOut}
        disabled={loading}
        className={className || "text-sm text-gray-600 underline"}
      >
        Sign out
      </button>
    );
  }

  return (
    <>
      <button className={className} disabled={loading} onClick={handleSignInClick}>
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
        identifier={pendingWalletSignup?.address ?? ""}
        kind="wallet"
        onConfirm={handleConfirmWalletSignup}
        onCancel={handleCancelWalletSignup}
        confirming={confirmingWalletSignup}
      />

      <NewAccountConfirmDialog
        isOpen={awaitingSignupConfirm}
        identifier={pendingEmail ?? ""}
        kind="email"
        onConfirm={handleConfirmEmailSignup}
        onCancel={handleCancelEmailSignup}
        confirming={codeVerifying}
        error={codeError}
      />
    </>
  );
}
