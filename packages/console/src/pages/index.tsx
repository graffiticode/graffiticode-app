import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import useGraffiticodeAuth from "@graffiticode/auth-react";

export default function Home() {
  const { user, loading } = useGraffiticodeAuth();
  const router = useRouter();
  const redirected = useRef(false);
  const [showWelcome, setShowWelcome] = useState(false);

  // On landing, route the user to their last-viewed location:
  //  - logged in + remembered tab → that tab and item (item only if we have one)
  //  - logged in, no remembered tab → Tools
  //  - logged out + remembered tab → that tab (no item; selection was cleared on logout)
  //  - logged out, nothing remembered → stay on the welcome page (current behavior)
  useEffect(() => {
    if (loading || redirected.current || typeof window === "undefined") return;
    const lastTab = localStorage.getItem("graffiticode:selected:lastTab");
    let dest: string | null = null;
    if (user) {
      if (lastTab === "items") {
        const id = localStorage.getItem("graffiticode:selected:itemId");
        dest = id ? `/items/${id}` : "/items";
      } else if (lastTab === "tasks") {
        const id = localStorage.getItem("graffiticode:selected:taskId");
        dest = id ? `/tasks/${id}` : "/tasks";
      } else {
        // "tools", or no/unknown state → Tools tab.
        dest = "/tools";
      }
    } else if (lastTab === "items" || lastTab === "tasks" || lastTab === "tools") {
      dest = `/${lastTab}`;
    }
    if (dest) {
      redirected.current = true;
      router.replace(dest);
    } else {
      setShowWelcome(true);
    }
  }, [user, loading, router]);

  // Avoid flashing the welcome page before we know whether to redirect.
  if (!showWelcome) return null;

  return (
    <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)] gap-4">
      <h1 className="text-2xl font-medium text-gray-700">Welcome to Graffiticode</h1>
      <p className="text-sm text-gray-500 text-justify w-1/2">
        Graffiticode is a platform for deploying smart tools for agents and humans.
        Visit our <a href="https://forum.graffiticode.org/c/support" className="text-blue-600 hover:underline">Support</a> forum to learn more.
        If you are feeling adventurous go straight to <Link href="/tools" className="text-blue-600 hover:underline">Tools</Link> to see what you can make with Graffiticode.
        {!user && (
          <>
            <br /><br />
            New here? Create a free account by signing in with an Ethereum wallet. No blockchain fees required. No credit card required.
          </>
        )}
      </p>
    </div>
  )
}
