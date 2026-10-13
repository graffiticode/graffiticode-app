import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { getPageTitle } from '../../lib/utils';
import TasksGallery from '../../components/tasks-gallery';

export default function TaskDetail({ language }) {
  const router = useRouter();
  const rawId = router.query.id;
  const taskId = Array.isArray(rawId) ? rawId[0] : rawId;
  useEffect(() => {
    document.title = getPageTitle();
  }, []);
  const lang = language.name.slice(1);
  return (
    <div className="max-w-full mx-auto py-0 sm:px-6 lg:px-8">
      <TasksGallery lang={lang} initialTaskId={taskId || null} />
    </div>
  );
}
