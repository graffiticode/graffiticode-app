import { Fragment, useCallback, useState, useEffect, useRef } from 'react'
import useSWR from "swr";
import { Dialog, Transition, Menu } from '@headlessui/react'
import {
  XMarkIcon,
  ChevronDoubleLeftIcon,
} from '@heroicons/react/24/outline'
import { EllipsisVerticalIcon } from '@heroicons/react/16/solid';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import SignIn from "./SignIn";
import CopyableId from "./CopyableId";
import { getAccessToken, loadTaskVersions, loadItemClientTags, getData } from '../utils/swr/fetchers';
import useGraffiticodeAuth from "@graffiticode/auth-react";
import TasksHeaderMenu, {
  TasksDateFilter,
  TasksLangFilter,
  DEFAULT_TASKS_DATE_FILTER,
  DEFAULT_TASKS_LANG_FILTER,
  DEFAULT_TASKS_ITEM_FILTER,
  matchesLangPattern,
  matchesItemFilter,
  isFullItemId,
} from './tasks-header-menu';
import { ClientOption, ALL_CLIENT, clientOptionForId, findClientById } from './client-selector';
import FormView from "./FormView";
import { DataPanel } from "./DataPanel";
import { ReadOnlyCodePanel } from "./ReadOnlyCodePanel";
import { CompilerTabs } from "./CompilerTabs";
import { useRouter } from 'next/router';
import { elideCompoundId } from '../utils';




function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

function formatTimestamp(ts) {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toLocaleString();
  } catch {
    return null;
  }
}

