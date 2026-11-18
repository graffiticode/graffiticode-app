import { useEffect } from 'react';
import TasksGallery from '../../components/tasks-gallery';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ')
}

export default function Tasks({ language }) {

  const lang = language.name.slice(1);
  return (
    <div className="max-w-full mx-auto py-0 sm:px-6 lg:px-8">
      <TasksGallery lang={lang} />
    </div>
  );
}
