"use client";

import { stripHexPrefix } from "@ethereumjs/util";
import { useCallback } from "react";
import { useAccount, useConnect, useSignMessage, useChainId, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { client } from "./auth-client";

async function checkUserExists(address: string): Promise<boolean> {
  const res = await fetch(`/api/user-exists?address=${encodeURIComponent(address)}`);
  if (!res.ok) {
    // Treat lookup failure as "exists" to fail open — avoids blocking real users
    // behind a transient backend hiccup.
    console.warn("[user-exists] check failed, assuming user exists", res.status);
    return true;
  }
  const body = await res.json();
  return !!body.exists;
}

export function useSignInWithEthereum() {
  const { signMessageAsync } = useSignMessage();
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();

  const getAddress = useCallback(
    async (selectedWallet?: any) => {
      if (isConnected) {
        disconnect();
      }
      if (selectedWallet?.provider) {
        (window as any).ethereum = selectedWallet.provider;
      }
      const eth = (window as any).ethereum;
      if (eth) {
        try {
          await eth.request({
            method: "wallet_requestPermissions",
            params: [{ eth_accounts: {} }],
          });
        } catch (error) {
          console.log("Permission request failed, continuing with normal flow");
        }
      }
      const result = await connectAsync({ connector: injected(), chainId });
      return result.accounts[0];
    },
    [isConnected, connectAsync, chainId, disconnect],
  );

  const connectAndCheck = useCallback(
    async (selectedWallet?: any) => {
      const accountAddress = await getAddress(selectedWallet);
      const address = stripHexPrefix(accountAddress).toLowerCase();
      const exists = await checkUserExists(address);
      return { accountAddress, address, exists };
    },
    [getAddress],
  );

  const signInForAddress = useCallback(
    async (address: string, accountAddress: string) => {
      const nonce = await client.ethereum.getNonce({ address });
      const signature = stripHexPrefix(
        await signMessageAsync({
          account: accountAddress as `0x${string}`,
          message: `Nonce: ${nonce}`,
        }),
      );
      const authContext = await client.ethereum.authenticate({ address, nonce, signature });
      return { ...authContext, uid: address };
    },
    [signMessageAsync],
  );

  const signInWithEthereum = useCallback(
    async (selectedWallet?: any) => {
      const { accountAddress, address } = await connectAndCheck(selectedWallet);
      return signInForAddress(address, accountAddress);
    },
    [connectAndCheck, signInForAddress],
  );

  return { signInWithEthereum, connectAndCheck, signInForAddress };
}
