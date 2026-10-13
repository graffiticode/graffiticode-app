import React, { useState, useEffect } from 'react'
import { CodePanel } from './CodePanel';
import { DataPanel } from "./DataPanel";
import { SpecPanel } from "./SpecPanel";
import { HelpPanel } from "./HelpPanel";
import MarkSelector from '../components/mark-selector';
import PublicToggle from '../components/public-toggle';
import { parse, postTask } from '../utils/swr/fetchers';
import useGraffiticodeAuth from '@graffiticode/auth-react';
import { createState } from "../lib/state";
import { Tabs } from "./Tabs";
import { isNonNullNonEmptyObject, summarizeSrcDiff } from "../utils";
import useLocalStorage from '../hooks/use-local-storage';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

// Compare two code strings ignoring whitespace changes and comments
// Newlines are not significant in Graffiticode
// Block comments /* */ are ignored
function isCodeEquivalent(code1, code2) {
  // If both are the same reference or both are null/undefined
  if (code1 === code2) return true;

  // If one is null/undefined and the other isn't
  if (!code1 || !code2) return false;

  // Normalize by:
  // 1. Removing block comments /* */
  // 2. Replacing all newlines with spaces (not significant in Graffiticode)
  // 3. Replacing multiple whitespaces with single space
  // 4. Trimming leading/trailing whitespace
  const normalize = (str) => {
    return str
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
      .split('\n')
      .join(' ')
      .replace(/\s+/g, ' ')       // Replace multiple whitespaces with single space
      .trim();
  };

  return normalize(code1) === normalize(code2);
}

/*
  The job of the Editor is to provide code and props editors and to compile the
  edited code and props to get an id for the current state of the view.
 */

