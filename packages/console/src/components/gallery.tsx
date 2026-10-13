import { Fragment, useCallback, useState, useEffect, useRef } from 'react'
import { ITEM_RUN_EVENT } from './ItemConnection';
import { viewConnectionId } from '../lib/connectable';
import { canRetryWrite, describeWriteProblem } from '../lib/write-errors';
import Link from 'next/link';
import useSWR from "swr";
import { useRouter } from 'next/router';
import { Dialog, Transition, Menu } from '@headlessui/react'
import {
  XMarkIcon,
  ChevronDoubleLeftIcon,
} from '@heroicons/react/24/outline'
import Editor from './editor';
import { ImageGallery } from './ImageGallery';
import SignIn from "./SignIn";
import { getAccessToken, loadItems, loadItemClientTags, createItem, updateItem, getData, getItem, getTask, compile, loadTaskVersions, retryItemWrite } from '../utils/swr/fetchers';
import { readItemsCache, writeItemsCache } from '../utils/items-cache';
import useGraffiticodeAuth from "@graffiticode/auth-react";
import FormView from "./FormView";
import { Disclosure } from '@headlessui/react'
import { ChevronRightIcon } from '@heroicons/react/20/solid'
import ItemsNav from "./ItemsNav";
import { PlusIcon } from '@heroicons/react/20/solid';
import ItemsHeaderMenu, { DEFAULT_SORT, DEFAULT_DATE_FILTER, Sort, DateFilter } from "./items-header-menu";
import { ClientOption, ALL_CLIENT, clientOptionForId } from "./client-selector";
import { findLanguageByNumber } from "./language-selector";
// Newest N versions of the open item. Defined next to the merge that reads it,
// which needs to know when a history came back truncated.
import { ITEM_VERSIONS_LIMIT } from "../utils/itemVersions";

const normalizeLangId = (raw: any): string | null => {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/^L/i, '').trim();
  if (!s) return null;
  return s.padStart(4, '0');
};

// Broadcasts a selection change so the top nav can rebuild its hrefs (e.g.
// /tasks → /tasks/<currentTaskId>) without polling localStorage. The lang
// lets the nav gate the detail URL: if the user later switches languages on
// another page, a stale item from a different language shouldn't hijack the
// Items/Tasks links.
const broadcastSelection = (kind: 'itemId' | 'taskId', id: string | null, lang: string | null) => {
  if (typeof window === 'undefined') return;
  if (id) {
    localStorage.setItem(`graffiticode:selected:${kind}`, id);
    if (lang) localStorage.setItem(`graffiticode:selected:${kind}:lang`, lang);
  }
  window.dispatchEvent(new CustomEvent(`gc:selected-${kind}`, { detail: { id: id || null, lang: lang || null } }));
};

const parseId = id => {
  if (!id) {
    return {taskId: ""};
  }
  const parts = id.split("+");
  return {
    taskId: parts[0],
    dataId: parts.length > 1 && parts.slice(1).join("+"),
  };
};

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

function getId({ taskId, dataId }) {
  return taskId + (dataId && `+${dataId}` || "");
}

const useTaskIdFormUrl = ({ lang, id }) => {
  const { user } = useGraffiticodeAuth();
  const { data: src } = useSWR({ lang, user, id }, async ({ lang, user, id }) => {
    if (!id) {
      return "";
    }
    const token = await user.getToken();
    const params = new URLSearchParams();
    if (token) {
      params.set("token", token);
    }
    return `/api/form/${id}?${params.toString()}`;
  });
  return src;
};

