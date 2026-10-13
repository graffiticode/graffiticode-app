import useGraffiticodeAuth from "@graffiticode/auth-react";
import { useEffect } from "react";
import useSWR from "swr";
import { loadGraphiQL } from '../utils/swr/fetchers';
import SignIn from '../components/SignIn'

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

let token;

export default function GraphiQL() {
  // FIXME add auth to fetch requests.
  const { user } = useGraffiticodeAuth();

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
        <SignIn
          label="Sign in to continue"
        />
        <p className="mt-4 text-sm text-gray-600 text-center max-w-sm">
          New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required.
        </p>
      </div>
    );
  }

  (async (user) => {
    token = user && await user.getToken();
  })(user)
  return <embed src={`${location.origin}/api?auth_token=${token}`} width="100%" height="100%"/>;
}
