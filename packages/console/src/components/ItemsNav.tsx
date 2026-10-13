import { Menu, Transition } from '@headlessui/react'
import { Fragment, useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { EllipsisVerticalIcon } from '@heroicons/react/16/solid';
import { PlusIcon, ShareIcon, UserIcon } from '@heroicons/react/20/solid';
import { DocumentDuplicateIcon, ArrowTopRightOnSquareIcon, ArrowPathIcon, PhotoIcon } from '@heroicons/react/24/outline';
import MarkSelector, { marks } from './mark-selector';
import { clientOptionForId } from './client-selector';
import PublicToggle from './public-toggle';
import ItemConnection, { ITEM_RUN_EVENT } from './ItemConnection';
import { isConnectableLang } from '../lib/connectable';
import ShareItemDialog from './ShareItemDialog';
import CopyableId from './CopyableId';
import { createItem, recompileItem } from '../utils/swr/fetchers';
import { elideCompoundId } from '../utils';
import { generateThumbnail } from '../lib/generate-thumbnail';
import { useThumbnailJob } from '../lib/thumbnail-jobs';
import useGraffiticodeAuth from '@graffiticode/auth-react';

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

function EllipsisMenu({ itemId, name, taskId, mark, isPublic, sharedWith = [], lang, help, code, created, updated, client, connectionId = null, publicationId = null, publicationConnectionId = null, publishedTaskId = null, lastWrite = null, onChange, onRefresh, isOpen, onOpen, onClose, onArrowKey }) {
  const { user } = useGraffiticodeAuth();
  const [nameValue, setNameValue] = useState(name);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isRecompiling, setIsRecompiling] = useState(false);
  const [recompileMessage, setRecompileMessage] = useState(null);
  // Snapshot generation is tracked in a shared store keyed by item id, so the spinner survives
  // closing/reopening the menu (and shows on other surfaces) while the ~10s render runs.
  const isSnapping = useThumbnailJob(itemId);
  // The snapshot dialect itself isn't a thumbnail target — hide the action on L0013 items.
  const isSnapLang = String(lang ?? '').replace(/^L/i, '').padStart(4, '0') === '0013';
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const nameInputRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState({ top: -9999, left: -9999 });

  // Position menu next to the button
  const positionMenu = () => {
    if (buttonRef.current && menuRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 280; // Fixed width of menu
      const menuHeight = menuRef.current.offsetHeight;

      // Check if there's enough space to the right
      const rightSpace = window.innerWidth - buttonRect.right;
      const leftSpace = buttonRect.left;

      let top = buttonRect.top;
      let left;

      // If menu would go below viewport bottom, position it above
      if (top + menuHeight > window.innerHeight) {
        top = Math.max(window.innerHeight - menuHeight - 10, 10);
      }

      // Determine horizontal position - prefer right side if there's space
      if (rightSpace >= menuWidth + 8) {
        // Position to the right of the button
        left = buttonRect.right + 8;
      } else if (leftSpace >= menuWidth + 8) {
        // Position to the left of the button
        left = buttonRect.left - menuWidth - 8;
      } else {
        // Not enough space on either side, center it
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
      // Wait for menu to be rendered before positioning
      setTimeout(() => {
        positionMenu();
        // Re-check position after a short delay to account for content rendering
        setTimeout(positionMenu, 50);
      }, 0);
    }
  };

  // Adopt the name from the server (e.g. a poll picked up a rename elsewhere),
  // but never while the user is mid-edit in this field, or their keystrokes
  // would be clobbered.
  useEffect(() => {
    if (document.activeElement !== nameInputRef.current) {
      setNameValue(name);
    }
  }, [name]);

  // Commit the in-progress name edit. Called on blur and before arrow-key
  // navigation, since navigating unmounts this menu before onBlur can fire.
  const commitName = () => {
    const newName = nameValue.trim();
    if (newName && newName !== name) {
      onChange({ itemId, name: newName });
    } else if (!newName) {
      onChange({ itemId, name: "unnamed" });
      setNameValue("unnamed");
    }
  };

  // Handle copying the item
  const handleCopyItem = async (e) => {
    e.stopPropagation();
    if (!user || isCopying) return;

    setIsCopying(true);
    try {
      const newItem = await createItem({
        user,
        lang,
        name: `Copy of ${name}`,
        taskId,
        mark,
        help,
        isPublic: false, // Don't copy public status
        client: 'console'
      });

      if (newItem && newItem.id) {
        // Close the menu
        onClose();
        // Refresh the items list
        onRefresh();
      }
    } catch (error) {
      console.error('Failed to copy item:', error);
    } finally {
      setIsCopying(false);
    }
  };

  // Generate (or refresh) this item's gallery thumbnail via the L0013 snap dialect. Runs in the
  // background (~10s); the shared job store drives the spinner here and on other surfaces.
  const handleGenerateThumbnail = async (e) => {
    e.stopPropagation();
    if (!user || isSnapping) return;
    try {
      await generateThumbnail({ user, itemId });
      onRefresh();
    } catch (error) {
      console.error('Failed to generate thumbnail:', error);
    }
  };

  // Compile the current version again instead of using the cached result. An
  // item that writes through a connection writes again. The preview reloads.
  const handleRecompile = async (e) => {
    e.stopPropagation();
    if (!user || isRecompiling || !taskId) return;
    setIsRecompiling(true);
    setRecompileMessage(null);
    try {
      await recompileItem({ user, id: itemId });
      window.dispatchEvent(new CustomEvent(ITEM_RUN_EVENT, { detail: { itemId } }));
      setRecompileMessage('Recompiled.');
      onRefresh();
    } catch (error) {
      setRecompileMessage(String(error?.response?.errors?.[0]?.message || error?.message || error));
    } finally {
      setIsRecompiling(false);
    }
  };

  // Position menu and focus input when opened
  useEffect(() => {
    if (!isOpen) {
      setMenuPosition({ top: -9999, left: -9999 });
      return;
    }
    if (isOpen) {
      // Position menu after render
      setTimeout(() => {
        positionMenu();
        setTimeout(positionMenu, 50);
      }, 0);
      window.addEventListener('resize', positionMenu);
      // Set focus on the name input field when menu opens and select all text
      setTimeout(() => {
        if (nameInputRef.current) {
          nameInputRef.current.focus();
          nameInputRef.current.select();
        }
      }, 100);
      return () => window.removeEventListener('resize', positionMenu);
    }
  }, [isOpen]);

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
              minHeight: '240px',
              overflow: 'auto'
            }}
          >
            <div className="p-4">
              <div className="text-sm font-semibold text-gray-700 mb-3">Item Attributes</div>

              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Name</label>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="w-full rounded-none border border-gray-300 p-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-500"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      commitName();
                      onArrowKey(e.key === 'ArrowUp' ? -1 : 1);
                    }
                  }}
                  onBlur={commitName}
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Item ID</label>
                <CopyableId value={itemId} title="Click to copy item id" />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Task ID</label>
                {taskId
                  ? <CopyableId value={taskId} display={elideCompoundId(taskId)} title="Click to copy full task id" />
                  : <div className="text-xs font-mono text-gray-400 py-1.5">—</div>}
              </div>

              <div className="mb-4">
                {formatTimestamp(created) && (
                  <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                    <span className="font-semibold w-16 flex-shrink-0">Created</span>
                    <span className="font-mono">{formatTimestamp(created)}</span>
                  </div>
                )}
                {formatTimestamp(updated) && formatTimestamp(updated) !== formatTimestamp(created) && (
                  <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                    <span className="font-semibold w-16 flex-shrink-0">Updated</span>
                    <span className="font-mono">{formatTimestamp(updated)}</span>
                  </div>
                )}
                <div className="flex gap-3 text-xs text-gray-600 py-0.5">
                  <span className="font-semibold w-16 flex-shrink-0">Client</span>
                  <span className="font-mono">{clientOptionForId(client || 'console').name}</span>
                </div>
              </div>

              <div className="flex gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Mark</label>
                  <MarkSelector
                    mark={marks[(mark || 1) - 1]}
                    setMark={newMark => onChange({itemId, mark: newMark.id})}
                    dropUp={true}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Public (Caution)</label>
                  <PublicToggle
                    isPublic={isPublic || false}
                    setIsPublic={isPublic => onChange({itemId, isPublic})}
                    title="This item's task will be visible to anyone with the task ID. This cannot be undone."
                  />
                </div>
              </div>

              {isConnectableLang(lang) && (
                <ItemConnection
                  user={user}
                  itemId={itemId}
                  lang={lang}
                  taskId={taskId}
                  connectionId={connectionId}
                  publicationId={publicationId}
                  publicationConnectionId={publicationConnectionId}
                  publishedTaskId={publishedTaskId}
                  lastWrite={lastWrite}
                  onChanged={onRefresh}
                />
              )}

              <div className="mt-4 border-t pt-4">
                <button
                  onClick={handleCopyItem}
                  disabled={isCopying}
                  className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <DocumentDuplicateIcon className="h-4 w-4 mr-2" />
                  <span>{isCopying ? 'Copying...' : 'Make a copy'}</span>
                </button>
                {!isSnapLang && (
                  <button
                    onClick={handleGenerateThumbnail}
                    disabled={isSnapping}
                    className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none disabled:cursor-not-allowed"
                    title="Generate a gallery thumbnail of this item (runs in the background)"
                  >
                    {isSnapping ? (
                      <span className="h-4 w-4 mr-2 inline-block animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                    ) : (
                      <PhotoIcon className="h-4 w-4 mr-2" />
                    )}
                    <span>{isSnapping ? 'Generating thumbnail…' : 'Generate thumbnail'}</span>
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowShareDialog(true);
                    onClose();
                  }}
                  className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none"
                >
                  <ShareIcon className="h-4 w-4 mr-2" />
                  <span>Share with user</span>
                  {sharedWith.length > 0 && (
                    <span className="ml-auto text-xs text-gray-500">
                      ({sharedWith.length})
                    </span>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const base = process.env.NEXT_PUBLIC_FORM_APP_URL || "https://app.graffiticode.org";
                    const w = window.open(`${base}/form/${itemId}`, '_blank');
                    if (w) w.focus();
                    onClose();
                  }}
                  className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none"
                  title="Open this item in the form view in a new tab"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4 mr-2" />
                  <span>Open in form view</span>
                </button>
                <button
                  onClick={handleRecompile}
                  disabled={isRecompiling || !taskId}
                  className="flex items-center w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 rounded-none disabled:opacity-50 disabled:cursor-not-allowed"
                  title={isConnectableLang(lang) && connectionId
                    ? "Compile this version again instead of using the cached result. It writes through your connection again."
                    : "Compile this version again instead of using the cached result"}
                >
                  <ArrowPathIcon className={classNames('h-4 w-4 mr-2', isRecompiling && 'animate-spin')} />
                  <span>{isRecompiling ? 'Recompiling…' : 'Recompile'}</span>
                </button>
                {recompileMessage && (
                  <div className="px-3 pb-1 text-xs text-gray-600 break-words">{recompileMessage}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <ShareItemDialog
        isOpen={showShareDialog}
        onClose={() => setShowShareDialog(false)}
        itemId={itemId}
        itemName={name}
        sharedWith={sharedWith}
        onShareSuccess={onRefresh}
      />
    </div>
  )
}

