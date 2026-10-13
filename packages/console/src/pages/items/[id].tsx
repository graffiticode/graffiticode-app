import { useEffect } from 'react';
import { useRouter } from 'next/router';
import Gallery from '../../components/gallery';
import { getPageTitle } from '../../lib/utils';

export default function ItemDetail({ language, setLanguage, mark, setMark, client, setClient, sort, setSort, dateFilter, setDateFilter }) {
  const router = useRouter();
  const rawId = router.query.id;
  const itemId = Array.isArray(rawId) ? rawId[0] : rawId;
  useEffect(() => {
    document.title = getPageTitle();
  }, []);
  const lang = language.name.slice(1);
  return (
    <div className="max-w-full mx-auto py-0 sm:px-6 lg:px-8">
      <Gallery
        lang={lang}
        mark={mark}
        setMark={setMark}
        client={client}
        setClient={setClient}
        sort={sort}
        setSort={setSort}
        dateFilter={dateFilter}
        setDateFilter={setDateFilter}
        itemId={itemId || null}
        setLanguage={setLanguage}
      />
    </div>
  );
}
