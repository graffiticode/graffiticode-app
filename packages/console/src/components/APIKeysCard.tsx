import { TrashIcon, PlusIcon } from "@heroicons/react/24/outline";
import { getIdToken } from "firebase/auth";
import { collection, orderBy, query, where } from "firebase/firestore";
import { useFirestore, useFirestoreCollectionData, useUser } from "reactfire";
import moment from "moment";
import { client } from "../lib/auth";
import NewAPIKeyDialog from "./NewAPIKeyDialog";
import { useState, useEffect } from "react";
import axios from "axios";

function APIKeyListItem({ user, apiKey, isPending }) {
  const buildHandleDelete = (apiKey) => async () => {
    const { id } = apiKey;
    const token = await getIdToken(user);
    await client.apiKeys.remove({ token, id });
  };
  return (
    <li className="flex items-center justify-between border border-gray-300 px-4 py-1 rounded-none">
      <div className="flex flex-col">
        <span>{apiKey.id}</span>
        <small className="mb-2 text-sm text-neutral-500 dark:text-neutral-400 font-light italic">
          Created {moment(apiKey.createdAt.toDate()).format("MMMM Do YYYY, h:mm:ss a")}
        </small>
      </div>
      <div className="relative group">
        <button
          type="button"
          className={`inline-block rounded-none ${isPending ? 'opacity-30 cursor-not-allowed' : ''}`}
          onClick={isPending ? undefined : buildHandleDelete(apiKey)}
          disabled={isPending}>
          <TrashIcon className={`h-5 w-5 ${isPending ? 'text-gray-400' : 'text-red-500 hover:text-red-700'}`} />
        </button>
        <span className="absolute right-full top-1/2 -translate-y-1/2 mr-2 px-2 py-1 text-xs text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          {isPending ? "Verifying..." : "Delete API key"}
        </span>
      </div>
    </li>
  );
}

export default function APIKeysCard() {
  const firestore = useFirestore();
  const { data: user } = useUser();
  const [newApiKey, setNewApiKey] = useState();
  const [protectedKeyIds, setProtectedKeyIds] = useState<Set<string>>(new Set());
  const [initialFetchDone, setInitialFetchDone] = useState(false);
  const [verifiedKeyIds, setVerifiedKeyIds] = useState<Set<string>>(new Set());

  // Only create query when user is available
  const apiKeysQuery = user?.uid
    ? query(
        collection(firestore, "api-keys"),
        where("uid", "==", user.uid),
        orderBy("createdAt"))
    : null;
  const { status, data: apiKeys } = useFirestoreCollectionData(apiKeysQuery, { idField: "id" });

  // Fetch integration settings to get protected API key IDs
  // Re-fetch when apiKeys changes (e.g., new key added)
  // Delay on updates to allow integration save to complete after API key creation
  useEffect(() => {
    if (user?.uid && apiKeys) {
      const fetchProtectedIds = () => {
        getIdToken(user)
          .then(token => axios.get('/api/integrations', { headers: { Authorization: token } }))
          .then(response => {
            const protectedIds = new Set<string>();
            // Front integration API key
            if (response.data?.front?.apiKeyId) {
              protectedIds.add(response.data.front.apiKeyId);
            }
            setProtectedKeyIds(protectedIds);
            // Mark all current keys as verified
            const verified = new Set<string>(apiKeys.map((k: any) => k.id));
            setVerifiedKeyIds(verified);
            setInitialFetchDone(true);
          })
          .catch(err => console.error('Error fetching integrations:', err));
      };

      // Fetch immediately on first load, delay on subsequent updates
      if (!initialFetchDone) {
        fetchProtectedIds();
      } else {
        const timeoutId = setTimeout(fetchProtectedIds, 1000);
        return () => clearTimeout(timeoutId);
      }
    }
  }, [user?.uid, apiKeys, initialFetchDone]);

  const handleCreate = async () => {
    const userToken = await getIdToken(user);
    const apiKey = await client.apiKeys.create(userToken);
    setNewApiKey(apiKey);
    // Key creation happens against the auth service, so nothing server-side in
    // this repo would otherwise see it. Fire-and-forget; never blocks the UI.
    void fetch("/api/beacon/api-key-created", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: user.uid, source: "settings" }),
    }).catch(() => {});
  };

  if (!user?.uid || status === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  } else if (status === "error") {
    return <div>
      <h1>Error</h1>
      <span className="mb-4 rounded-none bg-danger-100 px-6 py-5 text-base text-danger-700"
        role="alert">
        Opps! Something went wrong.
      </span>
    </div>;
  }

  return (
    <div className="overflow-hidden grid grid-col-1">
      <ul className="list-disc space-y-2 mb-2">
        {apiKeys
          .filter(apiKey => !protectedKeyIds.has(apiKey.id))
          .map(apiKey => (
            <APIKeyListItem
              key={apiKey.id}
              user={user}
              apiKey={apiKey}
              isPending={!verifiedKeyIds.has(apiKey.id)}
            />
          ))}
      </ul>
      <div>
      <button
        type="button"
        className="inline-flex items-center px-3 py-2 bg-gray-100 border border-gray-300 rounded-none text-sm text-gray-700 hover:bg-gray-200"
        onClick={handleCreate}>
        <PlusIcon className="h-4 w-4 mr-1" />
        Create
      </button>
      </div>
      <NewAPIKeyDialog apiKey={newApiKey} />
    </div>
  )
}
