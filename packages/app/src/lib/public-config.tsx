"use client";

// The installation's public configuration in the browser (installations plan,
// P3, slice 2). ConfigGate loads /api/config and validates it before rendering
// anything below it, so no provider or client (Firebase, Privy, the auth
// service) initializes until the installation's settings are known. A failed,
// malformed or unsupported response shows a configuration error and
// initializes nothing: there are no built-in settings to fall back to.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { loadPublicConfig, type PublicConfig } from "@graffiticode-app/core/profile/public-config";

const PublicConfigContext = createContext<PublicConfig | null>(null);

export function usePublicConfig(): PublicConfig {
  const config = useContext(PublicConfigContext);
  if (!config) throw new Error("usePublicConfig() outside ConfigGate: the installation's configuration isn't loaded.");
  return config;
}

type State = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; config: PublicConfig };

export function ConfigGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadPublicConfig().then(r => {
      if (!live) return;
      if (r.ok) {
        // Observable: which installation this page initialized as.
        document.documentElement.dataset.installation = r.config.installation.id;
        setState({ status: "ready", config: r.config });
      } else {
        document.documentElement.dataset.installationError = "1";
        setState({ status: "error", error: (r as { ok: false; error: string }).error });
      }
    });
    return () => { live = false; };
  }, []);
  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center" data-config="loading">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center p-8" data-config="error" role="alert">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-gray-900">This site couldn&rsquo;t load its configuration</h1>
          <p className="mt-2 text-sm text-gray-600">Reload the page to try again. If it keeps happening, the site isn&rsquo;t configured correctly.</p>
          <p className="mt-4 font-mono text-xs text-gray-400">{state.error}</p>
        </div>
      </div>
    );
  }
  return <PublicConfigContext.Provider value={state.config}>{children}</PublicConfigContext.Provider>;
}