const ItemsNav = forwardRef(function ItemsNav({ items, selectedItemId, onSelectItem, onUpdateItem, onRefresh, panelWidth = 210 }: any, ref) {
  const [ showId, setShowId ] = useState("");
  const [ openMenuId, setOpenMenuId ] = useState<string | null>(null);
  const itemRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const listRef = useRef<HTMLUListElement>(null);

  // Focus the list when items load
  useEffect(() => {
    if (items.length > 0 && listRef.current) {
      listRef.current.focus();
    }
  }, [items.length > 0]);

  const navigateItems = (direction: number) => {
    if (!openMenuId) return;
    const currentIndex = items.findIndex(i => i.id === openMenuId);
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < items.length) {
      const nextItem = items[nextIndex];
      setOpenMenuId(nextItem.id);
      setShowId(nextItem.id);
      onSelectItem(nextItem.id);
    }
  };

  useImperativeHandle(ref, () => ({
    get hasOpenMenu() { return !!openMenuId; },
    navigate: navigateItems,
  }));

  return (
    <div className="w-full flex flex-col gap-y-1 bg-gray-100 pt-1 pr-2">
      <nav className="flex flex-1 flex-col">
        {items.length === 0 ? (
          <p className="text-xs text-gray-500 text-left pl-4 py-0 leading-6">No items found</p>
        ) : (
          <ul
            ref={listRef}
            role="list"
            className="space-y-1 font-mono focus:outline-none"
            tabIndex={0}
            onKeyDown={(e) => {
              if (openMenuId) return;
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const currentIndex = items.findIndex(i => i.id === selectedItemId);
                const nextIndex = (currentIndex + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
                const nextItem = items[nextIndex];
                onSelectItem(nextItem.id);
                setShowId(nextItem.id);
                itemRefs.current[nextItem.id]?.scrollIntoView({ block: 'nearest' });
              }
            }}
          >
            {items.map((item) => (
              <li
                key={item.id}
                ref={(el) => { itemRefs.current[item.id] = el; }}
              >
                <div
                  className={classNames(
                    item.id === selectedItemId ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                    'flex flex-row justify-between pr-2'
                  )}
                  onMouseOver={() => {
                    if (showId !== item.id) {
                      setShowId(item.id);
                    }
                  }}
                >
                  <button
                    onClick={() => { onSelectItem(item.id); listRef.current?.focus(); }}
                    className="flex items-center rounded-none py-0 pr-2 pl-4 font-bold leading-6 font-mono text-xs text-gray-700 hover:text-gray-900 truncate text-left focus:outline-none"
                    style={{ maxWidth: panelWidth - 40 }}
                    title={item.name}
                  >
                    <span className="truncate">{item.name}</span>
                    {/* Show icon if item was shared with the user */}
                    {item.sharedFrom && (
                      <UserIcon className="h-3 w-3 ml-1 text-gray-400 flex-shrink-0" title={`From ${item.sharedFrom}`} />
                    )}
                  </button>
                  { item.id === showId &&
                    <EllipsisMenu
                      itemId={item.id}
                      name={item.name}
                      taskId={item.taskId}
                      mark={item.mark}
                      isPublic={item.isPublic}
                      sharedWith={item.sharedWith}
                      lang={item.lang}
                      help={item.help}
                      code={item.code}
                      created={item.created}
                      updated={item.updated}
                      client={item.client}
                      connectionId={item.connectionId}
                      publicationId={item.publicationId}
                      publicationConnectionId={item.publicationConnectionId}
                      publishedTaskId={item.publishedTaskId}
                      lastWrite={item.lastWrite}
                      onChange={onUpdateItem}
                      onRefresh={onRefresh}
                      isOpen={openMenuId === item.id}
                      onOpen={() => setOpenMenuId(item.id)}
                      onClose={() => setOpenMenuId(null)}
                      onArrowKey={navigateItems}
                    /> || <div />
                  }
                </div>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  )
});

export default ItemsNav;
