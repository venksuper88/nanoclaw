import { useEffect, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TurndownService from 'turndown';
import { marked } from 'marked';
import { api } from '../api';

interface NoteFolder {
  id: string;
  name: string;
  parent_id: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
}

interface Note {
  id: string;
  user_id: string;
  folder_id: string | null;
  title: string;
  content: string;
  tags: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function fmtRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.round(diff / 86400000)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Extract #hashtags from text, return unique tag list */
function extractTags(text: string): string[] {
  const matches = text.match(/(?:^|\s)#(\w+)/g) || [];
  const tags = matches.map(m => m.trim().slice(1));
  return [...new Set(tags)];
}

// Singleton turndown instance for HTML→Markdown
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

/** Convert markdown to HTML for TipTap */
function mdToHtml(md: string): string {
  if (!md) return '';
  return marked.parse(md, { async: false }) as string;
}

/** Convert TipTap HTML back to markdown */
function htmlToMd(html: string): string {
  if (!html) return '';
  return turndown.turndown(html);
}

/** TipTap editor wrapper component */
function NoteEditor({
  initialContent,
  onContentChange,
}: {
  initialContent: string;
  onContentChange: (md: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Start writing... use #tags inline',
      }),
    ],
    content: mdToHtml(initialContent),
    onUpdate: ({ editor }) => {
      onContentChange(htmlToMd(editor.getHTML()));
    },
    editorProps: {
      attributes: {
        class: 'dc-tiptap-editor',
      },
    },
  });

  return <EditorContent editor={editor} />;
}

