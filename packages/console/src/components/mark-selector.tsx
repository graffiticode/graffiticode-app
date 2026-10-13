import { Fragment, useState } from 'react'
import { Listbox, Transition } from '@headlessui/react'
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/20/solid'

const CLEAR = "#FEFEFE";
const AMBER = "#E7B416";
const RED = "#D75A5A"; //"#CC3232";
const GREEN = "#2DC937";
const BLUE = "#5FCEFF"; //"#45C6FF"; //"#12B6FF"; //"#009ADE";
const PURPLE = "#C98ED0"; //"#C07CC9"; //"#AF58BA";
const GRAY = "#BEC9CF"; //"#A0B1BA";
const BLACK = "#000000"; //"#A0B1BA";

export const marks = [
  { id: 1, color: GREEN },
  { id: 2, color: AMBER },
  { id: 3, color: RED },
  { id: 4, color: BLUE },
  { id: 5, color: BLACK },
];

export default function MarkSelector({ mark, setMark, dropUp = false }) {
  const markColor = mark.color;
  return (
    <Listbox value={mark} onChange={setMark}>
      <div className="relative w-20 bg-white">
        <Listbox.Button className="relative w-full cursor-default rounded-none ring-1 ring-gray-300 py-2 pl-3 focus:outline-none focus-visible:border-gray-500 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-75 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-300 sm:text-sm hover:ring-2">
          <span className="block truncate">
            <svg width="22" height="22" xmlns="http://www.w3.org/2000/svg">
              <rect id="mark" width="100%" height="100%" fill={markColor} />
            </svg>
          </span>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon
              className="h-5 w-5 text-gray-400"
              aria-hidden="true"
            />
          </span>
        </Listbox.Button>
        <Transition
          as={Fragment}
          leave="transition ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Listbox.Options className={`absolute ${dropUp ? 'bottom-full mb-1' : 'mt-1'} max-h-60 w-full overflow-auto rounded-none bg-white py-1 text-base ring-1 ring-black ring-opacity-25 focus:outline-none sm:text-sm z-[1000]`}>
            {marks.map((mark, index) => (
              <Listbox.Option
                key={index}
                className={({ active }) =>
                  `relative cursor-default select-none py-2 pl-3 pr-4 ${active ? 'bg-gray-200 text-gray-900' : 'text-gray-900'
                  }`
                }
                value={mark}
              >
                <span>
                  <svg width="24" height="22" xmlns="http://www.w3.org/2000/svg">
                    <rect id="mark-rect" width="100%" height="100%" fill={mark.color} />
                  </svg>
                </span>
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  )
}