export default function Editor({
  accessToken,
  taskId,
  setTaskId,
  setUpstreamLangs,
  onLoadTaskFromHelp,
  lang,
  mark: initMark,
  height,
  onCodeChange,
  onHelpChange,
  onCompileError,
  onError,
  initialCode,
  initialHelp,
  itemId,
  itemVersions,
}: any) {
  const [ code, setCode ] = useState(initialCode || "");
  const [ help, setHelp ] = useState(initialHelp || []);
  const [ data, setData ] = useState({});
  const [ props, setProps ] = useState({});
  const [ dataCode, setDataCode ] = useState("");
  const [ view, setView ] = useState();
  const [ mark, setMark ] = useState(initMark);
  const [ isPublic, setIsPublic ] = useState(false);
  const [ isUserEdit, setIsUserEdit ] = useState(false);
  const [ compileErrors, setCompileErrors ] = useState<Array<{message: string, from: number, to: number}> | null>(null);
  const [ tab, setTab ] = useLocalStorage("graffiticode:editor:tab", "Help");
  const { user } = useGraffiticodeAuth();
  const [ isPostingTask, setIsPostingTask ] = useState(false);
  const dataPanelRef = React.useRef(null);
  const currentTaskIdRef = React.useRef(null);
  const codeRef = React.useRef(initialCode || "");
  // Source as of the last posted task — the baseline a hand edit is diffed
  // against to label its version record. Distinct from codeRef, which tracks
  // every keystroke.
  const lastPostedSrcRef = React.useRef(initialCode || "");
  // Source most recently applied from chat generation. The resolver already
  // posted that task (its taskId is set via the chat path), so the debounced
  // re-post effect skips this source to avoid creating a duplicate task.
  const generatedSrcRef = React.useRef<string | null>(null);

  // Function to check if new code is different from current code
  // Uses ref to avoid closure issues with stale state
  const isCodeNew = React.useCallback((newCode) => {
    return !isCodeEquivalent(newCode, codeRef.current);
  }, []);

  // Raw spec markdown, published by SpecPanel. State rather than a ref because the Copy All button
  // is only offered once there is something to copy, which needs a render.
  const [specText, setSpecText] = React.useState("");
  const handleSpecLoaded = React.useCallback((text: string) => setSpecText(text || ""), []);

  const handleCopy = () => {
    // The Spec tab copies the raw markdown, not the rendered DOM — see SpecPanel. The Data tab
    // keeps its existing select-and-execCommand behavior, which copies what is on screen.
    if (tab === "Spec") {
      if (!specText) return;
      navigator.clipboard?.writeText(specText).catch((err) => {
        console.error('Failed to copy spec: ', err);
      });
      return;
    }
    if (dataPanelRef.current) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(dataPanelRef.current);
      selection.removeAllRanges();
      selection.addRange(range);

      try {
        document.execCommand('copy');
      } catch (err) {
        console.error('Failed to copy: ', err);
      }

      selection.removeAllRanges();
    }
  };


  useEffect(() => {
    // When taskId changes, cancel any pending repost and (only when the
    // parent's initialCode actually differs from what we already have)
    // sync the editor to the new initial source. The conditional setCode
    // avoids a race where chat-driven setTaskId(chain) would otherwise
    // overwrite the freshly-set code with a stale initialCode prop before
    // gallery's onCodeChange callback propagates the new value.
    if (taskId !== currentTaskIdRef.current) {
      setIsUserEdit(false);
      setIsPostingTask(false);
      if (initialCode !== undefined && initialCode !== codeRef.current) {
        setCode(initialCode);
        codeRef.current = initialCode;
        lastPostedSrcRef.current = initialCode;
      }
      if (initialHelp !== undefined) {
        setHelp(initialHelp);
      }
      currentTaskIdRef.current = taskId;
    }
  }, [taskId, initialCode, initialHelp]);

  useEffect(() => {
    // Update code when initialCode changes
    if (initialCode !== undefined) {
      setCode(initialCode);
      codeRef.current = initialCode;
      lastPostedSrcRef.current = initialCode;
    }
  }, [initialCode]);

  // Keep codeRef in sync with code state
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Parse and post task when code changes due to user editing (debounced).
  // Trailing chain segments (build-time upstream layers) are preserved so
  // edits to the head don't drop composition.
  useEffect(() => {
    if (!code || !isUserEdit || isPostingTask || !user) return;

    const timer = setTimeout(() => {
      setIsUserEdit(false);
      setIsPostingTask(true);

      (async () => {
        try {
          const result = await parse({ user, lang, src: code, itemId });
          if (result.errors) {
            setCompileErrors(result.errors);
            setIsPostingTask(false);
            return;
          }
          setCompileErrors(null);
          // Skip re-posting code that came from chat generation: the resolver
          // already posted it and the authoritative taskId is set. Only
          // genuine user edits should create a new task.
          if (generatedSrcRef.current !== null && isCodeEquivalent(code, generatedSrcRef.current)) {
            generatedSrcRef.current = null;
            setIsPostingTask(false);
            return;
          }
          const newHead = await postTask({ user, lang, code: result.code, item: itemId });
          const upstreamSegments = (taskId || "").split("+").slice(1);
          const newChain = upstreamSegments.length > 0
            ? [newHead, ...upstreamSegments].join("+")
            : newHead;
          // A hand-edit — the version case the help transcript never recorded.
          // Label it with a line-count delta so its row in the transcript says
          // something more than an elided task id.
          const label = summarizeSrcDiff(lastPostedSrcRef.current, code);
          lastPostedSrcRef.current = code;
          setTaskId(newChain, "editor", label);
        } catch (err) {
          console.error("Parse/postTask error:", err);
        } finally {
          setIsPostingTask(false);
        }
      })();
    }, 1000);

    return () => clearTimeout(timer);
  }, [code, isUserEdit, isPostingTask, user, lang]);

  // Notify parent of code changes (only from user edits, not parent-driven updates)
  useEffect(() => {
    if (onCodeChange && code !== undefined && code !== initialCode) {
      onCodeChange(code);
    }
  }, [code, onCodeChange]);

  // Notify parent of help changes (only from user edits, not parent-driven updates)
  useEffect(() => {
    if (onHelpChange && help !== undefined && help !== initialHelp) {
      onHelpChange(help);
    }
  }, [help, onHelpChange]);

  // Notify parent of compile/parse errors
  useEffect(() => {
    if (onCompileError) {
      onCompileError(compileErrors);
    }
  }, [compileErrors, onCompileError]);

  return (
    <div className="flex items-start h-full">
      <div className="min-w-0 flex-1 relative flex flex-col h-full">
        {/* Sticky tabs container */}
        <div
          className="sticky top-0 bg-white z-30 flex-none"
        >
          <Tabs
            tab={tab}
            setTab={setTab}
            onCopy={handleCopy}
            showCopyButton={tab === "Data" || (tab === "Spec" && !!specText)}
          />
        </div>

        {/* Content container with scrolling */}
        <div
          className="flex-1 overflow-auto"
          style={{
            height: height === "100%" ? undefined : (height || "calc(100vh - 120px)") // Use flexbox when 100%
          }}
        >
          <div style={{ display: tab === "Help" ? undefined : "none" }}>
            <HelpPanel
              help={help}
              setHelp={setHelp}
              language={lang}
              code={code}
              itemId={itemId}
              setCode={(newCode) => {
                if (isCodeNew(newCode)) {
                  // Code applied from chat generation. The resolver already
                  // posted the task and the chat sets the authoritative taskId
                  // via setTaskId, so the debounced re-post must not duplicate
                  // it; mark this source so the effect skips posting it.
                  generatedSrcRef.current = newCode;
                  setIsUserEdit(true);
                  setCode(newCode);
                }
              }}
              setTaskId={(newTaskId) => setTaskId(newTaskId, "chat")}
              setUpstreamLangs={setUpstreamLangs}
              onLoadTaskFromHelp={onLoadTaskFromHelp}
              onError={onError}
              taskId={taskId}
              itemVersions={itemVersions}
              // The compiled record DataPanel fetched for this taskId. The chat
              // needs it for dialects whose values live outside the program, and
              // it is already in hand — the Data tab renders the same object.
              compiledData={compileErrors ? null : data}
            />
          </div>
          <div style={{ display: tab === "Data" ? undefined : "none" }}>
            <DataPanel
              ref={dataPanelRef}
              id={taskId}
              user={user}
              onDataChange={(fetchedData) => {
                const errors = fetchedData?.errors;
                if (Array.isArray(errors) && errors.length > 0) {
                  setCompileErrors(errors.map(e => ({
                    message: typeof e === 'string' ? e : (e.message || JSON.stringify(e)),
                    from: e.from ?? -1,
                    to: e.to ?? -1,
                  })));
                } else if (fetchedData?.usageLimitReached) {
                  setCompileErrors([{
                    message: 'Item limit reached. Add a payment method, raise your spend cap, or upgrade your plan on the Billing page to continue.',
                    from: -1,
                    to: -1,
                  }]);
                } else {
                  setCompileErrors(null);
                }
              }}
            />
          </div>
          {tab === "Spec" && (
            <SpecPanel id={itemId} user={user} taskId={taskId} onLoaded={handleSpecLoaded} />
          )}
          {tab === "Code" && (
            <CodePanel
              code={code}
              setCode={(newCode) => {
                if (isCodeNew(newCode)) {
                  // Genuine user edit in the code panel — clear any generated
                  // marker so the debounced re-post persists this change.
                  generatedSrcRef.current = null;
                  setIsUserEdit(true);
                  setCode(newCode);
                }
              }}
              compiledData={compileErrors ? { errors: compileErrors } : data}
            />
          )}
        </div>
      </div>
    </div>
  )
}
