import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFilesController } from '../src/files-panel/controller.js';

// keep one hook mounted while its public Place scope changes
function FilesLifecycleFixture() {
  const [placeId, setPlaceId] = useState('place-a');
  const [favoriteSettled, setFavoriteSettled] = useState(false);
  const files = useFilesController(placeId, fetch);

  // exercise automatic loading for each selected place
  useEffect(() => { files.show(); }, [files.show]);

  // retain a real mutation callback until its old-place response settles
  const favoriteCurrent = async () => {
    const entry = files.listing?.directoryEntry;
    // the mutation requires a successfully listed directory
    if (entry === undefined) return;
    await files.addFavorite(entry);
    setFavoriteSettled(true);
  };

  return <section aria-label="Files lifecycle">
    <button type="button" onClick={() => setPlaceId('place-b')}>Switch Place</button>
    <button type="button" disabled={files.listing === undefined} onClick={() => void favoriteCurrent()}>Favorite current folder</button>
    <input aria-label="Current path" readOnly value={files.listing?.path ?? ''} />
    <input aria-label="Folder loading" type="checkbox" readOnly checked={files.loading} />
    <ul aria-label="Favorite paths">{files.favorites.map(favorite => <li key={favorite.id}>{favorite.path}</li>)}</ul>
    {files.error !== undefined && <p role="alert">{files.error.code}</p>}
    {favoriteSettled && <p role="status">Favorite request settled</p>}
  </section>;
}

// render the production hook without mocking its ordinary collaborators
export function renderFilesLifecycle(root: HTMLElement) {
  createRoot(root).render(<FilesLifecycleFixture />);
}
