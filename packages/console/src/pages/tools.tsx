import { useEffect } from 'react';
import ToolsGallery from '../components/tools-gallery';

export default function Tools({ language, setLanguage }) {

  return (
    <div className="max-w-full mx-auto py-0 sm:px-6 lg:px-8">
      <ToolsGallery language={language} setLanguage={setLanguage} />
    </div>
  );
}