export function NotesView() {
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [trashNotes, setTrashNotes] = useState<Note[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);

  // Editor state
  const [editorTitle, setEditorTitle] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  // Key to force re-mount of TipTap editor when opening different notes
  const [editorKey, setEditorKey] = useState(0);

  // Toggle body class for full-screen editing (hides tab bar)
  useEffect(() => {
    if (showEditor) {
      document.body.classList.add('notes-editing');
    } else {
      document.body.classList.remove('notes-editing');
    }
    return () => document.body.classList.remove('notes-editing');
  }, [showEditor]);

  const loadFolders = () => {
    api.getNoteFolders()
      .then(r => { if (r.ok) setFolders(r.data); })
      .catch(() => {});
  };

  const loadNotes = (q?: string, folder?: string | null) => {
    setLoading(true);
    const opts: { q?: string; folder?: string } = {};
    if (q) opts.q = q;
    else if (folder) opts.folder = folder;
    api.getNotes(opts.q || opts.folder ? opts : undefined)
      .then(r => { if (r.ok) setNotes(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadFolders();
    loadNotes();
  }, []);

  useEffect(() => {
    if (!search) loadNotes(undefined, activeFolder);
  }, [activeFolder]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (search) loadNotes(search);
      else loadNotes(undefined, activeFolder);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const rootFolders = folders.filter(f => !f.parent_id);
  const childFolders = (parentId: string) => folders.filter(f => f.parent_id === parentId);

  const openNew = () => {
    setEditingNote(null);
    setEditorTitle('');
    setEditorContent('');
    setFolderId(activeFolder);
    setSelectedNote(null);
    setEditorKey(k => k + 1);
    setShowEditor(true);
  };

  const openEdit = (note: Note) => {
    setEditingNote(note);
    setEditorTitle(note.title || '');
    setEditorContent(note.content || '');
    setFolderId(note.folder_id);
    setEditorKey(k => k + 1);
    setShowEditor(true);
  };

  const closeEditor = () => {
    setShowEditor(false);
    setEditingNote(null);
  };

  const handleContentChange = useCallback((md: string) => {
    setEditorContent(md);
  }, []);

  const saveNote = async () => {
    const title = editorTitle.trim();
    if (!title) return;

    const content = editorContent;
    const tags = extractTags(title + '\n' + content);
    const tagsStr = tags.length > 0 ? tags.join(',') : null;

    if (editingNote) {
      await api.updateNote(editingNote.id, {
        title,
        content,
        tags: tagsStr,
        folder_id: folderId,
      });
    } else {
      await api.createNote({
        title,
        content,
        tags: tagsStr || undefined,
        folder_id: folderId || undefined,
      });
    }
    closeEditor();
    setSelectedNote(null);
    loadNotes(search || undefined, activeFolder);
  };

  const removeNote = async (id: string) => {
    await api.deleteNote(id);
    if (selectedNote?.id === id) setSelectedNote(null);
    loadNotes(search || undefined, activeFolder);
  };

  const loadTrash = () => {
    api.getTrashNotes()
      .then(r => { if (r.ok) setTrashNotes(r.data); })
      .catch(() => {});
  };

  const restoreNote = async (id: string) => {
    await api.restoreNote(id);
    loadTrash();
    loadNotes(search || undefined, activeFolder);
  };

  const purgeNote = async (id: string) => {
    await api.purgeNote(id);
    loadTrash();
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    await api.createNoteFolder({ name: newFolderName.trim() });
    setNewFolderName('');
    setShowNewFolder(false);
    loadFolders();
  };

  const removeFolder = async (id: string) => {
    await api.deleteNoteFolder(id);
    if (activeFolder === id) setActiveFolder(null);
    loadFolders();
    loadNotes(undefined, null);
  };

  const openRead = (note: Note) => {
    setSelectedNote(note);
    setShowEditor(false);
  };

  const backToList = () => {
    setSelectedNote(null);
    setShowEditor(false);
  };

  const getFolderName = (id: string | null) => {
    if (!id) return 'Unfiled';
    return folders.find(f => f.id === id)?.name || 'Unknown';
  };

  const copyNoteLink = (noteId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(noteId).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }).catch(() => {
      // Fallback for iOS PWA
      const ta = document.createElement('textarea');
      ta.value = noteId;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  // ── Reading a single note ──
  if (selectedNote && !showEditor) {
    const folderName = getFolderName(selectedNote.folder_id);
    return (
      <div className="dc-view dc-view-read">
        <div className="dc-header">
          <button className="dc-back-btn" onClick={backToList}>
            <span className="mi">arrow_back</span>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="dc-title dc-title-sm">{selectedNote.title}</h2>
            <div className="dc-date-subtitle">
              {folderName} · Updated {fmtRelativeDate(selectedNote.updated_at)}
              {selectedNote.created_by !== 'dashboard' ? ` · by ${selectedNote.created_by}` : ''}
            </div>
          </div>
          <button className="dc-refresh" onClick={(e) => copyNoteLink(selectedNote.id, e)} title="Copy note link">
            <span className="mi">{linkCopied ? 'check' : 'link'}</span>
          </button>
          <button className="dc-refresh" onClick={() => openEdit(selectedNote)}>
            <span className="mi">edit</span>
          </button>
        </div>
        {selectedNote.tags && (
          <div className="dc-tag-row">
            {selectedNote.tags.split(',').map(t => t.trim()).filter(Boolean).map(tag => (
              <span key={tag} className="dc-tag">{tag}</span>
            ))}
          </div>
        )}
        <div className="dc-content-view">
          <div className="dc-rendered" dangerouslySetInnerHTML={{ __html: mdToHtml(selectedNote.content || '*No content*') }} />
        </div>
      </div>
    );
  }

  // ── Full-screen editor (Bear style with TipTap) ──
  if (showEditor) {
    const liveTags = extractTags(editorTitle + '\n' + editorContent);
    return (
      <div className="dc-view dc-editor-fullscreen">
        {/* Minimal toolbar */}
        <div className="dc-editor-toolbar">
          <button className="dc-back-btn" onClick={closeEditor}>
            <span className="mi">close</span>
          </button>
          <select
            className="dc-editor-folder-pick"
            value={folderId || ''}
            onChange={e => setFolderId(e.target.value || null)}
          >
            <option value="">No folder</option>
            {folders.map(f => (
              <option key={f.id} value={f.id}>
                {f.parent_id ? '  ' : ''}{f.name}
              </option>
            ))}
          </select>
          <button
            className="dc-editor-save"
            onClick={saveNote}
            disabled={!editorTitle.trim()}
          >
            Save
          </button>
        </div>

        {/* Title + TipTap content */}
        <div className="dc-editor-seamless">
          <input
            className="dc-editor-heading"
            placeholder="Title"
            value={editorTitle}
            onChange={e => setEditorTitle(e.target.value)}
            autoFocus={!editingNote}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Focus the TipTap editor
                const tiptap = (e.target as HTMLElement).parentElement?.querySelector('.ProseMirror') as HTMLElement;
                if (tiptap) tiptap.focus();
              }
            }}
          />
          <NoteEditor
            key={editorKey}
            initialContent={editorContent}
            onContentChange={handleContentChange}
          />
        </div>

        {/* Live tag preview */}
        {liveTags.length > 0 && (
          <div className="dc-editor-tag-preview">
            {liveTags.map(tag => (
              <span key={tag} className="dc-tag-sm">#{tag}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="dc-view">
      <div className="dc-header">
        <div>
          <h2 className="dc-title">Notes</h2>
          <div className="dc-date-subtitle">
            {activeFolder ? getFolderName(activeFolder) : 'All notes'} · {notes.length} note{notes.length !== 1 ? 's' : ''}
          </div>
        </div>
        <button className="dc-refresh" onClick={() => { loadFolders(); loadNotes(undefined, activeFolder); }}>
          <span className="mi">refresh</span>
        </button>
      </div>

      {/* Search bar */}
      <div className="dc-search-wrap">
        <span className="mi dc-search-icon">search</span>
        <input
          className="dc-search"
          placeholder="Search notes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className="dc-search-clear" onClick={() => setSearch('')}>
            <span className="mi" style={{ fontSize: 18 }}>close</span>
          </button>
        )}
      </div>

      {/* Folder chips */}
      {!search && (
        <div className="dc-folder-chips">
          <button
            className={`dc-folder-chip ${activeFolder === null ? 'active' : ''}`}
            onClick={() => setActiveFolder(null)}
          >
            <span className="mi" style={{ fontSize: 16 }}>folder</span>
            All
          </button>
          {rootFolders.map(f => (
            <div key={f.id} style={{ display: 'contents' }}>
              <button
                className={`dc-folder-chip ${activeFolder === f.id ? 'active' : ''}`}
                onClick={() => setActiveFolder(f.id)}
                style={f.color ? { borderColor: f.color } : undefined}
              >
                <span className="mi" style={{ fontSize: 16 }}>{f.icon || 'folder'}</span>
                {f.name}
              </button>
              {childFolders(f.id).map(cf => (
                <button
                  key={cf.id}
                  className={`dc-folder-chip dc-folder-child ${activeFolder === cf.id ? 'active' : ''}`}
                  onClick={() => setActiveFolder(cf.id)}
                  style={cf.color ? { borderColor: cf.color } : undefined}
                >
                  <span className="mi" style={{ fontSize: 14 }}>{cf.icon || 'folder'}</span>
                  {cf.name}
                </button>
              ))}
            </div>
          ))}
          <button
            className="dc-folder-chip dc-folder-add"
            onClick={() => setShowNewFolder(!showNewFolder)}
          >
            <span className="mi" style={{ fontSize: 16 }}>add</span>
          </button>
          <button
            className={`dc-folder-chip ${showTrash ? 'active' : ''}`}
            onClick={() => { setShowTrash(!showTrash); if (!showTrash) loadTrash(); }}
            style={{ marginLeft: 'auto' }}
          >
            <span className="mi" style={{ fontSize: 16 }}>delete</span>
            Trash
          </button>
        </div>
      )}

      {/* New folder inline form */}
      {showNewFolder && (
        <div className="dc-new-folder-row">
          <input
            className="dc-editor-tags"
            placeholder="Folder name"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createFolder()}
            autoFocus
            style={{ flex: 1 }}
          />
          <button className="dc-mode-btn active" onClick={createFolder} disabled={!newFolderName.trim()}>
            <span className="mi" style={{ fontSize: 18 }}>check</span>
          </button>
          <button className="dc-mode-btn" onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}>
            <span className="mi" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
      )}

      {/* Trash view */}
      {showTrash && (
        <div className="dc-list">
          {trashNotes.length === 0 ? (
            <div className="dc-empty-state">
              <span className="mi dc-empty-icon">delete</span>
              <p className="dc-empty-text">Trash is empty</p>
            </div>
          ) : trashNotes.map(note => (
            <div key={note.id} className="dc-card">
              <div className="dc-card-body">
                <div className="dc-card-title" style={{ opacity: 0.6 }}>{note.title}</div>
                <div className="dc-card-meta">
                  <span>Deleted {fmtRelativeDate(note.deleted_at!)}</span>
                  <span className="dc-tag-sm">{note.created_by}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="dc-mode-btn active" onClick={() => restoreNote(note.id)} title="Restore">
                  <span className="mi" style={{ fontSize: 18 }}>restore_from_trash</span>
                </button>
                <button className="dc-mode-btn" onClick={() => purgeNote(note.id)} title="Delete forever">
                  <span className="mi" style={{ fontSize: 18 }}>delete_forever</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Note list */}
      {!showTrash && (loading && notes.length === 0 ? (
        <div className="dc-empty">Loading...</div>
      ) : notes.length === 0 ? (
        <div className="dc-empty-state">
          <span className="mi dc-empty-icon">description</span>
          <p className="dc-empty-text">{search ? 'No notes match your search' : 'No notes yet'}</p>
        </div>
      ) : (
        <div className="dc-list">
          {notes.map(note => (
            <div key={note.id} className="dc-card" onClick={() => openRead(note)}>
              <div className="dc-card-body">
                <div className="dc-card-title">{note.title}</div>
                <div className="dc-card-preview">
                  {note.content ? note.content.replace(/[#*_`>\-\[\]()]/g, '').slice(0, 100) : 'Empty note'}
                  {note.content && note.content.length > 100 ? '...' : ''}
                </div>
                <div className="dc-card-meta">
                  <span>{fmtRelativeDate(note.updated_at)}</span>
                  {!activeFolder && note.folder_id && (
                    <span className="dc-tag-sm">{getFolderName(note.folder_id)}</span>
                  )}
                  {note.tags && (
                    <span className="dc-card-tags">
                      {note.tags.split(',').slice(0, 3).map(t => t.trim()).filter(Boolean).map(tag => (
                        <span key={tag} className="dc-tag-sm">{tag}</span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              <button className="dc-card-delete" onClick={e => { e.stopPropagation(); removeNote(note.id); }}>
                <span className="mi" style={{ fontSize: 18 }}>delete</span>
              </button>
            </div>
          ))}
        </div>
      ))}

      {/* FAB */}
      {!showTrash && (
        <button className="dc-fab" onClick={openNew}>
          <span className="mi" style={{ fontSize: 28 }}>add</span>
        </button>
      )}
    </div>
  );
}
