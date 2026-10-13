import useSWR from "swr";
import { Disclosure } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/20/solid'
import { Fragment, useEffect, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { elideTaskId, elideCompoundId } from '../utils';

const sliceName = name => name.slice(17).slice(0,27);

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}



const scrubTitle = title => title.indexOf("|") >= 0 && title.slice(title.indexOf("|") + 1).trim();

const getTitleFromTask = task => scrubTitle(task.src.split("\n").slice(0, 1).join());

const getNestedItems = ({ setId, tasks }) => {
  // Group tasks by root ID
  const taskGroups = new Map();

  tasks.forEach(task => {
    const [rootId, tailId] = task.id.split("+");

    if (!taskGroups.has(rootId)) {
      taskGroups.set(rootId, {
        root: null,
        children: []
      });
    }

    const group = taskGroups.get(rootId);

    if (tailId === undefined) {
      // This is a root task
      group.root = task;
    } else {
      // This is a child task
      group.children.push({
        ...task,
        id: task.id,
        name: elideCompoundId(task.id),
      });
    }
  });

  // Convert to nested items array
  const nestedItems = [];

  taskGroups.forEach((group, rootId) => {
    // Use the root task if it exists, otherwise create a synthetic root
    const rootTask = group.root || {
      id: rootId,
      created: group.children.length > 0 ? Math.max(...group.children.map(c => +c.created || 0)) : 0,
      // Copy other fields from first child if no root exists
      ...(group.children[0] ? {
        lang: group.children[0].lang,
        mark: group.children[0].mark,
        isPublic: group.children[0].isPublic,
      } : {})
    };

    // Sort children by created date descending
    if (group.children.length > 0) {
      group.children.sort((a, b) => {
        const at = +a.created || 0;
        const bt = +b.created || 0;
        return bt - at;
      });
    }

    nestedItems.push({
      ...rootTask,
      id: rootId,
      name: elideTaskId(rootId),
      children: group.children.length > 0 ? group.children : undefined,
      // Use the most recent created date (either from root or most recent child)
      created: group.root ? rootTask.created : (group.children.length > 0 ? group.children[0].created : rootTask.created)
    });
  });

  // Sort nested items by created date descending
  nestedItems.sort((a, b) => {
    const at = +a.created || 0;
    const bt = +b.created || 0;
    return bt - at;
  });

  return nestedItems;
}

export default function TasksNav({ user, setId, tasks, currentId }) {
  const [ items, setItems ] = useState([]);
  useEffect(() => {
    if (tasks.length) {
      const nestedItems = getNestedItems({setId, tasks});

      if (nestedItems.length) {
        // Check if we have a stored taskId that matches or partially matches any of our tasks
        let foundMatch = false;

        // Try to get the selected task ID from localStorage
        const savedTaskId = typeof window !== 'undefined' ? localStorage.getItem('graffiticode:selected:taskId') : null;

        if (savedTaskId) {
        // Get the base task ID (before the '+' if present)
        const [baseTaskId] = savedTaskId.split('+');

        // First, try to find an exact match
        nestedItems.forEach(item => {
          // Initialize all items as not current
          item.current = false;

          // Check for exact match
          if (item.id === savedTaskId || item.id === baseTaskId) {
            item.current = true;
            foundMatch = true;
            setId(item.id);
          }

          // If this item has children, check them too
          if (item.children) {
            item.children.forEach(childItem => {
              // Check if any child matches the saved ID
              const childFullId = item.id + "+" + childItem.id;
              if (childFullId === savedTaskId) {
                item.current = true; // Parent is considered current when child is selected
                foundMatch = true;
                setId(childFullId);
              }
            });
          }
        });

        // If no exact match, try to find a task with the same base ID
        if (!foundMatch) {
          nestedItems.forEach(item => {
            const [itemBaseId] = item.id.split('+');
            if (itemBaseId === baseTaskId) {
              item.current = true;
              foundMatch = true;
              setId(item.id);
            }
          });
        }
      }

      // If no match was found, default to the first item
      if (!foundMatch) {
        nestedItems[0].current = true;
        console.log("HELP_DEBUG [TasksNav] - Setting initial task id:", nestedItems[0].id);
        setId(nestedItems[0].id);
      }

        setItems(nestedItems);
      }
    }
  }, [tasks.length]);


  if (!Array.isArray(tasks) || tasks.length === 0 ||
      !Array.isArray(items) || items.length === 0) {
    return (
      <div className="w-64 flex flex-1 flex-col p-8 text-left place-content-left">
        <h1>No tasks</h1>
      </div>
    );
  }


  return (
    <div
      className="w-[210px] flex-none flex flex-col gap-y-2 overflow-visible bg-white pt-2 max-h-[calc(100vh-110px)] sticky top-[84px] z-40"
    >
      <nav className="flex flex-1 flex-col">
        <ul role="list" className="flex flex-1 flex-col gap-y-7 font-mono">
          <li className="overflow-y-auto pr-1" style={{ maxHeight: 'calc(100vh - 140px)' }}>
            <ul role="list" className="space-y-1">
              {items.map((item) => (
                <li key={item.id}>
                  {!item.children ? (
                    <div
                      className={classNames(
                        item.current ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                        "flex flex-row justify-between pr-2"
                      )}
                    >
                      <button
                        onClick={() => {
                          setId(item.id);
                          items.forEach(item => item.current = false);
                          item.current = true;
                        }}
                        className="block rounded-none py-0 pr-2 pl-10 font-bold leading-6 font-mono text-xs text-gray-700 hover:text-gray-900 truncate max-w-[170px] text-left"
                        title={item.name}
                      >
                        {item.name}
                      </button>
                    </div>
                  ) : (
                    <Disclosure as="div">
                      {({ open }) => (
                        <>
                          <div className={classNames(
                                 item.current ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                                 "flex flex-row justify-between pr-2"
                               )}
                          >
                            <Disclosure.Button
                              onClick={() => {
                                setId(item.id);
                                items.forEach(item => item.current = false);
                                item.current = true;
                              }}
                              className="flex items-center w-full text-xs text-left rounded-none px-2 gap-x-3 leading-6 font-bold text-gray-700"
                              title={item.name}
                            >
                              <ChevronRightIcon
                                className={classNames(
                                  open ? 'rotate-90 text-gray-500' : 'text-gray-400',
                                  'h-5 w-5 shrink-0'
                                )}
                                aria-hidden="true"
                              />
                              <span className="truncate max-w-[130px]">{item.name}</span>
                            </Disclosure.Button>
                          </div>
                          <Disclosure.Panel as="ul" className="mt-1 px-2">
                            {item.children.map((subItem) => (
                              <li key={subItem.id}>
                                <div className={classNames(
                                       item.current ? 'bg-gray-300' : 'bg-gray-100 hover:bg-gray-200',
                                       "flex flex-row justify-between"
                                     )}
                                >
                                  <button
                                    onClick={() => {
                                      setId(subItem.id);
                                      items.forEach(item => item.current = false);
                                      item.children.forEach(subItem => subItem.current = false);
                                      subItem.current = true;
                                    }}
                                    className="font-normal block rounded-none py-0 pr-2 pl-8 text-xs leading-6 text-gray-700 truncate max-w-[150px] text-left"
                                    title={subItem.name}
                                  >
                                    {subItem.name}
                                  </button>
                                </div>
                              </li>
                            ))}
                          </Disclosure.Panel>
                        </>
                      )}
                    </Disclosure>
                  )}
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </nav>
    </div>
  )
}
