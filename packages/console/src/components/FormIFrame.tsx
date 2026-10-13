import { Fragment, memo, useCallback, useEffect, useState, useRef } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import {
  XMarkIcon,
  ChevronDoubleLeftIcon,
} from '@heroicons/react/24/outline'
import Editor from './editor';
import SignIn from "./SignIn";
import { isNonEmptyString } from "../utils";
import useGraffiticodeAuth from "@graffiticode/auth-react";

const useTaskIdFormUrl = ({ accessToken, lang, id, origin, connectionId = null }) => {
  if (!id) {
    return "";
  }
  const [ protocol, host ] =
        document.location.host.indexOf("localhost") === 0 && ["http", "localhost:3100"] ||
        ["https", "api.graffiticode.org"];
  const params = new URLSearchParams();
  if (accessToken) {
    params.set("access_token", accessToken);
  }
  if (origin) {
    params.set("origin", origin);
  }
  // Through a connection, the view shows the item's stored result for it.
  if (connectionId) {
    params.set("connection", connectionId);
  }
  return `${protocol}://${host}/form?lang=${lang}&id=${id}&${params.toString()}`;
};

const HEIGHTS = [150, 240, 360, 480, 640, 860, 1020];

const cache = {};

const IFrame = ({ id, src, setData, className, width, height, onFocus }) => {
  const iframeRef = useRef(null);
  const hasReceivedInitialData = useRef(false);
  const hasReceivedFocus = useRef(false);
  const currentIdRef = useRef(id);
  const [isLoading, setIsLoading] = useState(!!id);
  const [showReloadMessage, setShowReloadMessage] = useState(false);

  // Show reload message after 10 seconds if still loading
  useEffect(() => {
    if (!isLoading || !id) {
      setShowReloadMessage(false);
      return;
    }
    const timeout = setTimeout(() => setShowReloadMessage(true), 30000);
    return () => clearTimeout(timeout);
  }, [isLoading, id]);

  // Reset state when ID changes (new form loaded)
  useEffect(() => {
    if (currentIdRef.current !== id) {
      // Clear the cache for the old ID
      if (cache[currentIdRef.current]) {
        delete cache[currentIdRef.current];
      }

      // Update refs
      hasReceivedInitialData.current = false;
      hasReceivedFocus.current = false;
      currentIdRef.current = id;
      justChangedTaskRef.current = true;
      setIsLoading(!!id);

      // Clear any existing focus - mark as task change
      const clearFocusEvent = new CustomEvent('formIFrameFocus', {
        detail: { focus: null, isTaskChange: true }
      });
      window.dispatchEvent(clearFocusEvent);

      // Reset the flag after a delay
      setTimeout(() => {
        justChangedTaskRef.current = false;
      }, 1000);
    }
  }, [id]);

  // Store last focus data to re-send when requested
  const lastFocusDataRef = useRef(null);
  // Track if we just changed tasks
  const justChangedTaskRef = useRef(false);

  useEffect(() => {
    const handleMessage = (event) => {

      // Skip if the message is from the same origin (not from iframe)
      if (event.origin === window.location.origin) {
        return;
      }

      // Check for focus events first
      if (event.data.focus) {
        hasReceivedFocus.current = true;
        lastFocusDataRef.current = event.data.focus; // Store for re-sending
        onFocus && onFocus(event.data.focus);
        // Also dispatch a custom event that HelpPanel can listen to
        const focusEvent = new CustomEvent('formIFrameFocus', {
          detail: {
            focus: event.data.focus,
            isTaskChange: justChangedTaskRef.current
          }
        });
        window.dispatchEvent(focusEvent);
        return;
      }

      // Handle data-updated messages from view.jsx
      if (event.data.type === 'data-updated') {
        const data = event.data.data;
        if (data) {
          setData && setData(data);
          setIsLoading(false);
          // Cache the data
          if (id) {
            cache[id] = JSON.stringify(data);
          }
        }
        return;
      }

      // Skip known non-form message types (e.g. from external integrations)
      if (event.data.type === 'onload') {
        setIsLoading(false);
        return;
      }

      if (event.data.type === 'establish-communication' ||
          event.data.type === 'item-created' ||
          event.data.type === 'item-updated' ||
          event.data.type === 'learnosity-ready' ||
          event.data.type === 'graffiticode-ready') {
        return;
      }

      // Treat as runtime form state ONLY when the iframe explicitly keys the
      // payload by the current taskId (e.g. `{ "<id>": <state> }`).
      // The previous blanket fallthrough — "any non-empty object event is
      // form data" — was catching Learnosity's nested iframe init/ready
      // messages and feeding the signed Learnosity body back into compile
      // as state, which on a planner-built chain (head + upstream) made the
      // upstream language compile against a Learnosity-shaped payload and
      // throw "Language server error". Explicit data-updated messages
      // (handled above) remain the canonical path for runtime state.
      if (!event.data[id]) {
        return;
      }
      const data = event.data[id];
      if (!data) {
        return;
      }
      const hash = JSON.stringify(data);
      if (cache[id] !== hash) {
        cache[id] = hash;
        setData && setData(data);
        setIsLoading(false);
      }
    };
    window.addEventListener('message', handleMessage);

    // Listen for requests to re-send focus (e.g., when returning to Make tab)
    const handleRequestFocus = () => {
      if (lastFocusDataRef.current) {
        console.log('[FormIFrame] Re-sending focus on request:', lastFocusDataRef.current);
        const focusEvent = new CustomEvent('formIFrameFocus', {
          detail: { focus: lastFocusDataRef.current }
        });
        window.dispatchEvent(focusEvent);
      } else if (cache[id]) {
        // If we have cached data but no focus yet, try to create focus from cached data
        const cachedData = JSON.parse(cache[id]);
        if (cachedData && cachedData.interaction && cachedData.interaction.cells) {
          const cellKeys = Object.keys(cachedData.interaction.cells).filter(key =>
            key.match(/^[A-Z]+\d+$/)
          ).sort();

          if (cellKeys.length > 0) {
            const firstCellName = cellKeys[0];
            const firstCellData = cachedData.interaction.cells[firstCellName];
            const focusData = {
              type: 'cell',
              name: firstCellName,
              value: firstCellData || { text: '' }
            };

            console.log('[FormIFrame] Creating focus from cached data:', focusData);
            lastFocusDataRef.current = focusData;

            const focusEvent = new CustomEvent('formIFrameFocus', {
              detail: { focus: focusData }
            });
            window.dispatchEvent(focusEvent);
          }
        }
      }
    };

    window.addEventListener('requestFormFocus', handleRequestFocus);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('requestFormFocus', handleRequestFocus);
    };
  }, [id, onFocus]);

  // Request initial focus when iframe loads
  const handleIframeLoad = useCallback(() => {
    // Reset the flags when a new iframe loads
    hasReceivedInitialData.current = false;
    hasReceivedFocus.current = false;

    if (iframeRef.current && iframeRef.current.contentWindow) {
      // Give the iframe time to initialize, then request current focus
      // This will work if the iframe implements getFocus handling
      setTimeout(() => {
        try {
          iframeRef.current.contentWindow.postMessage({ type: 'getFocus' }, '*');
        } catch (e) {
          console.log('[FormIFrame] Unable to request initial focus:', e);
        }
      }, 1500);
    }
  }, []);

  return (
    <div className="relative w-full h-full">
      {isLoading && id && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          {showReloadMessage ? (
            <div className="text-center">
              <p className="text-gray-600 mb-2">Taking longer than expected.</p>
              <button
                onClick={() => {
                  setShowReloadMessage(false);
                  setIsLoading(true);
                  if (iframeRef.current) {
                    iframeRef.current.src = iframeRef.current.src;
                  }
                }}
                className="text-gray-600 hover:text-gray-800 underline"
              >
                Reload preview
              </button>
            </div>
          ) : (
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        id={id}
        src={src}
        key="1"
        className={className}
        style={{ width: "100%", height: height || "100vh", border: "none" }}
        onLoad={handleIframeLoad}
        // Lets the embedded view's "Copy" button reach the async Clipboard API from this
        // cross-origin iframe (the standalone /form page, being top-level, doesn't need this).
        allow="clipboard-write"
      />
    </div>
  );
};

const getHeight = (height, newHeight) => {
  if (newHeight === height) {
    return height;
  } else if (newHeight > HEIGHTS[HEIGHTS.length - 1]) {
    return HEIGHTS[HEIGHTS.length - 1];
  } else {
    return HEIGHTS.find((h, i) => newHeight < h && h);
  }
};

export const FormIFrame = ({
  accessToken,
  lang,
  id,
  setData,
  data,
  className,
  height,
  onFocus,
  connectionId = null,
}: any) => {
  const origin = window.location.origin;
  const src = useTaskIdFormUrl({accessToken, lang, id, origin, connectionId});
  return (
    <IFrame
      id={id}
      src={src}
      setData={setData}
      onFocus={onFocus}
      className={className || "w-full h-full"}
      width="100%"
      height={height || "100vh"}
    />
  );
};
