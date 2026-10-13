import { useState } from 'react'
import { Switch } from '@headlessui/react'

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function PublicToggle({ isPublic, setIsPublic, title }) {
  return (
    <Switch.Group as="div" className="py-2 flex bg-white items-center">
      <Switch
        title={title}
        checked={isPublic}
        onChange={setIsPublic}
        className={classNames(
          isPublic ? 'bg-red-600' : 'bg-gray-200',
          'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-none border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ring-1 ring-gray-400'
        )}
      >
        <span
          aria-hidden="true"
          className={classNames(
            isPublic ? 'translate-x-5' : 'translate-x-0',
            'pointer-events-none inline-block h-5 w-5 transform rounded-none bg-white shadow ring-0 transition duration-200 ease-in-out'
          )}
        />
      </Switch>
    </Switch.Group>
  )
}