function TaskMenu({ task, isOpen, onOpen, onClose, onFilterByItem }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: -9999, left: -9999 });
  const itemIds: string[] = Array.isArray(task.itemIds) ? task.itemIds : [];

  const positionMenu = () => {
    if (buttonRef.current && menuRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 280;
      const menuHeight = menuRef.current.offsetHeight;

      const rightSpace = window.innerWidth - buttonRect.right;
      const leftSpace = buttonRect.left;

      let top = buttonRect.top;
      let left;

      if (top + menuHeight > window.innerHeight) {
        top = Math.max(window.innerHeight - menuHeight - 10, 10);
      }

      if (rightSpace >= menuWidth + 8) {
        left = buttonRect.right + 8;
      } else if (leftSpace >= menuWidth + 8) {
        left = buttonRect.left - menuWidth - 8;
      } else {
        left = Math.max(10, window.innerWidth / 2 - menuWidth / 2);
      }

      setMenuPosition({ top, left });
    }
  };

  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) {
      onClose();
    } else {
      onOpen();
      setTimeout(() => {
        positionMenu();
        setTimeout(positionMenu, 50);
      }, 0);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition({ top: -9999, left: -9999 });
      return;
    }
    setTimeout(() => {
      positionMenu();
      setTimeout(positionMenu, 50);
    }, 0);
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [isOpen]);

  const created = formatTimestamp(task.timestamp);
  // The version record carries the whole chain — no per-task lang fetch needed.
  const langDisplay = Array.isArray(task.langs) && task.langs.length
    ? task.langs.join('+')
    : (task.lang || '—');

  return (
    <div className="relative" style={{ display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="flex items-center mt-1 text-gray-400 hover:text-gray-600"
        onClick={handleClick}
        aria-label="Open menu"
      >
        <EllipsisVerticalIcon className="h-4" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => onClose()}
        >
          <div
            ref={menuRef}
            className="fixed bg-white shadow-lg ring-1 ring-gray-200 z-50 rounded-none"
            onClick={e => e.stopPropagation()}
            style={{
              width: '280px',
              top: `${menuPosition.top}px`,
              left: `${menuPosition.left}px`,
              maxHeight: 'calc(100vh - 40px)',
              overflow: 'auto'
            }}
          >
            <div className="p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">Task Attributes</div>

              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Task ID</label>
                <CopyableId value={task.id} display={elideCompoundId(task.id)} title="Click to copy full task id" />
              </div>

              {itemIds.length > 0 && (
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    {itemIds.length > 1 ? `Item IDs (${itemIds.length})` : 'Item ID'}
                  </label>
                  {itemIds.map((id) => (
                    <CopyableId key={id} value={id} title="Click to copy item id" />
                  ))}
                </div>
              )}

              <div className="mb-1">
                {created && (
                  <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                    <span className="font-semibold w-16 flex-shrink-0">Created</span>
                    <span className="font-mono whitespace-nowrap">{created}</span>
                  </div>
                )}
                <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                  <span className="font-semibold w-16 flex-shrink-0">Lang</span>
                  <span className="font-mono">{langDisplay}</span>
                </div>
                {task.label && (
                  <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                    <span className="font-semibold w-16 flex-shrink-0">Change</span>
                    <span className="text-gray-700 break-words">{task.label}</span>
                  </div>
                )}
              </div>

              <div className="mt-4 border-t pt-4">
                {itemIds.length === 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onFilterByItem(itemIds[0]);
                      onClose();
                    }}
                    className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none"
                    title="Show only this item's versions"
                  >
                    <AdjustmentsHorizontalIcon className="h-4 w-4 mr-2" />
                    <span>Filter by this item</span>
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const base = process.env.NEXT_PUBLIC_FORM_APP_URL || "https://app.graffiticode.org";
                    const w = window.open(`${base}/form/${encodeURIComponent(task.id)}`, '_blank');
                    if (w) w.focus();
                    onClose();
                  }}
                  className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none"
                  title="Open this task in the form view in a new tab"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 mr-2" />
                  <span>Open in form view</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TasksGallery({ lang, initialTaskId = null }: { lang: any; initialTaskId?: string | null }) {
  const router = useRouter();
  const isTaskDetailRoute = router.pathname === '/tasks/[id]';
  const [ hideEditor, setHideEditor ] = useState(false);
  const [ formHeight, setFormHeight ] = useState(350);
  const [ dataHeight, setDataHeight ] = useState(350);
  const [ selectedTaskId, setSelectedTaskId ] = useState("");
  const [ isTasksPanelCollapsed, setIsTasksPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:compiles:tasksPanelCollapsed') === 'true'
  );
  const [ isDataPanelCollapsed, setIsDataPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:compiles:dataPanelCollapsed') === 'true'
  );
  const [ isFormPanelCollapsed, setIsFormPanelCollapsed ] = useState(
    typeof window !== 'undefined' && localStorage.getItem('graffiticode:compiles:formPanelCollapsed') === 'true'
  );
  const [ dataPanelWidth, setDataPanelWidth ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:compiles:dataPanelWidth') : null;
    return saved ? parseFloat(saved) : 400;
  }); // Pixel width for data panel
  const [ previewPanelHeight, setPreviewPanelHeight ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:compiles:previewPanelHeight') : null;
    return saved ? parseFloat(saved) : 50;
  }); // Percentage height for mobile
  const [ tab, setTab ] = useState("Code"); // State for the active tab
  const [ currentCode, setCurrentCode ] = useState("");
  const [ currentData, setCurrentData ] = useState({});
  const { user } = useGraffiticodeAuth();
  const { data: accessToken } = useSWR(
    user && { user } || null,
    getAccessToken,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<any>(null);
  const dataPanelRef = useRef<HTMLDivElement>(null);
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const [ taskIds, setTaskIds ] = useState([]);
  const [ showId, setShowId ] = useState("");
  const [ openMenuId, setOpenMenuId ] = useState<string | null>(null);
  const [ tasksPanelWidth, setTasksPanelWidth ] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:compiles:tasksPanelWidth') : null;
    return saved ? parseInt(saved) : 210;
  });
  const [ dateFilter, setDateFilter ] = useState<TasksDateFilter>(() => {
    if (typeof window === 'undefined') return DEFAULT_TASKS_DATE_FILTER;
    try {
      const saved = localStorage.getItem('graffiticode:compiles:dateFilter');
      if (!saved) return DEFAULT_TASKS_DATE_FILTER;
      const parsed = JSON.parse(saved);
      const from = typeof parsed?.from === 'number' && Number.isFinite(parsed.from) ? parsed.from : null;
      const to = typeof parsed?.to === 'number' && Number.isFinite(parsed.to) ? parsed.to : null;
      return { from, to };
    } catch {
      return DEFAULT_TASKS_DATE_FILTER;
    }
  });
  const [ langFilter, setLangFilter ] = useState<TasksLangFilter>(() => {
    if (typeof window === 'undefined') return DEFAULT_TASKS_LANG_FILTER;
    const saved = localStorage.getItem('graffiticode:compiles:langFilter');
    return saved ? { sequence: saved } : DEFAULT_TASKS_LANG_FILTER;
  });
  const [ itemFilter, setItemFilter ] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_TASKS_ITEM_FILTER;
    return localStorage.getItem('graffiticode:tasks:itemFilter') || DEFAULT_TASKS_ITEM_FILTER;
  });
  const [ clientOption, setClientOption ] = useState<ClientOption>(() => {
    if (typeof window === 'undefined') return ALL_CLIENT;
    const saved = localStorage.getItem('graffiticode:tasks:client');
    return (saved && findClientById(saved)) || ALL_CLIENT;
  });
  const taskItemsRef = useRef({});
  const tasksListRef = useRef(null);
  const tasksUlRef = useRef<HTMLUListElement>(null);

  // Load the version history for this language. Only a full item id is pushed
  // down to the query — a shorter one is treated as a prefix and matched below.
  const serverItemId = isFullItemId(itemFilter) ? itemFilter.trim() : undefined;
  const { data: versionsData, isLoading: isLoadingTasks } = useSWR(
    user && lang ? `task-versions-${user.uid}-${lang}-${clientOption.id}-${serverItemId || ''}` : null,
    () => loadTaskVersions({ user, lang, client: clientOption.id, itemId: serverItemId }),
    {
      // Poll so versions created by other clients (e.g. the MCP server) surface here.
      refreshInterval: 8000,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  );

  // Distinct client tags for this user+lang, to populate the menu's Client filter.
  const { data: clientTags } = useSWR(
    user && lang ? `itemClientTags-${user.uid}-${lang}` : null,
    () => loadItemClientTags({ user, lang }),
    { revalidateOnFocus: true, revalidateOnReconnect: false }
  );

  const clientList = (() => {
    const tags = clientTags || [];
    if (tags.length === 0) {
      const list: ClientOption[] = [ALL_CLIENT];
      if (clientOption.id !== ALL_CLIENT.id) list.push(clientOption);
      return list;
    }
    const list: ClientOption[] = [ALL_CLIENT];
    const seen = new Set<string>([ALL_CLIENT.id]);
    tags.forEach((tag: string) => {
      if (!seen.has(tag)) {
        seen.add(tag);
        list.push(clientOptionForId(tag));
      }
    });
    if (!seen.has(clientOption.id)) list.push(clientOption);
    return list;
  })();

  useEffect(() => {
    // Dedup by taskId: content-addressed tasks are shared when items are copied
    // or share the same content, so the same taskId can arrive under several
    // items. Collapse those into one row and collect the item ids; the newest
    // record supplies the row's timestamp and display fields.
    const byTaskId = new Map<string, any>();
    for (const v of Array.isArray(versionsData) ? versionsData : []) {
      const ts = +v.createdAt || 0;
      const existing = byTaskId.get(v.taskId);
      if (!existing) {
        byTaskId.set(v.taskId, {
          key: v.taskId,
          id: v.taskId,
          itemIds: [v.itemId],
          timestamp: ts,
          lang: v.lang,
          langs: Array.isArray(v.langs) && v.langs.length ? v.langs : [v.lang],
          name: v.name,
          mark: v.mark,
          client: v.client,
          source: v.source,
          label: v.label,
          current: false,
        });
        continue;
      }
      if (!existing.itemIds.includes(v.itemId)) existing.itemIds.push(v.itemId);
      if (ts > existing.timestamp) {
        existing.timestamp = ts;
        existing.name = v.name;
        existing.mark = v.mark;
        existing.client = v.client;
        existing.source = v.source;
        existing.label = v.label;
      }
    }
    // Newest first — the server orders per-item, but dedup interleaves items, so
    // sort the merged rows.
    const uniqueTaskIds = Array.from(byTaskId.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    setTaskIds(uniqueTaskIds);

    // Try to restore the selected task ID from URL query or localStorage
    let taskIdFound = false;
    // Keep nav/localStorage + URL in sync when the resolved task changes (e.g.
    // after a language switch auto-opens a different task), like
    // handleSelectTask does — but without promoting the /tasks index to detail.
    const syncTaskSelection = (taskId) => {
      if (typeof window !== 'undefined') {
        const taskLang = String(lang || '').replace(/^L/i, '').padStart(4, '0') || null;
        localStorage.setItem('graffiticode:selected:taskId', taskId);
        if (taskLang) localStorage.setItem('graffiticode:selected:taskId:lang', taskLang);
        window.dispatchEvent(new CustomEvent('gc:selected-taskId', { detail: { id: taskId, lang: taskLang } }));
      }
      if (isTaskDetailRoute && router.query.id !== taskId) {
        router.replace(`/tasks/${taskId}`, undefined, { shallow: true });
      }
    };
    if (uniqueTaskIds.length > 0) {
      try {
        // URL segment (/tasks/[id]) wins, then ?taskId= query param, then
        // saved cross-section selection from localStorage.
        const queryTaskId = router.query.taskId as string;
        const savedTaskId = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:selected:taskId') : null;

        const taskIdToSelect = initialTaskId || queryTaskId || savedTaskId;

        if (taskIdToSelect) {
          // Find matching task ID (handle both full ID and partial matches)
          const matchingTask = uniqueTaskIds.find(task =>
            task.id === taskIdToSelect || task.id.startsWith(taskIdToSelect)
          );
          if (matchingTask) {
            setSelectedTaskId(matchingTask.id);
            matchingTask.current = true;
            taskIdFound = true;
            syncTaskSelection(matchingTask.id);

            // Scroll the selected task into view in the middle of the viewport
            setTimeout(() => {
              if (taskItemsRef.current[matchingTask.key] && tasksListRef.current) {
                const taskElement = taskItemsRef.current[matchingTask.key];
                const listContainer = tasksListRef.current;

                // Get the container's visible height
                const containerHeight = listContainer.clientHeight;

                // Get the task element's position and height
                const taskTop = taskElement.offsetTop;
                const taskHeight = taskElement.offsetHeight;

                // Calculate scroll position to center the task
                // Task center position - half of container height
                const scrollTop = taskTop + (taskHeight / 2) - (containerHeight / 2);

                // Set the scroll position (constrained to valid range)
                listContainer.scrollTop = Math.max(0, scrollTop);
              }
            }, 100); // Small delay to ensure DOM is updated
          }
        }
      } catch (e) {
        console.error("Error restoring task selection:", e);
      }

      // Set the first task as selected by default if no matching task was found
      if (!taskIdFound && uniqueTaskIds.length > 0) {
        setSelectedTaskId(uniqueTaskIds[0].id);
        uniqueTaskIds[0].current = true;
        syncTaskSelection(uniqueTaskIds[0].id);
      }
    }

    setTaskIds([...uniqueTaskIds]); // Force update with current flags
  }, [versionsData, router.query.taskId, initialTaskId]);

  // Auto-focus the tasks list for arrow key navigation
  useEffect(() => {
    if (taskIds.length > 0 && tasksUlRef.current) {
      tasksUlRef.current.focus();
    }
  }, [taskIds.length > 0]);

  // Persist filter state
  const updateDateFilter = useCallback((next: TasksDateFilter) => {
    setDateFilter(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:compiles:dateFilter', JSON.stringify(next));
    }
  }, []);

  const updateLangFilter = useCallback((next: TasksLangFilter) => {
    setLangFilter(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:compiles:langFilter', next.sequence);
    }
  }, []);

  const updateItemFilter = useCallback((next: string) => {
    setItemFilter(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:tasks:itemFilter', next);
    }
  }, []);

  const updateClient = useCallback((next: ClientOption) => {
    setClientOption(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:tasks:client', next.id);
    }
  }, []);

  // Compute the filtered task list for display + navigation. The lang chain and
  // item id both ride along on the version record — no per-task fetches.
  const langPattern = (langFilter.sequence || '').trim();
  const filteredTaskIds = taskIds.filter((task) => {
    const ts = +task.timestamp || 0;
    if (dateFilter.from !== null && ts < dateFilter.from) return false;
    if (dateFilter.to !== null && ts > dateFilter.to) return false;
    // A full item id was already applied server-side; a prefix filters here.
    // A deduped row can belong to several items — match if any of them does.
    if (!serverItemId && !task.itemIds.some((id: string) => matchesItemFilter(id, itemFilter))) return false;
    if (!langPattern) return true;
    return matchesLangPattern(task.langs, langPattern);
  });

  const toggleTasksPanel = useCallback(() => {
    const newState = !isTasksPanelCollapsed;
    setIsTasksPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:compiles:tasksPanelCollapsed', newState.toString());
    }
  }, [isTasksPanelCollapsed]);

  const toggleDataPanel = useCallback(() => {
    const newState = !isDataPanelCollapsed;
    setIsDataPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:compiles:dataPanelCollapsed', newState.toString());
    }
  }, [isDataPanelCollapsed]);

  const toggleFormPanel = useCallback(() => {
    const newState = !isFormPanelCollapsed;
    setIsFormPanelCollapsed(newState);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graffiticode:compiles:formPanelCollapsed', newState.toString());
    }
  }, [isFormPanelCollapsed]);

  const handleCopy = useCallback(async () => {
    try {
      const content = tab === "Code" ? currentCode : JSON.stringify(currentData, null, 2);
      await navigator.clipboard.writeText(content);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [tab, currentCode, currentData]);

  const handleSelectTask = (taskId) => {
  setSelectedTaskId(taskId);
  // Mark the selected item as current
  taskIds.forEach(task => task.current = false);
  const selectedTask = taskIds.find(task => task.id === taskId);
  if (selectedTask) {
  selectedTask.current = true;
  }
  setTaskIds([...taskIds]);

  if (typeof window !== 'undefined') {
    const taskLang = String(lang || '').replace(/^L/i, '').padStart(4, '0') || null;
    localStorage.setItem('graffiticode:selected:taskId', taskId);
    if (taskLang) localStorage.setItem('graffiticode:selected:taskId:lang', taskLang);
    window.dispatchEvent(new CustomEvent('gc:selected-taskId', { detail: { id: taskId, lang: taskLang } }));
  }

  if (router.pathname === '/tasks' || router.pathname === '/tasks/') {
    router.push(`/tasks/${taskId}`, undefined, { shallow: true });
  } else if (isTaskDetailRoute && router.query.id !== taskId) {
    router.replace(`/tasks/${taskId}`, undefined, { shallow: true });
  }
  };

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

  return (
    <div className="flex h-[calc(100vh-64px)] w-full">
      {/* Main content area */}
      <div className="flex grow w-full overflow-hidden">
        {/* Tasks panel with collapse functionality */}
        <>
        <div className={classNames(
          "flex-none border border-gray-200 rounded-none",
          isTasksPanelCollapsed ? "h-10" : "h-[calc(100vh-90px)]"
        )}
          style={{ width: isTasksPanelCollapsed ? 40 : tasksPanelWidth }}
        >
          <div className="flex justify-between items-center p-2 border-b border-gray-200">
            <div className={classNames(
              "flex items-center gap-2",
              isTasksPanelCollapsed && "hidden"
            )}>
              <span className="text-sm font-medium text-gray-700">Tasks</span>
              <TasksHeaderMenu
                dateFilter={dateFilter}
                setDateFilter={updateDateFilter}
                langFilter={langFilter}
                setLangFilter={updateLangFilter}
                itemFilter={itemFilter}
                setItemFilter={updateItemFilter}
                client={clientOption}
                setClient={updateClient}
                clientList={clientList}
              />
            </div>
            <button
              className="text-gray-400 hover:text-gray-500 focus:outline-none"
              title={isTasksPanelCollapsed ? "Expand tasks panel" : "Collapse tasks panel"}
              onClick={toggleTasksPanel}>
              {isTasksPanelCollapsed ? (
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
          {!isTasksPanelCollapsed && (
            <div className="h-[calc(100%-42px)] overflow-auto" ref={tasksListRef}>
              {isLoadingTasks ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-sm text-gray-500">Loading tasks...</div>
                </div>
              ) : filteredTaskIds.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-sm text-gray-500">
                    {taskIds.length === 0 ? 'No tasks found' : 'No tasks match filters'}
                  </div>
                </div>
              ) : (
                <nav className="flex flex-1 flex-col bg-gray-100 pt-1 pr-2">
                  <ul
                    ref={tasksUlRef}
                    role="list"
                    className="space-y-1 font-mono focus:outline-none"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (filteredTaskIds.length === 0) return;
                        const currentIndex = filteredTaskIds.findIndex(t => t.id === selectedTaskId);
                        const nextIndex = currentIndex < 0
                          ? 0
                          : (currentIndex + (e.key === 'ArrowUp' ? -1 : 1) + filteredTaskIds.length) % filteredTaskIds.length;
                        const nextTask = filteredTaskIds[nextIndex];
                        handleSelectTask(nextTask.id);
                        taskItemsRef.current[nextTask.key]?.scrollIntoView({ block: 'nearest' });
                      }
                    }}
                  >
                    {/* Keyed on the version id, not the taskId: the same task can
                        appear under more than one item. */}
                    {filteredTaskIds.map((task) => (
                      <li key={task.key} ref={el => { taskItemsRef.current[task.key] = el; }}>
                        <div
                          className={classNames(
                            task.current ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                            "flex flex-row justify-between pr-2"
                          )}
                          onMouseOver={() => {
                            if (showId !== task.key) {
                              setShowId(task.key);
                            }
                          }}
                        >
                          <button
                            onClick={() => { handleSelectTask(task.id); tasksUlRef.current?.focus(); }}
                            className="flex items-center rounded-none py-0 pr-2 pl-4 font-bold leading-6 font-mono text-xs text-gray-700 hover:text-gray-900 flex-1 min-w-0 text-left truncate focus:outline-none"
                          >
                            {elideCompoundId(task.id)}
                          </button>
                          {(task.key === showId || openMenuId === task.key) && (
                            <TaskMenu
                              task={task}
                              isOpen={openMenuId === task.key}
                              onOpen={() => setOpenMenuId(task.key)}
                              onClose={() => setOpenMenuId(null)}
                              onFilterByItem={updateItemFilter}
                            />
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
            </div>
          )}
        </div>
        {/* Resize bar for Tasks panel */}
        {!isTasksPanelCollapsed ? (
          <div
            className="flex-none w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize transition-colors relative mx-px"
            onPointerDown={(e) => {
              e.preventDefault();
              let isDragging = false;
              let holdTimeout = null;

              const target = e.currentTarget;
              target.setPointerCapture(e.pointerId);

              const startX = e.clientX;
              const startWidth = tasksPanelWidth;

              const handlePointerMove = (moveEvent) => {
                if (!isDragging) return;

                const delta = moveEvent.clientX - startX;
                const newWidth = Math.max(120, Math.min(400, startWidth + delta));

                setTasksPanelWidth(newWidth);

                if (typeof window !== 'undefined') {
                  localStorage.setItem('graffiticode:compiles:tasksPanelWidth', newWidth.toString());
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
        <div className="flex flex-col grow">
          <div
               ref={containerRef}
               className={classNames(
               hideEditor ? "block" : "flex flex-col lg:flex-row",
               "gap-4 lg:gap-0",
               "w-full",
               "h-[calc(100vh-90px)]"
               )}>
            <div className="relative flex">
              <div
                ref={dataPanelRef}
                className={classNames(
                  "relative ring-0 border border-gray-200 rounded-none",
                  "order-2 lg:order-1",
                  isDataPanelCollapsed ? "h-10" : "lg:h-full",
                  !isDataPanelCollapsed && "lg:min-h-[300px]",
                  !isDataPanelCollapsed && !isFormPanelCollapsed && "overflow-auto"
                )}
                style={{
                  width: isDataPanelCollapsed
                    ? '40px'
                    : isFormPanelCollapsed
                      ? '100%'
                      : `${dataPanelWidth}px`
                }}
              >
                <div className="flex justify-between items-center p-2 border-b border-gray-200">
                  <span className={classNames(
                    "text-sm font-medium text-gray-700",
                    isDataPanelCollapsed && "hidden"
                  )}>Compile</span>
                  <button
                    className="text-gray-400 hover:text-gray-500 focus:outline-none"
                    title={isDataPanelCollapsed ? "Expand data panel" : "Collapse data panel"}
                    onClick={toggleDataPanel}>
                    {isDataPanelCollapsed ? (
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
                  "border-b border-gray-200",
                  isDataPanelCollapsed && "hidden"
                )}>
                  <CompilerTabs tab={tab} setTab={setTab} onCopy={handleCopy} />
                </div>
                <div
                  ref={dataRef}
                  className={classNames(
                    isDataPanelCollapsed && "hidden",
                    "overflow-hidden"
                  )}
                  style={{ height: 'calc(100% - 84px)' }}
                >
                  <div className="h-full overflow-auto">
                    {tab === "Data" ? (
                      <DataPanel
                        id={selectedTaskId}
                        user={user}
                        onDataChange={setCurrentData}
                      />
                    ) : (
                      <ReadOnlyCodePanel
                        id={selectedTaskId}
                        user={user}
                        onCodeChange={setCurrentCode}
                      />
                    )}
                  </div>
                </div>
              </div>
              {/* Vertical resize bar between data and preview panels (desktop) */}
              {!isDataPanelCollapsed && !isFormPanelCollapsed && (
                <div
                  className="hidden lg:block w-1 bg-gray-300 hover:bg-gray-400 cursor-col-resize transition-colors lg:order-2 mx-px relative"
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

                  // Calculate new width in pixels for data panel
                  const minDataWidth = 200;
                  const minPreviewWidth = 200;
                  const maxDataWidth = Math.min(containerWidth - minPreviewWidth, window.innerWidth * 0.7);

                  const newDataWidth = Math.max(minDataWidth, Math.min(maxDataWidth, x));

                  setDataPanelWidth(newDataWidth);

                  if (typeof window !== 'undefined') {
                  localStorage.setItem('graffiticode:compiles:dataPanelWidth', newDataWidth.toString());
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
            </div>
            {/* Spacer to maintain gap when drag bar is hidden */}
            {(isDataPanelCollapsed || isFormPanelCollapsed) && (
              <div className="hidden lg:block w-1 lg:order-2 mx-px" />
            )}
            <div
              ref={previewPanelRef}
              className={classNames(
                "relative ring-0 border border-gray-300 rounded-none",
                "order-1 lg:order-3",
                isFormPanelCollapsed ? "h-10" : "lg:h-full",
                !isFormPanelCollapsed && "lg:min-h-[200px]",
                !isFormPanelCollapsed && "overflow-hidden",
                !isFormPanelCollapsed && !isDataPanelCollapsed && "lg:resize-none",
                "flex flex-col"
              )}
              style={{
                width: isFormPanelCollapsed
                  ? '40px'
                  : isDataPanelCollapsed
                    ? 'calc(100% - 56px)'
                    : `calc(100% - ${Math.min(dataPanelWidth, window.innerWidth - 400) + (isFormPanelCollapsed ? 0 : 4)}px)`,
                maxWidth: !isFormPanelCollapsed ? 'calc(100vw - 280px)' : undefined
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
                isFormPanelCollapsed && "hidden",
                "h-[calc(100%-42px)]",
                "overflow-auto",
                "flex-1"
              )}>
                <FormView
                  key="form"
                  id={selectedTaskId}
                  lang={lang}
                  height="100%"
                  className="h-full w-full"
                  setData={() => {}}
                  setNewTask={() => {}}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