export default function Gallery({ lang, mark, setMark, hideItemsNav = false, itemId: initialItemId = null, client, setClient, sort = DEFAULT_SORT, setSort, dateFilter = DEFAULT_DATE_FILTER, setDateFilter, setLanguage }: { lang: any; mark: any; setMark?: (m: any) => void; hideItemsNav?: boolean; itemId?: string | null; client?: ClientOption; setClient?: (c: ClientOption) => void; sort?: Sort; setSort?: (s: Sort) => void; dateFilter?: DateFilter; setDateFilter?: (d: DateFilter) => void; setLanguage?: (lang: any) => void }) {
  const router = useRouter();
  const isItemDetailRoute = router.pathname === '/items/[id]';
  const clientOption: ClientOption = client || ALL_CLIENT;
  const clientId = clientOption.id;
  const [ hideEditor, setHideEditor ] = useState(false);
  const [ formHeight, setFormHeight ] = useState(350);
  const [ taskId, setTaskId ] = useState("");
  // Bumped when the selected item is run through its connection, so the
  // preview remounts and loads the new stored result.
  const [ previewRun, setPreviewRun ] = useState(0);
  // How the pending taskId change came about, and a short description of it, for
  // the version record written server-side. Set by whoever advances the taskId;
  // read at save time, then cleared so a later metadata-only save (a rename, a
  // mark change) doesn't inherit stale provenance.
  const versionSourceRef = useRef<string | undefined>(undefined);
  const versionLabelRef = useRef<string | undefined>(undefined);
  const setTaskIdWithSource = useCallback((newTaskId: string, source?: string, label?: string) => {
    versionSourceRef.current = source;
    versionLabelRef.current = label;
    setTaskId(newTaskId);
  }, []);
  const [ isCreatingItem, setIsCreatingItem ] = useState(false);
  const [ systemAlert, setSystemAlert ] = useState<string | null>(null);
  const dismissedAlertRef = useRef<string | null>(null);
  // The save whose item-bank write failed or was skipped (lastWrite), shown as
  // a banner over the preview until a later write succeeds, the user dismisses
  // it, or another item is opened. What it says is read live from the item, so
  // a successful retry (here or in the item's Connection panel) clears it.
  const [ writeBanner, setWriteBanner ] = useState<{ itemId: string; taskId: string } | null>(null);
  const [ retryingWrite, setRetryingWrite ] = useState(false);
  const [ retryWriteError, setRetryWriteError ] = useState<string | null>(null);
  const itemsNavRef = useRef<any>(null);

  // Save the current taskId to localStorage when it changes so it can be used in Tasks view
  useEffect(() => {
    if (taskId) broadcastSelection('taskId', taskId, normalizeLangId(lang));
  }, [taskId, lang]);
  const [ isItemsPanelCollapsed, setIsItemsPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:itemsPanelCollapsed') === 'true'
  );
  const [ isEditorPanelCollapsed, setIsEditorPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:editorPanelCollapsed') === 'true'
  );
  const [ isFormPanelCollapsed, setIsFormPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:formPanelCollapsed') === 'true'
  );
  const [ isAssetsPanelCollapsed, setIsAssetsPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:assetsPanelCollapsed') === 'true'
  );
  const [ assetsPanelWidth, setAssetsPanelWidth ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:assetsPanelWidth') : null;
    return saved ? parseInt(saved) : 210;
  });
  const [ itemsPanelWidth, setItemsPanelWidth ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:itemsPanelWidth') : null;
    return saved ? parseInt(saved) : 210;
  });
  const [ items, setItems ] = useState([]);
  const [ selectedItemId, setSelectedItemId ] = useState("");
  const [ editorCode, setEditorCode ] = useState("");
  const [ editorHelp, setEditorHelp ] = useState([]);
  const [ formData, setFormData ] = useState({});
  // Build-time state-layer languages (planner-composed upstreams) for the
  // currently selected item. Length == number of '+' segments after the head.
  const [ upstreamLangs, setUpstreamLangs ] = useState<string[]>([]);
  // Live-sync: true while the open editor holds unsaved local edits. Gates the
  // write-back effect so a poll/adopt never pushes stale local state back, and
  // distinguishes a local edit from a remote one. Baselines track the server
  // snapshot we're synced to so a stale poll can't revert our own save.
  const editorDirtyRef = useRef(false);
  // The last save the write-back effect sent, per item. The items list only
  // catches up when that save returns, so until then a second trigger (a code
  // and a help change landing separately) still looks like a change and would
  // send the identical save again — and, for an item that writes through a
  // connection, race its write.
  const lastSentSaveRef = useRef<{ itemId: string; signature: string } | null>(null);
  const baselineTaskIdRef = useRef<string | null>(null);
  const baselineUpdatedRef = useRef(0);
  const [ remoteUpdateAvailable, setRemoteUpdateAvailable ] = useState(false);
  const [ editorPanelWidth, setEditorPanelWidth ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:editorPanelWidth') : null;
    return saved ? parseFloat(saved) : 50;
  }); // Percentage width for desktop
  const [ previewPanelHeight, setPreviewPanelHeight ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:previewPanelHeight') : null;
    return saved ? parseFloat(saved) : 50;
  }); // Percentage height for mobile
  const { user } = useGraffiticodeAuth();
  const { data: accessToken } = useSWR(
    user && { user } || null,
    getAccessToken,
  );
  const editorRef = useRef<any>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Detect if we're in editor mode
  const isEditorMode = useRef(false);
  const editorOrigin = useRef(null);
  const openerWindowRef = useRef(null);

  // Track current viewport type to detect changes
  const [ currentViewport, setCurrentViewport ] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'desktop' : 'mobile'
  );

  // Handle viewport changes
  useEffect(() => {
    const handleViewportChange = () => {
      const newViewport = window.innerWidth >= 1024 ? 'desktop' : 'mobile';
      if (newViewport !== currentViewport) {
        setCurrentViewport(newViewport);
        // Only restore saved sizes for the new viewport if panels are at default sizes
        // This prevents resizing when taskId changes or other state updates occur
        if (newViewport === 'desktop') {
          // Only restore if editor panel is at default 50% width
          if (editorPanelWidth === 50) {
            const saved = localStorage.getItem('graffiticode:editorPanelWidth');
            if (saved) setEditorPanelWidth(parseFloat(saved));
          }
        } else {
          // Only restore if preview panel is at default 50% height
          if (previewPanelHeight === 50) {
            const saved = localStorage.getItem('graffiticode:previewPanelHeight');
            if (saved) setPreviewPanelHeight(parseFloat(saved));
          }
        }
      }
    };

    window.addEventListener('resize', handleViewportChange);
    return () => window.removeEventListener('resize', handleViewportChange);
  }, [currentViewport, editorPanelWidth, previewPanelHeight]);

  useEffect(() => {
    // Check if we were opened from editor (has opener and sessionStorage flag)
    if (typeof window !== 'undefined' && window.opener) {
      const editorData = sessionStorage.getItem('graffiticode:editor');
      if (editorData) {
        try {
          const data = JSON.parse(editorData);
          isEditorMode.current = true;
          editorOrigin.current = data.origin;
        } catch (e) {
          console.error('Failed to parse editor data:', e);
        }
      }

      // Also check URL parameters for editor mode
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('editorMode') === 'true' && urlParams.get('editorOrigin')) {
        isEditorMode.current = true;
        editorOrigin.current = urlParams.get('editorOrigin');
      }
    }
  }, []);

  // Listen for establish-communication from the opener window (e.g. Learnosity custom layout)
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'establish-communication' && event.source) {
        openerWindowRef.current = event.source;
        editorOrigin.current = event.origin;
        isEditorMode.current = true;
        // Send acknowledgment
        try {
          (event.source as Window).postMessage({ type: 'graffiticode-ready' }, event.origin);
        } catch (e) {
          console.warn('[Gallery] Failed to send graffiticode-ready:', e);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Load source code for an item via its taskId
  const loadItemSource = useCallback(async (itemId: string, itemTaskId: string) => {
    if (!itemTaskId || !user) {
      setEditorCode("");
      return;
    }
    const taskData = await getTask({ user, id: itemTaskId });
    setEditorCode(taskData?.src || "");
  }, [user]);

  // Record the server snapshot the open editor is synced to, and clear the
  // dirty flag. Called whenever an item is loaded/selected (a clean load).
  const syncOpenBaseline = useCallback((item: any) => {
    baselineTaskIdRef.current = item?.taskId ?? null;
    baselineUpdatedRef.current = Number(item?.updated) || 0;
    editorDirtyRef.current = false;
    setRemoteUpdateAvailable(false);
  }, []);

  // Editor change callbacks that also mark the open editor dirty. Only real
  // user edits reach these (Editor fires onCodeChange/onHelpChange only when
  // the value diverges from initialCode/initialHelp), so this is a reliable
  // "the user changed something" signal that gates the write-back effect.
  const handleEditorCodeChange = useCallback((code: string) => {
    editorDirtyRef.current = true;
    setEditorCode(code);
  }, []);
  const handleEditorHelpChange = useCallback((help: any) => {
    editorDirtyRef.current = true;
    setEditorHelp(help);
  }, []);
  const handleEditorUpstreamChange = useCallback((next: any) => {
    editorDirtyRef.current = true;
    setUpstreamLangs(next);
  }, []);

  // Load items from the API. Seed from localStorage so the nav paints instantly
  // on reload, then revalidate in the background.
  const itemsKey = user && lang && mark && !hideItemsNav
    ? `items-${user.uid}-${lang}-${mark.id}-${clientId}`
    : null;
  const { data: loadedItems, mutate, isLoading: isLoadingItems } = useSWR(
    itemsKey,
    () => loadItems({ user, lang, mark: mark.id, client: clientId }),
    {
      // Show last-known items immediately, before any network call.
      fallbackData: readItemsCache(itemsKey),
      // Refresh the cache on every successful fetch.
      onSuccess: (data) => writeItemsCache(itemsKey, data),
      // Poll so edits made by other clients (e.g. the MCP server) surface here.
      // SWR's default deep compare avoids re-renders when nothing changed, and
      // refreshWhenHidden defaults false so a backgrounded tab doesn't poll.
      refreshInterval: 8000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  );

  // Load distinct client tags for this user+lang to populate the menu's Client filter.
  const { data: clientTags } = useSWR(
    user && lang && !hideItemsNav ? `itemClientTags-${user.uid}-${lang}` : null,
    () => loadItemClientTags({ user, lang }),
    { revalidateOnFocus: true, revalidateOnReconnect: false }
  );

  const clientList = (() => {
    const tags = clientTags || [];
    // 1 distinct tag: just the solo option (collapsed; "All" is redundant).
    if (tags.length === 1) {
      const solo = clientOptionForId(tags[0]);
      const list: ClientOption[] = [solo];
      if (clientOption.id !== solo.id) list.push(clientOption);
      return list;
    }
    // 0 tags: just "All".
    if (tags.length === 0) {
      const list: ClientOption[] = [ALL_CLIENT];
      if (clientOption.id !== ALL_CLIENT.id) list.push(clientOption);
      return list;
    }
    // 2+ tags: "All" plus each distinct tag.
    const list: ClientOption[] = [ALL_CLIENT];
    const seen = new Set<string>([ALL_CLIENT.id]);
    for (const id of tags) {
      if (!seen.has(id)) {
        list.push(clientOptionForId(id));
        seen.add(id);
      }
    }
    if (!seen.has(clientOption.id)) list.push(clientOption);
    return list;
  })();

  // Listen for item-created messages from editor popup
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'item-created') {
        mutate(); // Refresh items list
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [mutate]);

  // Load a single item directly when initialItemId is provided (e.g., from URL)
  const { data: directItem, isLoading: isLoadingDirectItem } = useSWR(
    user && initialItemId ? `item-${user.uid}-${initialItemId}` : null,
    () => getItem({ user, id: initialItemId }),
    {
      refreshInterval: 8000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  // Every recorded content state of the OPEN item, including the ones the help
  // transcript never captured: hand edits, MCP edits, a claimed/shared item's v1.
  // Deliberately unfiltered by the client selector — the point is to show every
  // producer — and deliberately without keepPreviousData, since the key is
  // per-item and the previous item's versions would be a lie during a switch.
  //
  // Keyed on the ITEM's lang, not the filter lang: on a deep-linked /items/[id]
  // the two can disagree mid-sync, and getTaskVersions' where("lang","==") would
  // silently return nothing.
  const selectedItemLang = normalizeLangId(
    items.find(item => item.id === selectedItemId)?.lang
  ) ?? normalizeLangId(lang);
  const itemVersionsKey = user && selectedItemLang && selectedItemId
    ? `item-versions-${user.uid}-${selectedItemLang}-${selectedItemId}`
    : null;
  const { data: itemVersions, mutate: mutateItemVersions } = useSWR(
    itemVersionsKey,
    () => loadTaskVersions({ user, lang: selectedItemLang, itemId: selectedItemId, limit: ITEM_VERSIONS_LIMIT }),
    {
      // Surface versions written by other clients (MCP, the generation worker).
      // Our own writes revalidate immediately from handleUpdateItem.
      refreshInterval: 8000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  // Clear items and selected item when user changes to prevent stale state
  useEffect(() => {
    if (user?.uid) {
      setItems([]);
      setSelectedItemId(null);
      setTaskId(null);
      setEditorCode("");
      setEditorHelp([]);
      setUpstreamLangs([]);
      syncOpenBaseline(null);
    }
  }, [user?.uid, syncOpenBaseline]);

  // Popup editor (hideItemsNav) collapses the gallery to just the deep-linked
  // item. The in-app /items/[id] view should NOT collapse the list — the user
  // expects to see all their items with the URL one preselected.
  useEffect(() => {
    if (!hideItemsNav) return;
    if (directItem && initialItemId) {
      setItems([directItem]);
      // Only do the full editor populate on the initial load of this item.
      // Subsequent polled changes to the SAME item are handled by the adopt
      // effect, so we don't clobber in-progress edits on every poll.
      if (selectedItemId !== directItem.id) {
        setSelectedItemId(directItem.id);
        setTaskId(directItem.taskId);
        setEditorHelp(typeof directItem.help === "string" ? JSON.parse(directItem.help || "[]") : (directItem.help || []));
        setUpstreamLangs(Array.isArray(directItem.upstreamLangs) ? directItem.upstreamLangs : []);
        loadItemSource(directItem.id, directItem.taskId);
        syncOpenBaseline(directItem);
      }
    }
  }, [directItem, initialItemId, hideItemsNav, selectedItemId, loadItemSource, syncOpenBaseline]);

  // Sync the language selector to the deep-linked item's lang. Runs in both
  // modes (popup editor + in-app /items/[id]) so the surrounding chrome (form,
  // compile, items-list filter) matches the loaded item. Gated by item id so a
  // later manual change to the nav picker isn't snapped back by this effect.
  const lastSyncedItemIdRef = useRef<string | null>(null);
  // Track the active filter so a user-initiated mark/lang/client change can
  // select the new list's first item. `suppress` marks the programmatic
  // lang-sync below so it isn't mistaken for a user change.
  const prevFilterKeyRef = useRef<string | null>(null);
  const selectFirstPendingRef = useRef(false);
  const suppressFilterSelectRef = useRef(false);
  useEffect(() => {
    if (!directItem || !initialItemId) return;
    if (!setLanguage) return;
    if (lastSyncedItemIdRef.current === initialItemId) return;
    const targetLang = normalizeLangId((directItem as any).lang);
    if (!targetLang) return;
    lastSyncedItemIdRef.current = initialItemId;
    const currentLang = normalizeLangId(lang);
    if (targetLang === currentLang) return;
    const next = findLanguageByNumber(targetLang);
    if (next) {
      suppressFilterSelectRef.current = true;
      setLanguage(next);
    }
  }, [directItem, initialItemId, setLanguage, lang]);

  // Recompute ordered/filtered items whenever loadedItems, sort, or dateFilter change.
  useEffect(() => {
    if (hideItemsNav && directItem && initialItemId) return;

    // Merge the directly-loaded deep-link item (e.g. a just-claimed item) into
    // the list when the list query hasn't caught up yet, so it appears in the
    // nav immediately instead of after the next revalidation. Dedup by id.
    const base = Array.isArray(loadedItems) ? loadedItems : [];
    // Only merge the deep-linked item when it actually belongs to the active
    // filter — otherwise switching mark/lang would leak the open item into a
    // list it doesn't match (and keep a stale list from clearing).
    const directMatchesFilter = !!directItem && !!initialItemId &&
      normalizeLangId((directItem as any).lang) === normalizeLangId(lang) &&
      Number((directItem as any).mark) === mark?.id &&
      (clientId === 'all' || ((directItem as any).client ?? 'console') === clientId);
    const sourceItems = (directMatchesFilter && !base.some(i => i.id === (directItem as any).id))
      ? [directItem, ...base]
      : base;

    if (sourceItems.length === 0) {
      setItems([]);
      return;
    }

    // Defensively coerce dateFilter so a malformed localStorage value can't
    // silently filter every item out.
    const dfField = (dateFilter?.field === 'created' || dateFilter?.field === 'updated')
      ? dateFilter.field
      : 'updated';
    const dfFrom = typeof dateFilter?.from === 'number' && Number.isFinite(dateFilter.from) ? dateFilter.from : null;
    const dfTo = typeof dateFilter?.to === 'number' && Number.isFinite(dateFilter.to) ? dateFilter.to : null;
    const filteredItems = (dfFrom === null && dfTo === null)
      ? sourceItems
      : sourceItems.filter(i => {
          // Never hide the open deep-linked item, regardless of date filter.
          if (initialItemId && i.id === initialItemId) return true;
          const ts = Number(i[dfField] || 0);
          if (dfFrom !== null && ts < dfFrom) return false;
          if (dfTo !== null && ts > dfTo) return false;
          return true;
        });

    const dir = sort.direction === 'asc' ? 1 : -1;
    const orderedItems = [...filteredItems].sort((a, b) => {
      if (sort.field === 'name') {
        return dir * String(a.name || '').localeCompare(String(b.name || ''));
      }
      const aTime = Number(a[sort.field] || 0);
      const bTime = Number(b[sort.field] || 0);
      return dir * (aTime - bTime);
    });
    setItems(orderedItems);
  }, [loadedItems, directItem, initialItemId, sort, dateFilter, lang, mark?.id, clientId]);

  // Resolve selection (and load its source) only when the source data changes.
  useEffect(() => {
    if (hideItemsNav && directItem && initialItemId) return;

    // Detect a user-initiated mark/lang filter change so we can select the new
    // list's first item. The programmatic lang-sync (deep-link) sets `suppress`,
    // so it isn't treated as a user change. Client-only changes are excluded:
    // the server filters by lang+mark, so we can't tell a fresh client-filtered
    // list from the stale one by its head — those fall through to keep-or-first.
    const filterKey = `${normalizeLangId(lang)}|${mark?.id}`;
    if (prevFilterKeyRef.current !== null && prevFilterKeyRef.current !== filterKey) {
      if (suppressFilterSelectRef.current) {
        suppressFilterSelectRef.current = false;
      } else {
        selectFirstPendingRef.current = true;
      }
    }
    prevFilterKeyRef.current = filterKey;

    const clearOpenItem = () => {
      setSelectedItemId("");
      setTaskId("");
      setEditorCode("");
      setEditorHelp([]);
      setUpstreamLangs([]);
      syncOpenBaseline(null);
    };

    if (!loadedItems || loadedItems.length === 0) {
      // Empty list: clear the code/form views when there's nothing to preserve
      // (no deep-link) or the user filtered into an empty list. Read-after-write
      // lag on a deep-link keeps the open item until the list catches up.
      if (!initialItemId || selectFirstPendingRef.current) {
        selectFirstPendingRef.current = false;
        clearOpenItem();
      }
      return;
    }

    const targetItemId = initialItemId ||
      (typeof window !== 'undefined' ? localStorage.getItem(`graffiticode:selected:itemId`) : null);
    const pickItem = (item) => {
      if (item.id === selectedItemId) return; // selection unchanged → skip reload
      setSelectedItemId(item.id);
      setTaskId(item.taskId);
      setEditorHelp(typeof item.help === "string" ? JSON.parse(item.help || "[]") : (item.help || []));
      setUpstreamLangs(Array.isArray(item.upstreamLangs) ? item.upstreamLangs : []);
      loadItemSource(item.id, item.taskId);
      syncOpenBaseline(item);
      // Keep nav/localStorage + URL in sync when the resolved item changes (e.g.
      // after a language switch auto-opens a different item), like
      // handleSelectItem does — but without promoting the /items index to detail.
      broadcastSelection('itemId', item.id, normalizeLangId((item as any).lang ?? lang));
      if (isItemDetailRoute && router.query.id !== item.id) {
        router.replace(`/items/${item.id}`, undefined, { shallow: true });
      }
    };

    // User changed the mark/lang/client filter → select the first item of the
    // new list. Wait until loadedItems reflects the new filter: keepPreviousData
    // shows the prior list briefly, and the server filters by lang+mark, so the
    // head item matches the active filter once the fresh list arrives.
    if (selectFirstPendingRef.current) {
      const head = loadedItems[0];
      const listIsFresh = normalizeLangId((head as any).lang) === normalizeLangId(lang)
        && Number((head as any).mark) === mark?.id;
      if (!listIsFresh) return;
      selectFirstPendingRef.current = false;
      pickItem(head);
      return;
    }

    if (targetItemId) {
      const matchingItem = loadedItems.find(item => item.id === targetItemId);
      if (matchingItem) {
        pickItem(matchingItem);
        return;
      }
      // A deep-linked item (e.g. just-claimed) may not be in the list query yet
      // due to read-after-write lag, even though a direct getItem already has it.
      // Select the directly-loaded item and DO NOT fall back to loadedItems[0] —
      // that would hijack the selection (and rewrite the URL via pickItem) to a
      // different, older item. Wait for directItem / list revalidation instead.
      if (initialItemId) {
        if (directItem && directItem.id === initialItemId) {
          pickItem(directItem);
        }
        return;
      }
    }
    const first = loadedItems[0];
    if (first) pickItem(first);
  }, [loadedItems, initialItemId, directItem, lang, mark?.id, clientId]);

  const toggleItemsPanel = useCallback(() => {
    const newState = !isItemsPanelCollapsed;
    setIsItemsPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:itemsPanelCollapsed', newState.toString());
    }
  }, [isItemsPanelCollapsed]);

  const toggleEditorPanel = useCallback(() => {
    const newState = !isEditorPanelCollapsed;
    setIsEditorPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:editorPanelCollapsed', newState.toString());
    }
  }, [isEditorPanelCollapsed]);

  const toggleFormPanel = useCallback(() => {
    const newState = !isFormPanelCollapsed;
    setIsFormPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:formPanelCollapsed', newState.toString());
    }
  }, [isFormPanelCollapsed]);

  const toggleAssetsPanel = useCallback(() => {
    const newState = !isAssetsPanelCollapsed;
    setIsAssetsPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:assetsPanelCollapsed', newState.toString());
    }
  }, [isAssetsPanelCollapsed]);

  const handleCreateItem = async () => {
    if (isCreatingItem) return;
    setIsCreatingItem(true);
    try {
      const newItem = await createItem({
        user,
        lang,
        name: "unnamed",
        taskId: null,
        mark: mark?.id || 1,
        help: "[]",
        isPublic: false,
        client: clientId === 'all' ? 'console' : clientId
      });
      if (newItem) {
        setItems(prevItems => [newItem, ...prevItems]);
        // Keep the SWR cache in sync so subsequent sort/filter changes see the new item.
        mutate(prev => (prev ? [newItem, ...prev] : prev), { revalidate: false });
        setSelectedItemId(newItem.id);
        setTaskId(newItem.taskId);
        setEditorHelp(typeof newItem.help === "string" ? JSON.parse(newItem.help || "[]") : (newItem.help || []));
        setUpstreamLangs(Array.isArray(newItem.upstreamLangs) ? newItem.upstreamLangs : []);
        loadItemSource(newItem.id, newItem.taskId);
        syncOpenBaseline(newItem);
        broadcastSelection('itemId', newItem.id, normalizeLangId((newItem as any).lang ?? lang));
        // Mirror handleSelectItem URL handling so initialItemId follows the
        // new item; otherwise the selection-resolution effect snaps back to
        // the previously deep-linked item.
        if (router.pathname === '/items' || router.pathname === '/items/') {
          router.push(`/items/${newItem.id}`, undefined, { shallow: true });
        } else if (isItemDetailRoute && router.query.id !== newItem.id) {
          router.replace(`/items/${newItem.id}`, undefined, { shallow: true });
        }
      }
    } catch (error) {
      console.error("Failed to create item:", error);
    } finally {
      setIsCreatingItem(false);
    }
  };

  const handleUpdateItem = async ({ itemId, name, taskId, mark: newMark, help, isPublic, client: newClient, upstreamLangs: newUpstreamLangs, source, label }: { itemId: string; name?: any; taskId?: any; mark?: any; help?: any; isPublic?: any; client?: any; upstreamLangs?: string[]; source?: string; label?: string }) => {
    // Prevent updates with stale item IDs - check both items array and ensure we have a valid user
    const currentItem = items.find(item => item.id === itemId);
    if (!itemId || !currentItem || !user?.uid) {
      return;
    }

    // Additional check: ensure the current items were loaded for the current user context
    // by checking that we have items loaded and they are for the current language/mark
    if (items.length === 0) {
      return;
    }

    // Check if we're changing the mark
    const isMarkChanging = newMark !== undefined && currentItem && currentItem.mark !== newMark;
    const currentFilterMark = mark?.id;

    const isClientChanging = newClient !== undefined && currentItem && (currentItem.client ?? 'console') !== newClient;

    // Then update backend
    try {
      const result = await updateItem({ user, id: itemId, name, taskId, mark: newMark, help, isPublic, client: newClient, upstreamLangs: newUpstreamLangs, source, label });

      // Advance the open-editor baseline so the adopt effect treats this write as
      // our own (not a remote change) even before the next poll lands.
      if (selectedItemId === itemId && result) {
        if (result.taskId) baselineTaskIdRef.current = result.taskId;
        baselineUpdatedRef.current = Number(result.updated) || baselineUpdatedRef.current;
        // updateItem awaits recordVersion before returning, so by now the version
        // doc is committed — one revalidate here covers every writer (the
        // debounced editor persist, chat, mark changes, restore) and the new row
        // reaches the transcript without waiting on the poll.
        if (result.taskId) mutateItemVersions();
      }

      // A new version's write through the current connection: a failure or a
      // skip (no connection) raises the banner; any other outcome clears it.
      if (result && taskId !== undefined && taskId !== currentItem.taskId && selectedItemId === itemId) {
        const write = result.lastWrite;
        setRetryWriteError(null);
        setWriteBanner(write && write.taskId === result.taskId && describeWriteProblem(write)
          ? { itemId, taskId: result.taskId }
          : null);
      }

      // A new version of a connectable item was written through the current
      // connection before updateItem returned. The preview may already have
      // loaded that version's (not yet stored) result, so reload it.
      if (result && taskId !== undefined && taskId !== currentItem.taskId &&
          result.lastWrite?.status === 'ok' && result.lastWrite.taskId === result.taskId) {
        window.dispatchEvent(new CustomEvent(ITEM_RUN_EVENT, { detail: { itemId } }));
      }

      // If mark changed and this is the selected item, we need to reload the task data
      if (isMarkChanging && selectedItemId === itemId && result && result.taskId) {
        setTaskId(result.taskId);
        if (result.help !== undefined) {
          setEditorHelp(typeof result.help === "string" ? JSON.parse(result.help || "[]") : (result.help || []));
        }
        loadItemSource(itemId, result.taskId);
      }

      // Update local state after successful backend update
      setItems(prevItems => {
        // If mark is changing and we're filtering by mark, remove the item
        if (isMarkChanging && currentFilterMark && newMark !== currentFilterMark) {
          return prevItems.filter(item => item.id !== itemId);
        }
        // If client is changing and we're filtering by a specific client, remove the item
        if (isClientChanging && clientId !== 'all' && newClient !== clientId) {
          return prevItems.filter(item => item.id !== itemId);
        }
        // Otherwise, update the item in place with the result from backend
        const updated = prevItems.map(item =>
          item.id === itemId
            ? {
                ...item,
                ...result,  // Use the full result from backend
              }
            : item
        );
        return updated;
      });

      // Keep the SWR cache in sync so the client-side sort/filter recompute
      // (which derives from `loadedItems`) sees the latest values.
      mutate(prev => {
        if (!prev) return prev;
        const shouldEvict =
          (isMarkChanging && currentFilterMark && newMark !== currentFilterMark) ||
          (isClientChanging && clientId !== 'all' && newClient !== clientId);
        if (shouldEvict) {
          return prev.filter(item => item.id !== itemId);
        }
        return prev.map(item =>
          item.id === itemId ? { ...item, ...result } : item
        );
      }, { revalidate: false });

      // If we removed the current selected item, select the item at the same index
      if (isMarkChanging && currentFilterMark && newMark !== currentFilterMark && selectedItemId === itemId) {
        const currentIndex = items.findIndex(item => item.id === itemId);
        const remainingItems = items.filter(item => item.id !== itemId);
        if (remainingItems.length > 0) {
          const nextIndex = Math.min(currentIndex, remainingItems.length - 1);
          const nextItem = remainingItems[nextIndex];
          setSelectedItemId(nextItem.id);
          setTaskId(nextItem.taskId);
          setEditorHelp(typeof nextItem.help === "string" ? JSON.parse(nextItem.help || "[]") : (nextItem.help || []));
          setUpstreamLangs(Array.isArray(nextItem.upstreamLangs) ? nextItem.upstreamLangs : []);
          loadItemSource(nextItem.id, nextItem.taskId);
          syncOpenBaseline(nextItem);
          // Persist so SWR refetch doesn't override
          broadcastSelection('itemId', nextItem.id, normalizeLangId((nextItem as any).lang ?? lang));
        } else {
          setSelectedItemId("");
          setTaskId("");
          setEditorCode("");
          setEditorHelp([]);
          setUpstreamLangs([]);
          syncOpenBaseline(null);
        }
      }
      return result;
    } catch (error) {
      console.error("Failed to update item:", error);
      // Optionally revert local state on error
      // setItems(prevItems);
    }
  };

  const handleSelectItem = (itemId) => {
    const item = items.find(i => i.id === itemId);
    if (item) {
      setSelectedItemId(item.id);
      setTaskId(item.taskId);
      setEditorHelp(typeof item.help === "string" ? JSON.parse(item.help || "[]") : (item.help || []));
      setUpstreamLangs(Array.isArray(item.upstreamLangs) ? item.upstreamLangs : []);
      loadItemSource(item.id, item.taskId);
      syncOpenBaseline(item);
      broadcastSelection('itemId', item.id, normalizeLangId((item as any).lang ?? lang));
      if (router.pathname === '/items' || router.pathname === '/items/') {
        // From index → first selection promotes URL to detail; preserve back to /items.
        router.push(`/items/${item.id}`, undefined, { shallow: true });
      } else if (isItemDetailRoute && router.query.id !== item.id) {
        router.replace(`/items/${item.id}`, undefined, { shallow: true });
      }
    }
  };

  // Handle loading a task from help panel (when user clicks a previous request)
  const handleLoadTaskFromHelp = async (taskIdToLoad) => {
    if (!taskIdToLoad || !user) return;

    try {
      const taskData = await getTask({ user, id: taskIdToLoad });

      if (taskData) {
        // Loading a prior task makes it the item's current state → persist it.
        // Restoring re-derives the SAME content-addressed taskId, so the version
        // record already exists: recordVersion's create hits ALREADY_EXISTS and
        // only bumps lastSeenAt. The transcript doesn't grow and the restored row
        // keeps its original position.
        editorDirtyRef.current = true;
        setTaskIdWithSource(taskIdToLoad, "editor");
        setEditorCode(taskData.src || "");
        // A compound chain carries its upstreams; without this the previous
        // item's upstreamLangs would be persisted and fed to the compiler.
        if (Array.isArray(taskData.langs)) {
          setUpstreamLangs(taskData.langs.slice(1));
        }
      }
    } catch (error) {
      console.error('Failed to load task from help panel:', error);
    }
  };

  // Update the selected item's state when editor changes
  useEffect(() => {
    // Only proceed if we have a valid selectedItemId and loaded items for current user
    if (selectedItemId && items.length > 0 && user?.uid) {
      const selectedItem = items.find(item => item.id === selectedItemId);
      // Double-check the item exists and hasn't been loaded from a different user
      if (selectedItem) {
        // Only persist when the editor holds genuine local edits. Without this
        // gate, a poll/adopt that advances the server taskId would make the
        // local taskId look "changed" and push the stale value back, clobbering
        // the other client's edit.
        if (!editorDirtyRef.current) return;
        // Check if any values have changed
        const hasChanges =
          (taskId && selectedItem.taskId !== taskId) ||
          (editorHelp !== undefined && JSON.stringify(selectedItem.help) !== JSON.stringify(editorHelp));
        const persistedUpstream = Array.isArray(selectedItem.upstreamLangs) ? selectedItem.upstreamLangs : [];
        const upstreamChanged = JSON.stringify(persistedUpstream) !== JSON.stringify(upstreamLangs);
        if (hasChanges || upstreamChanged) {
          const signature = JSON.stringify([taskId || selectedItem.taskId, editorHelp, upstreamLangs]);
          if (lastSentSaveRef.current?.itemId === selectedItemId && lastSentSaveRef.current.signature === signature) {
            editorDirtyRef.current = false;
            return;
          }
          lastSentSaveRef.current = { itemId: selectedItemId, signature };
          // Clear before the async save so edits made during the save re-mark
          // dirty and trigger a follow-up persist. The local edit is being
          // saved (last-write-wins), so any pending remote-update prompt is moot.
          editorDirtyRef.current = false;
          setRemoteUpdateAvailable(false);
          // Consume the provenance: it describes THIS taskId change, so a later
          // metadata-only save must not inherit it.
          const versionSource = versionSourceRef.current;
          const versionLabel = versionLabelRef.current;
          versionSourceRef.current = undefined;
          versionLabelRef.current = undefined;
          handleUpdateItem({
            itemId: selectedItemId,
            name: selectedItem.name,
            taskId: taskId || selectedItem.taskId,
            mark: selectedItem.mark,
            help: JSON.stringify(editorHelp),
            isPublic: selectedItem.isPublic,
            upstreamLangs,
            source: versionSource,
            label: versionLabel,
          });
        }
      } else {
        // Selected item doesn't exist in current items - clear it
        setSelectedItemId(null);
      }
    }
  }, [taskId, editorHelp, selectedItemId, user?.uid, upstreamLangs]);

  // Live-sync the open item: when a poll reveals that another client (e.g. the
  // MCP server) advanced the selected item's task, adopt it if the editor is
  // clean, or surface a non-destructive reload prompt if it's dirty.
  // Freshness is gated on `updated` (which updateItem bumps on every taskId
  // change) so a stale poll arriving after our own save can't revert it.
  useEffect(() => {
    if (!selectedItemId || !user?.uid) return;
    const serverItem =
      (Array.isArray(loadedItems) && loadedItems.find((i: any) => i.id === selectedItemId)) ||
      (directItem && (directItem as any).id === selectedItemId ? directItem : null);
    if (!serverItem) return;
    const serverUpdated = Number((serverItem as any).updated) || 0;
    if (serverUpdated <= baselineUpdatedRef.current) return; // not newer (incl. stale polls)
    if ((serverItem as any).taskId === taskId) {
      // Already in sync (e.g. our own optimistic state) — just advance baseline.
      baselineTaskIdRef.current = (serverItem as any).taskId;
      baselineUpdatedRef.current = serverUpdated;
      return;
    }
    if (editorDirtyRef.current) {
      // Local unsaved edits — don't overwrite; let the user choose to reload.
      setRemoteUpdateAvailable(true);
      return;
    }
    // Clean editor — adopt the remote version silently.
    const si: any = serverItem;
    setTaskId(si.taskId);
    setEditorHelp(typeof si.help === "string" ? JSON.parse(si.help || "[]") : (si.help || []));
    setUpstreamLangs(Array.isArray(si.upstreamLangs) ? si.upstreamLangs : []);
    loadItemSource(si.id, si.taskId);
    baselineTaskIdRef.current = si.taskId;
    baselineUpdatedRef.current = serverUpdated;
  }, [loadedItems, directItem, selectedItemId, taskId, user?.uid, loadItemSource]);

  // Adopt the freshest server version of the open item (used by the reload
  // prompt and when the user accepts a remote update).
  const reloadOpenItem = useCallback(() => {
    const serverItem: any =
      (Array.isArray(loadedItems) && loadedItems.find((i: any) => i.id === selectedItemId)) ||
      (directItem && (directItem as any).id === selectedItemId ? directItem : null);
    if (!serverItem) return;
    editorDirtyRef.current = false;
    setTaskId(serverItem.taskId);
    setEditorHelp(typeof serverItem.help === "string" ? JSON.parse(serverItem.help || "[]") : (serverItem.help || []));
    setUpstreamLangs(Array.isArray(serverItem.upstreamLangs) ? serverItem.upstreamLangs : []);
    loadItemSource(serverItem.id, serverItem.taskId);
    baselineTaskIdRef.current = serverItem.taskId;
    baselineUpdatedRef.current = Number(serverItem.updated) || 0;
    setRemoteUpdateAvailable(false);
  }, [loadedItems, directItem, selectedItemId, loadItemSource]);

  // Opening another item drops the banner for the previous one.
  useEffect(() => {
    setWriteBanner(prev => (prev && prev.itemId !== selectedItemId ? null : prev));
    setRetryWriteError(null);
  }, [selectedItemId]);

  useEffect(() => {
    const onRun = (e: any) => {
      if (e?.detail?.itemId === selectedItemId) setPreviewRun(n => n + 1);
    };
    window.addEventListener(ITEM_RUN_EVENT, onRun);
    return () => window.removeEventListener(ITEM_RUN_EVENT, onRun);
  }, [selectedItemId]);

  // Compile form data when taskId or formData changes
  useEffect(() => {
    if (!user || !taskId || Object.keys(formData).length === 0) {
      return;
    }

    compile({ user, id: taskId, data: formData, buildLayerCount: upstreamLangs.length }).then(compiledData => {
      // Send to opener window if we have one
      const targetWindow = openerWindowRef.current || window.opener;
      if (targetWindow && editorOrigin.current) {
        const message = {
          type: 'data-updated',
          itemId: selectedItemId,
          data: compiledData
        };
        try {
          targetWindow.postMessage(message, editorOrigin.current);
        } catch (e) {
          console.error('[Gallery] data-updated postMessage failed:', e);
        }
      }
    }).catch(err => {
      console.error('Failed to compile form data:', err);
    });
  }, [taskId, selectedItemId, user, formData, upstreamLangs]);

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

  const bannerItem = writeBanner ? items.find(i => i.id === writeBanner.itemId) : null;
  const bannerWrite = bannerItem?.lastWrite?.taskId === writeBanner?.taskId ? bannerItem?.lastWrite : null;
  const bannerProblem = writeBanner && writeBanner.itemId === selectedItemId ? describeWriteProblem(bannerWrite) : null;
  const bannerRetry = canRetryWrite(bannerProblem, bannerWrite, bannerItem?.connectionId);

  const handleRetryWrite = async () => {
    if (!writeBanner) return;
    const { itemId } = writeBanner;
    setRetryingWrite(true);
    setRetryWriteError(null);
    try {
      const result = await retryItemWrite({ user, id: itemId });
      if (result) {
        setItems(prev => prev.map(item => (item.id === itemId ? { ...item, ...result } : item)));
        mutate(prev => prev?.map(item => (item.id === itemId ? { ...item, ...result } : item)), { revalidate: false });
        if (result.lastWrite?.status === 'ok' && result.lastWrite.taskId === result.taskId) {
          setWriteBanner(null);
          window.dispatchEvent(new CustomEvent(ITEM_RUN_EVENT, { detail: { itemId } }));
        } else if (result.lastWrite?.taskId) {
          setWriteBanner({ itemId, taskId: result.lastWrite.taskId });
        }
      }
    } catch (err) {
      setRetryWriteError(String(err?.response?.errors?.[0]?.message || err?.message || err));
    } finally {
      setRetryingWrite(false);
    }
  };

  const writeBannerView = bannerProblem && (
    <div role="alert" className="flex items-start justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 flex-none">
      <div className="min-w-0 break-words">
        <span className="font-semibold">{bannerProblem.headline}:</span>{' '}
        <span title={bannerWrite?.message || undefined}>{bannerProblem.text}</span>
        {retryWriteError && <div className="mt-1 text-red-700">{retryWriteError}</div>}
        <div className="mt-1 flex items-center gap-2">
          {bannerRetry && (
            <button
              type="button"
              onClick={handleRetryWrite}
              disabled={retryingWrite}
              className="rounded-none border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
            >
              {retryingWrite ? 'Retrying…' : 'Retry'}
            </button>
          )}
          <Link href="/settings" className="underline hover:text-red-900">Connection settings</Link>
        </div>
      </div>
      <button
        type="button"
        title="Dismiss"
        onClick={() => { setWriteBanner(null); setRetryWriteError(null); }}
        className="text-red-400 hover:text-red-600 flex-none"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] w-full">
      {/* System alert banner */}
      {systemAlert && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3 flex items-center justify-between flex-none">
          <span className="text-sm text-red-700">{systemAlert}</span>
          <button
            onClick={() => { dismissedAlertRef.current = systemAlert; setSystemAlert(null); }}
            className="ml-4 text-red-400 hover:text-red-600 flex-none"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      )}
      {/* Main content area */}
      <div className="flex grow w-full overflow-hidden">
        {/* Assets panel */}
        <div
          className={classNames(
            "flex-none border border-gray-200 border-r-0 rounded-none",
            isAssetsPanelCollapsed ? "h-10" : "h-[calc(100vh-90px)]"
          )}
          style={{ width: isAssetsPanelCollapsed ? 40 : assetsPanelWidth }}
        >
          <div className="flex justify-between items-center p-2 border-b border-gray-200">
            <span className={classNames(
              "text-sm font-medium text-gray-700",
              isAssetsPanelCollapsed && "hidden"
            )}>Assets</span>
            <button
              className="text-gray-400 hover:text-gray-500 focus:outline-none"
              title={isAssetsPanelCollapsed ? "Expand assets panel" : "Collapse assets panel"}
              onClick={toggleAssetsPanel}>
              {isAssetsPanelCollapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
              )}
            </button>
          </div>
          <div className={classNames(
            isAssetsPanelCollapsed && "hidden",
            "h-[calc(100%-42px)] overflow-auto"
          )}>
            <ImageGallery />
          </div>
        </div>
        {/* Resize bar for Assets panel */}
        {!isAssetsPanelCollapsed ? (
          <div
            className="flex-none w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize transition-colors relative mx-px"
            onPointerDown={(e) => {
              e.preventDefault();
              let isDragging = false;
              let holdTimeout = null;

              const target = e.currentTarget;
              target.setPointerCapture(e.pointerId);

              const startX = e.clientX;
              const startWidth = assetsPanelWidth;

              const handlePointerMove = (moveEvent) => {
                if (!isDragging) return;

                const delta = moveEvent.clientX - startX;
                const newWidth = Math.max(120, Math.min(450, startWidth + delta));

                setAssetsPanelWidth(newWidth);

                if (typeof window !== 'undefined') {
                  localStorage.setItem('graffiticode:assetsPanelWidth', newWidth.toString());
                }
              };

              const handlePointerUp = () => {
                if (holdTimeout) {
                  clearTimeout(holdTimeout);
                  holdTimeout = null;
                }
                isDragging = false;
                target.releasePointerCapture(e.pointerId);
                target.removeEventListener('pointermove', handlePointerMove);
                target.removeEventListener('pointerup', handlePointerUp);
                target.removeEventListener('pointercancel', handlePointerUp);
              };

              target.addEventListener('pointermove', handlePointerMove);
              target.addEventListener('pointerup', handlePointerUp);
              target.addEventListener('pointercancel', handlePointerUp);

              holdTimeout = setTimeout(() => {
                isDragging = true;
              }, 200);
            }}
            title="Drag to resize horizontally"
          >
            <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
              <div className="h-16 w-1 bg-gray-400 rounded-full opacity-50"></div>
            </div>
          </div>
        ) : (
          <div className="flex-none w-1 mx-px" />
        )}
        {/* ItemsNav panel with collapse functionality */}
        {!hideItemsNav && (
        <>
        <div
          className={classNames(
            "flex-none border border-gray-200 border-r-0 rounded-none",
            isItemsPanelCollapsed ? "h-10" : "h-[calc(100vh-90px)]"
          )}
          style={{ width: isItemsPanelCollapsed ? 40 : itemsPanelWidth }}
        >
          <div className="flex justify-between items-center p-2 border-b border-gray-200">
            <div className={classNames(
              "flex items-center gap-2",
              isItemsPanelCollapsed && "hidden"
            )}>
              <span className="text-sm font-medium text-gray-700">Items</span>
              {setMark && setClient && setSort && setDateFilter && (
                <ItemsHeaderMenu
                  mark={mark}
                  setMark={setMark}
                  client={clientOption}
                  setClient={setClient}
                  clientList={clientList}
                  sort={sort}
                  setSort={setSort}
                  dateFilter={dateFilter}
                  setDateFilter={setDateFilter}
                />
              )}
            </div>
            <button
              className="text-gray-400 hover:text-gray-500 focus:outline-none"
              title={isItemsPanelCollapsed ? "Expand items panel" : "Collapse items panel"}
              onClick={toggleItemsPanel}>
              {isItemsPanelCollapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
              )}
            </button>
          </div>
          {!isItemsPanelCollapsed && (
            <div className="mt-2">
              <button
                onClick={handleCreateItem}
                disabled={isCreatingItem}
                className="flex items-center justify-start w-full py-1 px-3 hover:bg-green-50 disabled:opacity-50 transition-colors leading-6"
                title="Create new item"
              >
                <PlusIcon className="h-4 w-4 text-gray-600" />
              </button>
            </div>
          )}
          {!isItemsPanelCollapsed && (
            <div className="h-[calc(100%-84px)] overflow-auto">
              {isLoadingItems && items.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900"></div>
                </div>
              ) : (
                <ItemsNav
                  ref={itemsNavRef}
                  items={items}
                  selectedItemId={selectedItemId}
                  onSelectItem={handleSelectItem}
                  onUpdateItem={handleUpdateItem}
                  onRefresh={() => mutate()}
                  panelWidth={itemsPanelWidth}
                />
              )}
            </div>
          )}
        </div>
        {/* Resize bar for Items panel */}
        {!isItemsPanelCollapsed ? (
          <div
            className="flex-none w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize transition-colors relative mx-px"
            onPointerDown={(e) => {
              e.preventDefault();
              let isDragging = false;
              let holdTimeout = null;

              const target = e.currentTarget;
              target.setPointerCapture(e.pointerId);

              const startX = e.clientX;
              const startWidth = itemsPanelWidth;

              const handlePointerMove = (moveEvent) => {
                if (!isDragging) return;

                const delta = moveEvent.clientX - startX;
                const newWidth = Math.max(120, Math.min(400, startWidth + delta));

                setItemsPanelWidth(newWidth);

                if (typeof window !== 'undefined') {
                  localStorage.setItem('graffiticode:itemsPanelWidth', newWidth.toString());
                }
              };

              const handlePointerUp = () => {
                if (holdTimeout) {
                  clearTimeout(holdTimeout);
                  holdTimeout = null;
                }
                isDragging = false;
                target.releasePointerCapture(e.pointerId);
                target.removeEventListener('pointermove', handlePointerMove);
                target.removeEventListener('pointerup', handlePointerUp);
                target.removeEventListener('pointercancel', handlePointerUp);
              };

              target.addEventListener('pointermove', handlePointerMove);
              target.addEventListener('pointerup', handlePointerUp);
              target.addEventListener('pointercancel', handlePointerUp);

              holdTimeout = setTimeout(() => {
                isDragging = true;
              }, 200);
            }}
            title="Drag to resize horizontally"
          >
            <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
              <div className="h-16 w-1 bg-gray-400 rounded-full opacity-50"></div>
            </div>
          </div>
        ) : (
          <div className="flex-none w-1 mx-px" />
        )}
        </>
        )}
        <div className="flex flex-col grow overflow-hidden">
          <div
               ref={containerRef}
               className={classNames(
               hideEditor ? "block" : "flex flex-col lg:flex-row",
               "gap-4 lg:gap-0",
               "w-full",
               "h-[calc(100vh-90px)]",
               "overflow-hidden"
               )}>
            <div
              ref={editorPanelRef}
              className={classNames(
                "relative ring-0 border border-gray-200 lg:border-r-0 rounded-none",
                "order-2 lg:order-1",
                isEditorPanelCollapsed ? "h-10" : "lg:h-full",
                !isEditorPanelCollapsed && "lg:min-h-[300px]",
                !isEditorPanelCollapsed && !isFormPanelCollapsed && "overflow-auto"
              )}
              style={{
                width: isEditorPanelCollapsed ? '40px' :
                       isFormPanelCollapsed ? 'calc(100% - 16px)' :
                       window.innerWidth >= 1024 ? `${editorPanelWidth}%` : '100%',
                height: isEditorPanelCollapsed ? '40px' :
                        window.innerWidth < 1024 && isFormPanelCollapsed ? 'calc(100% - 56px)' :
                        window.innerWidth < 1024 && !isFormPanelCollapsed ? `calc(${100 - previewPanelHeight}% - 16px)` : undefined,
                minHeight: !isEditorPanelCollapsed && window.innerWidth < 1024 && !isFormPanelCollapsed ? '100px' : undefined,
                minWidth: !isEditorPanelCollapsed && !isFormPanelCollapsed && window.innerWidth >= 1024 ? '200px' : undefined,
                maxWidth: !isEditorPanelCollapsed && !isFormPanelCollapsed && window.innerWidth >= 1024 ?
                  `calc(80% - ${!hideItemsNav ? (isItemsPanelCollapsed ? 25 : 110) : 0}px)` : undefined
              }}
            >
              <div className="flex justify-between items-center p-2 border-b border-gray-200">
                <span className={classNames(
                  "text-sm font-medium text-gray-700",
                  isEditorPanelCollapsed && "hidden"
                )}>Editor</span>
                <button
                  className="text-gray-400 hover:text-gray-500 focus:outline-none"
                  title={isEditorPanelCollapsed ? "Expand editor panel" : "Collapse editor panel"}
                  onClick={toggleEditorPanel}>
                  {isEditorPanelCollapsed ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                    </svg>
                  )}
                </button>
              </div>
              {isFormPanelCollapsed && !isEditorPanelCollapsed && writeBannerView}
              {remoteUpdateAvailable && !isEditorPanelCollapsed && (
                <div className="flex items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
                  <span>This item was updated elsewhere.</span>
                  <button
                    type="button"
                    onClick={reloadOpenItem}
                    className="rounded-none border border-amber-400 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    Reload
                  </button>
                </div>
              )}
              <div
                ref={editorRef}
                className={classNames(
                  isEditorPanelCollapsed && "hidden",
                  "overflow-hidden"
                )}
                style={{ height: 'calc(100% - 42px)' }}
              >
              {items.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-400 select-none">
                  No item selected
                </div>
              ) : (
              <Editor
                accessToken={accessToken}
                taskId={taskId}
                lang={lang}
                mark={mark}
                setTaskId={setTaskIdWithSource}
                setUpstreamLangs={handleEditorUpstreamChange}
                onLoadTaskFromHelp={handleLoadTaskFromHelp}
                height="100%"
                onCodeChange={handleEditorCodeChange}
                onHelpChange={handleEditorHelpChange}
                onCompileError={() => {}}
                onError={(msg) => { dismissedAlertRef.current = null; setSystemAlert(msg); }}
                initialCode={editorCode}
                initialHelp={editorHelp}
                itemId={selectedItemId}
                itemVersions={itemVersions}
              />
              )}
              </div>
            </div>
            {/* Vertical resize bar between editor and preview (desktop) */}
            {!isEditorPanelCollapsed && !isFormPanelCollapsed && (
              <div
                className="hidden lg:block w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize transition-colors relative lg:order-2 mx-px"
                onPointerDown={(e) => {
                e.preventDefault();
                let isDragging = false;
                let holdTimeout = null;

                // Capture the pointer to ensure we get all events
                const target = e.currentTarget;
                target.setPointerCapture(e.pointerId);

                const handlePointerMove = (moveEvent) => {
                  // Only act after hold timeout
                if (!isDragging || !containerRef.current) return;

                  const rect = containerRef.current.getBoundingClientRect();
                  const x = moveEvent.clientX - rect.left;
                const containerWidth = rect.width;

                // Calculate new width percentage for editor
                const minEditorWidth = 200;
                const minPreviewWidth = 200;
                const maxEditorX = containerWidth - minPreviewWidth;

                const newEditorX = Math.max(minEditorWidth, Math.min(maxEditorX, x));
                const editorWidthPercent = Math.min(80, Math.max(20, (newEditorX / containerWidth) * 100));

                setEditorPanelWidth(editorWidthPercent);

                if (typeof window !== 'undefined') {
                  localStorage.setItem('graffiticode:editorPanelWidth', editorWidthPercent.toString());
                }
                };

                const handlePointerUp = () => {
                if (holdTimeout) {
                    clearTimeout(holdTimeout);
                    holdTimeout = null;
                  }
                isDragging = false;
                target.releasePointerCapture(e.pointerId);
                target.removeEventListener('pointermove', handlePointerMove);
                target.removeEventListener('pointerup', handlePointerUp);
                target.removeEventListener('pointercancel', handlePointerUp);
                };

                // Attach listeners to the target element
                target.addEventListener('pointermove', handlePointerMove);
                target.addEventListener('pointerup', handlePointerUp);
                target.addEventListener('pointercancel', handlePointerUp);

                // Start drag after holding for 200ms
                  holdTimeout = setTimeout(() => {
                    isDragging = true;
                  }, 200);
                }}
                title="Drag to resize horizontally"
              >
                <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                  <div className="h-16 w-1 bg-gray-400 rounded-full opacity-50"></div>
                </div>
              </div>
            )}
            {/* Spacer to maintain gap when drag bar is hidden */}
            {(isEditorPanelCollapsed || isFormPanelCollapsed) && (
              <div className="hidden lg:block w-1 lg:order-2 mx-px" />
            )}
            <div
              ref={previewPanelRef}
              className={classNames(
                "relative ring-0 border border-gray-300 lg:border-l-0 rounded-none",
                "order-1 lg:order-5",
                isFormPanelCollapsed ? "h-10" : "lg:h-full",
                !isFormPanelCollapsed && "lg:min-h-[200px]",
                !isFormPanelCollapsed && "overflow-hidden",
                !isFormPanelCollapsed && !isEditorPanelCollapsed && "lg:resize-none",
                "flex flex-col"
              )}
              style={{
                width: isFormPanelCollapsed ? '40px' :
                       isEditorPanelCollapsed ? 'calc(100% - 56px)' :
                       window.innerWidth >= 1024 ? `calc(${100 - editorPanelWidth}% - 16px)` : '100%',
                height: isFormPanelCollapsed ? '40px' :
                        window.innerWidth < 1024 && isEditorPanelCollapsed ? 'calc(100% - 56px)' :
                        window.innerWidth < 1024 && !isEditorPanelCollapsed ? `${previewPanelHeight}%` : undefined,
                minWidth: !isFormPanelCollapsed && window.innerWidth >= 1024 ? '200px' : undefined,
                maxWidth: !isFormPanelCollapsed && window.innerWidth >= 1024 ?
                  `calc(100vw - ${!hideItemsNav ? (isItemsPanelCollapsed ? 50 : 220) : 0}px - 280px)` : undefined,
                minHeight: !isFormPanelCollapsed && window.innerWidth < 1024 && !isEditorPanelCollapsed ? '100px' : undefined,
                maxHeight: !isFormPanelCollapsed && window.innerWidth < 1024 && !isEditorPanelCollapsed ? 'calc(100% - 116px)' : undefined
              }}
            >
              <div className="flex justify-between items-center p-2 border-b border-gray-200">
                <span className={classNames(
                  "text-sm font-medium text-gray-700",
                  isFormPanelCollapsed && "hidden"
                )}>Form view</span>
                <button
                  className="text-gray-400 hover:text-gray-500 focus:outline-none"
                  title={isFormPanelCollapsed ? "Expand form view panel" : "Collapse form view panel"}
                  onClick={toggleFormPanel}>
                  {isFormPanelCollapsed ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                    </svg>
                  )}
                </button>
              </div>
              {!isFormPanelCollapsed && writeBannerView}
              <div className={classNames(
                isFormPanelCollapsed && "hidden",
                writeBannerView ? "min-h-0" : "h-[calc(100%-42px)]",
                "overflow-auto",
                "flex-1"
              )}>
              {items.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-400 select-none">
                  No item selected
                </div>
              ) : (
              <FormView
                key={`form-${previewRun}`}
                id={taskId}
                lang={lang}
                connectionId={viewConnectionId(items.find(i => i.id === selectedItemId), taskId)}
                height="100%"
                className="h-full w-full p-2"
                setData={setFormData}
                setNewTask={() => {}}
              />
              )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
